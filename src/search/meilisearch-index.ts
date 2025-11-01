import { App, Platform, TFile } from "obsidian";
import { Buffer } from "buffer";
import { buildExclusionMatchers, ExclusionMatcher, isExcluded, normalizePath } from "./utils";

const MAX_CONTENT_LENGTH = 200_000;
const DOCUMENT_BATCH_SIZE = 50;
const YIELD_INTERVAL = 25;

function makeDocumentId(rawPath: string): string {
    const normalized = normalizePath(rawPath);
    if (/^[A-Za-z0-9_-]{1,511}$/.test(normalized)) {
        return normalized;
    }
    const encoded = Buffer.from(normalized, "utf8").toString("base64url").replace(/=+$/g, "");
    if (encoded.length === 0) {
        return "0";
    }
    return encoded.length > 511 ? encoded.slice(0, 511) : encoded;
}

interface MeilisearchCredentials {
	host: string;
	apiKey?: string | null;
	notesIndex: string;
	headingsIndex: string;
}

export interface NoteDocument extends Record<string, unknown> {
	id: string;
	path: string;
	basename: string;
	folder: string;
	content: string;
	contentLength: number;
	truncated?: boolean;
	aliases: string[];
	modified: number;
	created: number;
}

export interface HeadingDocument extends Record<string, unknown> {
	id: string;
	path: string;
	basename: string;
	folder: string;
	heading: string;
	slug: string;
	line: number;
	level: number;
	modified: number;
}

export interface SearchHit<T> {
	id: string;
	score: number;
	document: T;
}

interface NotesSearchOptions {
	limit: number;
	topPercent: number;
}

interface HeadingsSearchOptions {
	limit: number;
	activePath?: string | null;
}

interface MeilisearchTask {
	taskUid: number;
	indexUid: string;
	status: "enqueued" | "processing" | "succeeded" | "failed" | "canceled";
	type: string;
	error?: { message?: string } | null;
}

interface MeilisearchTaskStatus extends MeilisearchTask {
	duration?: string;
	enqueuedAt?: string;
	startedAt?: string;
	finishedAt?: string;
}

export interface MeilisearchStatus {
	configured: boolean;
	reachable: boolean;
	lastError?: string;
}

export function createHeadingSlug(raw: string, seen: Map<string, number>): string {
	const base = raw
		.toLowerCase()
		.trim()
		.replace(/[\s/]+/g, "-")
		.replace(/[^\p{Letter}\p{Number}-]/gu, "")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	const candidate = base.length > 0 ? base : "heading";
	const count = seen.get(candidate) ?? 0;
	seen.set(candidate, count + 1);
	return count === 0 ? candidate : `${candidate}-${count}`;
}

export class MeilisearchIndex {
	private readonly app: App;
	private credentials: MeilisearchCredentials | null = null;
	private excludedMatchers: ExclusionMatcher[] = [];
	private lastError: string | undefined;
	private initializing: Promise<void> | null = null;
	private pendingPaths: Set<string> = new Set();
	private refreshTimer: number | null = null;
	private readonly refreshDebounce = 40;
	private debug = false;

	constructor(app: App) {
		this.app = app;
	}

	setDebugMode(enabled: boolean): void {
		this.debug = enabled;
	}

	private async yieldToEventLoop(): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	setCredentials(credentials: MeilisearchCredentials | null): void {
		this.credentials = credentials;
	}

	setExcludedPaths(paths: string[]): void {
		this.excludedMatchers = buildExclusionMatchers(paths);
	}

	get status(): MeilisearchStatus {
		return {
			configured: this.credentials !== null,
			reachable: this.lastError === undefined,
			lastError: this.lastError,
		};
	}

	async initialize(): Promise<void> {
		if (this.initializing) {
			return this.initializing;
		}
		this.initializing = this.ensureIndexes();
		return this.initializing;
	}

	async requestRebuild(): Promise<void> {
		if (!this.credentials || this.lastError) return;
		await this.rebuildAll();
	}

	markDirty(path: string): void {
		const normalized = normalizePath(path);
		this.pendingPaths.add(normalized);
		this.scheduleRefresh();
	}

	removePath(path: string): void {
		const normalized = normalizePath(path);
		if (!this.credentials) return;
		this.pendingPaths.delete(normalized);
		void this.deleteNote(normalized);
	}

	async searchNotes(query: string, options: NotesSearchOptions): Promise<Array<SearchHit<NoteDocument>>> {
		const creds = this.credentials;
		if (!creds) return [];
		if (this.lastError) return [];
		if (!query.trim()) return [];
	try {
		const payload = {
			q: query,
			limit: Math.max(1, options.limit),
			attributesToHighlight: ["content"],
		};
		const response = await this.request(`/indexes/${encodeURIComponent(creds.notesIndex)}/search`, {
			method: "POST",
			body: JSON.stringify(payload),
		});
		const { hits } = (await response.json()) as { hits: Array<Record<string, unknown>> };
		return hits
			.map((hit) => {
				const docId = typeof hit.id === "string" ? hit.id : "";
				const docPath = typeof hit.path === "string" ? hit.path : "";
				const score = typeof hit._rankingScore === "number" ? hit._rankingScore : 0;
				const contentStr = typeof hit.content === "string" ? hit.content : "";
				const contentLength =
					typeof hit.contentLength === "number" ? hit.contentLength : contentStr.length;
				const fallbackId = docId || makeDocumentId(docPath);
				return {
					id: fallbackId,
					score,
					document: {
						id: fallbackId,
						path: docPath,
						basename: typeof hit.basename === "string" ? hit.basename : "",
						folder: typeof hit.folder === "string" ? hit.folder : "",
						content: contentStr,
						contentLength,
						truncated: hit.truncated === true,
						aliases: Array.isArray(hit.aliases) ? hit.aliases.filter((v): v is string => typeof v === "string") : [],
						modified: Number(hit.modified ?? 0),
						created: Number(hit.created ?? 0),
					},
				};
				})
				.filter((entry) => entry.document.path && !isExcluded(entry.document.path, this.excludedMatchers));
		} catch (error) {
			this.recordError(error);
			return [];
		}
	}

	async searchHeadings(query: string, options: HeadingsSearchOptions): Promise<Array<SearchHit<HeadingDocument>>> {
		const creds = this.credentials;
		if (!creds) return [];
		if (this.lastError) return [];
		const trimmed = query.trim();
		if (!trimmed) return [];
		try {
			const payload = {
				q: trimmed,
				limit: Math.max(1, options.limit),
			};
			const response = await this.request(`/indexes/${encodeURIComponent(creds.headingsIndex)}/search`, {
				method: "POST",
				body: JSON.stringify(payload),
			});
			const { hits } = (await response.json()) as { hits: Array<Record<string, unknown>> };
			const activePath = options.activePath ? normalizePath(options.activePath) : null;
			return hits
				.map((hit) => {
					const id = typeof hit.id === "string" ? hit.id : "";
					const score = typeof hit._rankingScore === "number" ? hit._rankingScore : 0;
					const path = typeof hit.path === "string" ? hit.path : "";
					return {
						id,
						score: activePath && path === activePath ? score + 0.1 : score,
						document: {
							id,
							path,
							basename: typeof hit.basename === "string" ? hit.basename : "",
							folder: typeof hit.folder === "string" ? hit.folder : "",
							heading: typeof hit.heading === "string" ? hit.heading : "",
							slug: typeof hit.slug === "string" ? hit.slug : "",
							line: Number(hit.line ?? 0),
							level: Number(hit.level ?? 0),
							modified: Number(hit.modified ?? 0),
						},
					};
				})
				.filter((entry) => entry.document.path && !isExcluded(entry.document.path, this.excludedMatchers));
		} catch (error) {
			this.recordError(error);
			return [];
		}
	}

	private scheduleRefresh(): void {
		if (this.refreshTimer) {
			window.clearTimeout(this.refreshTimer);
		}
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = null;
			void this.flushPending();
		}, this.refreshDebounce);
	}

	private async flushPending(): Promise<void> {
		if (!this.credentials || this.lastError) return;
		const files: TFile[] = [];
		for (const file of this.app.vault.getMarkdownFiles()) {
			const normalized = normalizePath(file.path);
			if (this.pendingPaths.has(normalized)) {
				files.push(file);
			}
		}
		this.pendingPaths.clear();
		if (files.length === 0) return;
		await this.indexFiles(files);
	}

	private async rebuildAll(): Promise<void> {
		if (!this.credentials || this.lastError) return;
		const files = this.app.vault.getMarkdownFiles();
		await this.indexFiles(files);
	}

	private async indexFiles(files: TFile[]): Promise<void> {
		if (!this.credentials || files.length === 0) return;
		let noteBatch: NoteDocument[] = [];
		let headingBatch: HeadingDocument[] = [];
		let processed = 0;

		const flushNotes = async (): Promise<void> => {
			if (noteBatch.length === 0) return;
			await this.addDocuments(this.credentials!.notesIndex, noteBatch);
			noteBatch = [];
		};

		const flushHeadings = async (force = false): Promise<void> => {
			if (headingBatch.length === 0) return;
			if (!force && headingBatch.length < DOCUMENT_BATCH_SIZE) return;
			const chunk = force ? headingBatch.splice(0, headingBatch.length) : headingBatch.splice(0, DOCUMENT_BATCH_SIZE);
			if (chunk.length === 0) return;
			await this.addDocuments(this.credentials!.headingsIndex, chunk);
			if (!force && headingBatch.length >= DOCUMENT_BATCH_SIZE) {
				await flushHeadings();
			}
		};

		for (const file of files) {
			if (isExcluded(file.path, this.excludedMatchers)) {
				continue;
			}
			const docs = await this.toDocuments(file);
			noteBatch.push(docs.note);
			if (noteBatch.length >= DOCUMENT_BATCH_SIZE) {
				await flushNotes();
				await this.yieldToEventLoop();
			}
			if (docs.headings.length > 0) {
				headingBatch.push(...docs.headings);
				while (headingBatch.length >= DOCUMENT_BATCH_SIZE) {
					await flushHeadings();
					await this.yieldToEventLoop();
				}
			}
			processed++;
			if (processed % YIELD_INTERVAL === 0) {
				await this.yieldToEventLoop();
			}
		}

		await flushNotes();
		await flushHeadings(true);
		await this.yieldToEventLoop();
	}

	private async toDocuments(file: TFile): Promise<{ note: NoteDocument; headings: HeadingDocument[] }> {
	const stat = file.stat;
	const normalizedPath = normalizePath(file.path);
	const noteId = makeDocumentId(normalizedPath);
	const content = await this.app.vault.cachedRead(file);
	const cache = this.app.metadataCache.getFileCache(file);
	const aliases = this.extractAliases(cache?.frontmatter);
	const folder = normalizePath(file.parent ? file.parent.path : "/");
	const contentLength = content.length;
	const trimmedContent =
		contentLength > MAX_CONTENT_LENGTH ? content.slice(0, MAX_CONTENT_LENGTH) : content;
	const note: NoteDocument = {
		id: noteId,
		path: normalizedPath,
		basename: file.basename,
		folder,
		content: trimmedContent,
		contentLength,
		truncated: contentLength > MAX_CONTENT_LENGTH || undefined,
		aliases,
		modified: typeof stat?.mtime === "number" ? stat.mtime : 0,
		created: typeof stat?.ctime === "number" ? stat.ctime : 0,
	};
	const headings: HeadingDocument[] = [];
	const seenSlugs = new Map<string, number>();
	if (cache?.headings) {
		for (const heading of cache.headings) {
			if (typeof heading.heading !== "string") continue;
			const slug = createHeadingSlug(heading.heading, seenSlugs);
			const line = heading.position?.start?.line ?? 0;
			const headingId = makeDocumentId(`${normalizedPath}#${slug}`);
			const doc: HeadingDocument = {
				id: headingId,
				path: normalizedPath,
				basename: note.basename,
				folder: note.folder,
				heading: heading.heading,
				slug,
				line,
				level: heading.level ?? 0,
				modified: note.modified,
			};
			headings.push(doc);
		}
	}
	return { note, headings };
}

	private extractAliases(frontmatter: unknown): string[] {
		if (!frontmatter || typeof frontmatter !== "object") {
			return [];
		}
		const aliases = (frontmatter as Record<string, unknown>).aliases;
		if (Array.isArray(aliases)) {
			return aliases.filter((entry): entry is string => typeof entry === "string");
		}
		if (typeof aliases === "string") {
			return [aliases];
		}
		return [];
	}

private async deleteNote(path: string): Promise<void> {
	const creds = this.credentials;
	if (!creds) return;
	const normalized = normalizePath(path);
	const id = makeDocumentId(normalized);
	await this.deleteDocuments(creds.notesIndex, [id]);
	await this.deleteByFilter(creds.headingsIndex, `path = "${normalized.replace(/"/g, '\\"')}"`);
}

	private async ensureIndexes(): Promise<void> {
		if (!this.credentials) return;
		if (!Platform.isDesktopApp) {
			this.lastError = "Meilisearch indexing is disabled on mobile.";
			return;
		}
		try {
			await this.ping();
		await this.ensureIndex(this.credentials.notesIndex, "id", {
		filterableAttributes: ["folder"],
		searchableAttributes: ["basename", "content", "aliases"],
		sortableAttributes: ["modified", "created"],
	});
	await this.ensureIndex(this.credentials.headingsIndex, "id", {
		filterableAttributes: ["path", "folder", "level"],
		searchableAttributes: ["heading", "slug"],
		sortableAttributes: ["modified", "line"],
	});
			this.lastError = undefined;
		} catch (error) {
			this.recordError(error);
		}
	}

	private async ping(): Promise<void> {
		await this.request("/health");
	}

private async ensureIndex(
	indexUid: string,
	primaryKey: string,
	settings: { filterableAttributes?: string[]; searchableAttributes?: string[]; sortableAttributes?: string[] },
): Promise<void> {
		const creds = this.credentials;
		if (!creds) return;

		let exists = true;
		try {
			const res = await this.request(`/indexes/${encodeURIComponent(indexUid)}`, {}, { suppressErrorLog: true });
			const info = (await res.json()) as { primaryKey?: string | null };
			const currentPrimary = typeof info.primaryKey === "string" ? info.primaryKey : null;
			if (currentPrimary && currentPrimary !== primaryKey) {
				await this.dropIndex(indexUid);
				exists = false;
			}
		} catch (error) {
			const err = error as { status?: number };
			if (typeof err.status === "number" && err.status === 404) {
				exists = false;
			} else {
			this.recordError(error);
			throw error;
		}
	}

		if (!exists) {
			const response = await this.request("/indexes", {
				method: "POST",
				body: JSON.stringify({ uid: indexUid, primaryKey }),
			});
			const task = (await response.json()) as MeilisearchTask;
			await this.waitForTask(task.taskUid);
		}

	await this.updateIndexSettings(indexUid, settings);
}
	private async dropIndex(indexUid: string): Promise<void> {
		const response = await this.request(`/indexes/${encodeURIComponent(indexUid)}`, {
			method: "DELETE",
		}, { suppressErrorLog: true });
		const task = (await response.json()) as MeilisearchTask;
		await this.waitForTask(task.taskUid);
	}

	private async updateIndexSettings(
	indexUid: string,
	settings: { filterableAttributes?: string[]; searchableAttributes?: string[]; sortableAttributes?: string[] },
): Promise<void> {
	const payload: Record<string, unknown> = {};
	if (settings.filterableAttributes) {
		payload.filterableAttributes = settings.filterableAttributes;
	}
	if (settings.searchableAttributes) {
		payload.searchableAttributes = settings.searchableAttributes;
	}
	if (settings.sortableAttributes) {
		payload.sortableAttributes = settings.sortableAttributes;
	}
	if (Object.keys(payload).length === 0) {
		return;
	}
	const url = `/indexes/${encodeURIComponent(indexUid)}/settings`;
	let response: Response;
	try {
		response = await this.request(url, {
			method: "PATCH",
			body: JSON.stringify(payload),
		}, { suppressErrorLog: true });
	} catch (error) {
		const status = (error as { status?: number }).status;
		if (status === 405) {
			response = await this.request(url, {
				method: "POST",
				body: JSON.stringify(payload),
			});
		} else {
			this.recordError(error);
			throw error;
		}
	}
	const task = (await response.json()) as MeilisearchTask;
	await this.waitForTask(task.taskUid);
}

	private async addDocuments(indexUid: string, docs: Array<Record<string, unknown>>): Promise<void> {
		if (docs.length === 0) return;
		for (let cursor = 0; cursor < docs.length; cursor += DOCUMENT_BATCH_SIZE) {
			const chunk = docs.slice(cursor, cursor + DOCUMENT_BATCH_SIZE);
			await this.pushDocuments(indexUid, chunk);
		}
	}

	private async pushDocuments(indexUid: string, docs: Array<Record<string, unknown>>): Promise<void> {
		const payload = JSON.stringify(docs);
		const response = await this.request(`/indexes/${encodeURIComponent(indexUid)}/documents`, {
			method: "POST",
			body: payload,
		});
		const task = (await response.json()) as MeilisearchTask;
		await this.waitForTask(task.taskUid);
	}

private async deleteDocuments(indexUid: string, ids: string[]): Promise<void> {
	if (ids.length === 0) return;
	const response = await this.request(`/indexes/${encodeURIComponent(indexUid)}/documents/delete-batch`, {
		method: "POST",
		body: JSON.stringify(ids),
	});
	const task = (await response.json()) as MeilisearchTask;
	await this.waitForTask(task.taskUid);
}

private async deleteByFilter(indexUid: string, filter: string): Promise<void> {
	const response = await this.request(`/indexes/${encodeURIComponent(indexUid)}/documents/delete`, {
		method: "POST",
		body: JSON.stringify({ filter }),
	});
	const task = (await response.json()) as MeilisearchTask;
	await this.waitForTask(task.taskUid);
}

	private async waitForTask(taskUid: number): Promise<void> {
		for (;;) {
			const res = await this.request(`/tasks/${taskUid}`);
			const task = (await res.json()) as MeilisearchTaskStatus;
			if (task.status === "succeeded") {
				return;
			}
			if (task.status === "failed" || task.status === "canceled") {
				throw new Error(task.error?.message ?? "Meilisearch task failed");
			}
			await new Promise((resolve) => window.setTimeout(resolve, 150));
		}
	}

	private async request(path: string, init: RequestInit = {}, options: { suppressErrorLog?: boolean } = {}): Promise<Response> {
		if (!this.credentials) {
			throw new Error("Meilisearch is not configured.");
		}
		const url = `${this.credentials.host.replace(/\/+$/, "")}${path}`;
		const headers = new Headers(init.headers ?? {});
		headers.set("Content-Type", "application/json");
		if (this.credentials.apiKey) {
			headers.set("Authorization", `Bearer ${this.credentials.apiKey}`);
		}
	let response: Response;
	try {
		response = await fetch(url, {
			...init,
			headers,
		});
	} catch (error) {
		if (!options.suppressErrorLog) {
			this.recordError(error);
		}
		throw error;
	}
	if (!response.ok) {
		const error = new Error(`Meilisearch request failed (${response.status})`);
		(error as { status?: number }).status = response.status;
		if (!options.suppressErrorLog) {
			this.recordError(error);
		}
		throw error;
	}
	this.lastError = undefined;
	return response;
}

	private recordError(error: unknown): void {
		const base = error instanceof Error ? error.message : String(error);
		const host = this.credentials?.host ?? "configured endpoint";
		const message = `Meilisearch error (${host}): ${base}`;
		this.lastError = message;
		if (this.debug) {
			console.warn(message);
		}
	}
}
