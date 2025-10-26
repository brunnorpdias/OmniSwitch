import type { App, HeadingCache, TFile, TFolder } from "obsidian";
import { type PersistedFileEntry, type PersistedHeadingEntry, normalizePath } from "./model";
import { StatusBroadcaster } from "./status";
import type { OmniSwitchSettings } from "../settings";
import { getCommandManager } from "../obsidian-helpers";
import { isTFile } from "./obsidian-guards";
import type { FileDoc, HeadingDoc, CommandDoc } from "./engines/fuse-engine";
import type { FileSearchItem, HeadingSearchItem, CommandSearchItem } from "./types";

type ChangeType = "created" | "modified" | "deleted" | "renamed";

interface IndexChange {
	type: ChangeType;
	path: string;
	oldPath?: string;
}

interface ManagerDependencies {
    app: App;
    status: StatusBroadcaster;
    getSettings: () => OmniSwitchSettings;
    onFilesUpdated: () => void;
    onCommandsUpdated: () => void;
    onFullRebuildComplete?: () => void;
    onEngineFileUpsert?: (path: string) => void;
    onEngineFileRemove?: (path: string) => void;
    journal?: {
        initialize(): Promise<void>;
        appendUpsert(entry: PersistedFileEntry): void;
        appendDelete(path: string): void;
        appendRename(oldPath: string, newPath: string): void;
        loadAllEvents(): Promise<Array<{ v: number; ts: number; op: string; path?: string; ext?: string; mtime?: number; size?: number; headings?: Array<{ text: string; level: number; ord: number }>; oldPath?: string; newPath?: string }>>;
    };
}

interface ExclusionMatcher {
	exact: string;
	prefix: string;
}

export class IndexManager {
	private readonly app: App;
	private readonly status: StatusBroadcaster;
	private readonly getSettings: () => OmniSwitchSettings;
	private readonly onFilesUpdated: () => void;
    private readonly onCommandsUpdated: () => void;
    private readonly onFullRebuildComplete: (() => void) | null = null;

	// Direct storage in Maps
	private readonly files = new Map<string, FileDoc>();
	private readonly headings = new Map<string, HeadingDoc[]>();  // path -> headings
	private readonly commands = new Map<string, CommandDoc>();
	private folders: TFolder[] = [];

	// Public getters for docs arrays
	getFileDocs(): FileDoc[] {
		return Array.from(this.files.values());
	}

	getHeadingDocs(): HeadingDoc[] {
		const all: HeadingDoc[] = [];
		for (const headingList of this.headings.values()) {
			all.push(...headingList);
		}
		return all;
	}

	getCommandDocs(): CommandDoc[] {
		return Array.from(this.commands.values());
	}

	getFolders(): TFolder[] {
		return this.folders;
	}
    private readonly onEngineFileUpsert: ((path: string) => void) | null = null;
    private readonly onEngineFileRemove: ((path: string) => void) | null = null;
    private readonly journal: ManagerDependencies["journal"] | null = null;

	private readonly queue: IndexChange[] = [];
	private readonly snapshots = new Map<string, PersistedFileEntry>();
	private readonly structuralSig = new Map<string, string>();
	private skipEngineUpdates = false; // Set to true during full rebuild to prevent incremental updates

	// Vault snapshot/cache
	private vaultMap: Map<string, { file: TFile; extension: string; mtime: number; size: number }> | null = null;

	// Batch tuning
	private static readonly BATCH_SIZE = 25;
	private static readonly BATCH_YIELD_MS = 5;
	private static readonly MICRO_DEBOUNCE_MS = 350;

	private microTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private microPending = new Map<string, IndexChange>();

	private processing = false;
	private scheduled = false;
	private pendingFullRebuild = false;
	private foldersDirty = false;
	private matchers: ExclusionMatcher[] = [];
		private initialized = false;
		private commandsDeferred = false;
		private headingCacheMemo = new Map<string, HeadingCache[]>();
		private lastCommandSyncAt: number | null = null;
        

    constructor(deps: ManagerDependencies) {
		this.app = deps.app;
		this.status = deps.status;
		this.getSettings = deps.getSettings;
		this.onFilesUpdated = deps.onFilesUpdated;
        this.onCommandsUpdated = deps.onCommandsUpdated;
        this.onFullRebuildComplete = deps.onFullRebuildComplete ?? null;
        this.onEngineFileUpsert = deps.onEngineFileUpsert ?? null;
        this.onEngineFileRemove = deps.onEngineFileRemove ?? null;
        this.journal = deps.journal ?? null;
    }

    async initialize(): Promise<void> {
		if (this.initialized) {
			return;
		}
		this.initialized = true;
		this.refreshMatchers();
        this.status.announce("validating");
        if (this.journal) {
            try { await this.journal.initialize(); } catch (e) { console.warn("[OmniSwitch] Journal init failed", e); }
        }

        // Initialize from NDJSON journal only; if empty, trigger full rebuild
        const events = this.journal ? await this.journal.loadAllEvents() : [];
        if (!events || events.length === 0) {
            this.flagFullRebuild("init_no_journal");
            this.scheduleProcessing();
            return;
        }
        const map = new Map<string, PersistedFileEntry>();
        let upserts = 0; let deletes = 0; let renames = 0;
        for (const ev of events) {
            if (ev.op === "upsert" && ev.path) {
                const k = normalizePath(ev.path);
                const headings = Array.isArray(ev.headings) ? ev.headings.map((h) => ({ text: h.text, level: h.level })) : [];
                map.set(k, { path: k, extension: (ev.ext ?? "").toLowerCase(), modified: Math.trunc(ev.mtime ?? 0), size: typeof ev.size === "number" ? ev.size : -1, headings });
                upserts += 1;
            } else if (ev.op === "delete" && ev.path) {
                map.delete(normalizePath(ev.path));
                deletes += 1;
            } else if (ev.op === "rename" && ev.oldPath && ev.newPath) {
                const oldK = normalizePath(ev.oldPath);
                const newK = normalizePath(ev.newPath);
                const current = map.get(oldK);
                if (current) {
                    map.delete(oldK);
                    map.set(newK, { ...current, path: newK });
                }
                renames += 1;
            }
        }
        const baseline = Array.from(map.values());
        console.info(`[OmniSwitch] Journal: built baseline (upserts=${upserts}, deletes=${deletes}, renames=${renames}, files=${baseline.length})`);

        await this.hydrateFromBaseline(baseline);
        this.rebuildCommandList();
        this.onFilesUpdated();
    }

    // No persisted engine snapshots

    /**
     * Validate journal baseline against actual vault state.
     * Detects missing files, changed files (mtime diff), and extra files.
     * Queues missing/changed files for incremental indexing.
     */
    private async validateBaseline(
        baseline: PersistedFileEntry[],
        map: Map<string, PersistedFileEntry>
    ): Promise<PersistedFileEntry[]> {
        // Build vault map if not already cached
        if (!this.vaultMap) {
            this.vaultMap = this.buildVaultMap();
        }

        const validated: PersistedFileEntry[] = [];
        const vaultPaths = new Set(this.vaultMap.keys());

        // Check each baseline entry
        for (const entry of baseline) {
            const path = normalizePath(entry.path);
            const vaultEntry = this.vaultMap.get(path);

            if (!vaultEntry) {
                // File no longer exists in vault - skip it
                map.delete(path);
                continue;
            }

            // Check if file modified since journal
            if (entry.modified !== vaultEntry.mtime || entry.size !== vaultEntry.size) {
                // File changed - queue for re-indexing
                this.queue.push({ type: "modified", path });
                map.delete(path); // Don't hydrate stale entry
                continue;
            }

            // Valid entry
            validated.push(entry);
            vaultPaths.delete(path); // Mark as found
        }

        // Queue files that exist in vault but missing from journal
        for (const missingPath of vaultPaths) {
            if (!this.isExcluded(missingPath)) {
                this.queue.push({ type: "created", path: missingPath });
            }
        }

        return validated;
    }

    /**
     * Sync files from vault that are missing from journal baseline.
     * This recovers from incomplete journal population (e.g., plugin installed
     * on existing vault, crash during initial rebuild, etc.)
     */
    private async syncMissingFiles(
        baseline: PersistedFileEntry[],
        map: Map<string, PersistedFileEntry>
    ): Promise<void> {
        const t0 = Date.now();

        // Build vault map (fast, ~3ms for 10k files)
        if (!this.vaultMap) {
            this.vaultMap = this.buildVaultMap();
        }

        const baselinePaths = new Set(baseline.map(e => normalizePath(e.path)));
        const missing: TFile[] = [];

        // Find files in vault but NOT in journal
        for (const [path, vaultEntry] of this.vaultMap.entries()) {
            if (this.isExcluded(path)) continue;
            if (!baselinePaths.has(path)) {
                missing.push(vaultEntry.file);
            }
        }

        if (missing.length === 0) {
            const ms = Date.now() - t0;
            console.info(`[OmniSwitch] Vault sync: checked ${this.vaultMap.size} files, all in journal (${ms} ms)`);
            return;
        }

        console.info(`[OmniSwitch] Vault sync: found ${missing.length} missing files, adding to journal...`);

        // Process missing files and write to journal immediately
        for (const file of missing) {
            const path = normalizePath(file.path);
            const ext = file.extension.toLowerCase();
            const mtime = Math.trunc(file.stat.mtime);
            const size = typeof file.stat.size === "number" ? file.stat.size : -1;

            // Extract headings for markdown files
            const isMarkdown = ext === "md";
            const headings = isMarkdown
                ? (this.app.metadataCache.getFileCache(file)?.headings ?? [])
                : [];
            const persistedHeadings = headings.map((h) => ({
                text: h.heading,
                level: h.level ?? 0,
            }));

            // Add to baseline map (will be hydrated)
            map.set(path, {
                path,
                extension: ext,
                modified: mtime,
                size,
                headings: persistedHeadings,
            });

            // Write to journal (will be flushed automatically within 500ms)
            try {
                this.journal?.appendUpsert({
                    path,
                    extension: ext,
                    modified: mtime,
                    size,
                    headings: persistedHeadings,
                });
            } catch (e) {
                console.warn(`[OmniSwitch] Failed to write ${path} to journal`, e);
            }
        }

        const ms = Date.now() - t0;
        console.info(`[OmniSwitch] Vault sync: added ${missing.length} files to journal in ${ms} ms`);
    }

	handleSettingsChanged(): void {
		const t0 = Date.now();
		this.refreshMatchers();
		// Targeted updates: remove newly excluded, queue newly included
		this.vaultMap = this.buildVaultMap();
		let removed = 0;
		let queued = 0;
		// Remove newly excluded paths
		for (const path of Array.from(this.snapshots.keys())) {
			if (this.isExcluded(path)) {
				this.removeFile(path);
				removed += 1;
			}
		}
		// Queue newly included paths that exist in vault but are missing from snapshot
		for (const [path] of this.vaultMap.entries()) {
			if (!this.isExcluded(path) && !this.snapshots.has(path)) {
				this.queue.push({ type: "created", path });
				queued += 1;
			}
		}
		if (removed === 0 && queued === 0) {
			// Nothing targeted to do; still refresh folders in case exclusions impacted them
			this.setFoldersDirty();
		}
		const ms = Date.now() - t0;
		console.info(`[OmniSwitch] Exclusions update: removed=${removed}, queued=${queued} in ${ms} ms`);
		this.scheduleProcessing();
	}

    queueVaultChange(change: IndexChange): void {
        const normPath = normalizePath(change.path);
        const key = normPath;
        const pending = this.microPending.get(key) ?? null;
        let next: IndexChange = { ...change, path: normPath };
        // Coalesce semantics per path
        if (pending) {
            if (pending.type === "deleted") {
                next = pending; // deletion wins
            } else if (pending.type === "created" && change.type === "modified") {
                next = pending; // keep created
            } else {
                next = { ...pending, ...next };
            }
        }
        this.microPending.set(key, next);
        // Clear any existing timer and set a new one
        const scheduler = typeof window !== "undefined" ? window.setTimeout.bind(window) : setTimeout;
        const clearer = typeof window !== "undefined" ? window.clearTimeout.bind(window) : clearTimeout;
        const existingTimer = this.microTimers.get(key) ?? null;
        if (existingTimer) {
            clearer(existingTimer as unknown as number);
        }
        const timer = scheduler(() => {
            this.microTimers.delete(key);
            const finalChange = this.microPending.get(key);
            this.microPending.delete(key);
            if (!finalChange) return;
            this.queue.push(finalChange);
            this.scheduleProcessing();
        }, IndexManager.MICRO_DEBOUNCE_MS);
        this.microTimers.set(key, timer);
    }

    private removeQueuedForPath(path: string): void {
        const normalized = normalizePath(path);
        this.dropFromQueue((q) => normalizePath(q.path) === normalized);
    }

    private dropFromQueue(predicate: (q: IndexChange) => boolean): void {
        for (let i = this.queue.length - 1; i >= 0; i -= 1) {
            if (predicate(this.queue[i])) {
                this.queue.splice(i, 1);
            }
        }
    }

    requestFullRebuild(): void {
        this.flagFullRebuild("manual_request");
        this.scheduleProcessing();
    }

	notifyFolderMutation(): void {
		this.setFoldersDirty();
		this.scheduleProcessing();
	}

	private scheduleProcessing(): void {
		if (this.scheduled) {
			return;
		}
		if (!this.hasWork()) {
			return;
		}
		this.scheduled = true;
		const scheduler = typeof window !== "undefined" ? window.setTimeout.bind(window) : setTimeout;
		scheduler(() => {
			this.scheduled = false;
			this.processQueue().catch((error) => console.error("[OmniSwitch] Failed to process index queue", error));
		}, 10);
	}

    private async processQueue(): Promise<void> {
		if (this.processing) {
			return;
		}

		if (!this.hasWork()) {
			this.status.announce("ready");
			return;
		}

        this.processing = true;
        const startAll = Date.now();
        // Reset command timing for this pass
        this.lastCommandSyncAt = null;
        const queuedCount = this.queue.length;
        this.status.announce("indexing_changes", { files: queuedCount + (this.pendingFullRebuild ? (this.vaultMap?.size ?? 0) : 0) });
		console.info(`[OmniSwitch] Index: start (queued=${queuedCount}, fullRebuild=${this.pendingFullRebuild})`);

        try {
            let updated = false;
            let processedChanges = 0;
            let unchangedSkipped = 0;

            let didFullRebuild = false;
            if (this.pendingFullRebuild) {
                const start = Date.now();
                await this.rebuildAll();
                const ms = Date.now() - start;
                console.info(`[OmniSwitch] Rebuild: end in ${ms} ms`);
                updated = true;
                this.pendingFullRebuild = false;
                didFullRebuild = true;
            }

			// Process queued changes in batches
            while (this.queue.length > 0) {
                const batch = this.queue.splice(0, IndexManager.BATCH_SIZE);
                const t0 = Date.now();
                for (const change of batch) {
                    const applied = await this.applyChange(change);
                    if (!applied) unchangedSkipped += 1;
                    updated = updated || applied;
                    processedChanges += 1;
                }
                const ms = Date.now() - t0;
                console.info(`[OmniSwitch] Change batch: processed ${batch.length} in ${ms} ms`);
                await this.yieldForIdle();
            }

            if (this.foldersDirty) {
                this.refreshFolders();
                updated = true;
                this.foldersDirty = false;
            }

            if (updated) {
                const tDocs0 = Date.now();
                if (didFullRebuild) {
                    // Full rebuild completed - clear and rebuild engines from scratch
                    this.onFullRebuildComplete?.();
                } else {
                    // Incremental updates - engines updated via applyEngine* callbacks
                    this.onFilesUpdated();
                }
                const docsMs = Date.now() - tDocs0;
                console.info(`[OmniSwitch] Docs: ${didFullRebuild ? 'full rebuild' : 'incremental update'} engines in ${docsMs} ms`);
                // Engine persistence handled at coordinator level
            }
            if (unchangedSkipped > 0) {
                console.info(`[OmniSwitch] Index: unchanged events skipped=${unchangedSkipped}`);
            }
		} finally {
			this.processing = false;
			if (this.hasWork()) {
				this.scheduleProcessing();
            } else {
                // Queue is idle; announce readiness after incremental engine updates
                this.status.announce("ready");
                const total = Date.now() - startAll;
                if (this.lastCommandSyncAt) {
                    const postCmdMs = Date.now() - this.lastCommandSyncAt;
                    console.info(`[OmniSwitch] Post-commands: to ready in ${postCmdMs} ms`);
                }
                console.info(`[OmniSwitch] Index: end in ${total} ms`);
            }
        }
    }

    private async rebuildAll(): Promise<void> {
		// Full rebuild disregards snapshot content; batch + idle yield
		this.files.clear();
		this.headings.clear();
		this.snapshots.clear();
		this.headingCacheMemo.clear();
		this.structuralSig.clear();

		// Disable incremental engine updates during rebuild
		// Engines will be rebuilt from docs arrays via onFilesUpdated() after rebuild
		this.skipEngineUpdates = true;

		try {
			this.vaultMap = this.buildVaultMap();
			const toIndex: TFile[] = [];
			for (const { file } of this.vaultMap.values()) {
				if (this.isExcluded(file.path)) {
					continue;
				}
				toIndex.push(file);
			}

			console.info(`[OmniSwitch] Rebuild: start (files=${toIndex.length})`);
			let processed = 0;
			for (let i = 0; i < toIndex.length; i += IndexManager.BATCH_SIZE) {
				const batch = toIndex.slice(i, i + IndexManager.BATCH_SIZE);
				const t0 = Date.now();
				for (const file of batch) {
					await this.captureFile(file, null);
					processed += 1;
				}
				const ms = Date.now() - t0;
				console.info(`[OmniSwitch] Index batch: files=${batch.length} in ${ms} ms`);
				await this.yieldForIdle();
			}

			this.rebuildCommandList();
			this.setFoldersDirty();
		} finally {
			// Re-enable incremental engine updates
			this.skipEngineUpdates = false;
		}
	}

    // Removed legacy hydrateFromSnapshot path (snapshot files no longer used)

    // Journal-first hydration: do not scan the entire vault; use the baseline directly
    private async hydrateFromBaseline(entries: PersistedFileEntry[]): Promise<void> {
        const start = Date.now();
        this.headingCacheMemo.clear();

        // Phase 1: Process entries
        const tProcess0 = Date.now();
        const toSeed: Array<{ file: TFile; headings: HeadingCache[] }> = [];
        const folderSet = new Set<string>();
        for (const entry of entries) {
            const path = normalizePath(entry.path);
            const file = this.getFile(path);
            if (!file || this.isExcluded(path)) continue;
            const heads = this.getOrCreateHeadingCaches(path, entry.headings ?? []);
            this.snapshots.set(path, {
                path,
                extension: entry.extension,
                modified: Math.trunc(entry.modified),
                size: typeof entry.size === "number" ? entry.size : -1,
                headings: entry.headings ?? [],
            });
            this.structuralSig.set(path, this.computeSignature(entry.extension, entry.headings ?? []));
            toSeed.push({ file, headings: heads });
            // collect folders
            const segments = path.split("/");
            segments.pop();
            let acc = "";
            for (const seg of segments) {
                acc = acc ? `${acc}/${seg}` : seg;
                if (!this.isExcluded(acc)) folderSet.add(acc);
            }
        }
        const processMs = Date.now() - tProcess0;
        console.info(`[OmniSwitch] Hydrate: Phase 1 (process entries) in ${processMs} ms`);

        // Phase 2: Seed files map
        const tSeed0 = Date.now();
        for (const { file, headings } of toSeed) {
			const doc: FileDoc = {
				id: file.path,
				path: file.path,
				name: file.name,
				extension: file.extension,
				parent: file.parent?.path ?? null,
				item: { type: "file", file }
			};
			this.files.set(file.path, doc);

			// Add headings
			const headingList: HeadingDoc[] = [];
			if (headings && headings.length > 0) {
				for (let i = 0; i < headings.length; i++) {
					const h = headings[i];
					headingList.push({
						id: `${file.path}#${h.heading}::${i}`,
						path: file.path,
						title: h.heading,
						level: h.level,
						item: { type: "heading", file, heading: h }
					});
				}
			}
			this.headings.set(file.path, headingList);
        }
        const seedMs = Date.now() - tSeed0;
        console.info(`[OmniSwitch] Hydrate: Phase 2 (seedFiles) in ${seedMs} ms`);

        // Phase 3: Resolve folders
        const tFolders0 = Date.now();
        const folders: TFolder[] = [];
        // Add root folder
        const root = this.app.vault.getRoot();
        if (root) {
            folders.push(root);
        }
        // Add child folders
        for (const folderPath of folderSet) {
            const abstract = this.app.vault.getAbstractFileByPath(folderPath);
            if (abstract && typeof (abstract as TFolder).isRoot === "function") {
                folders.push(abstract as TFolder);
            }
        }
        const foldersMs = Date.now() - tFolders0;
        console.info(`[OmniSwitch] Hydrate: Phase 3 (resolve folders) in ${foldersMs} ms`);

        // Phase 4: Set folder list
        const tSetFolders0 = Date.now();
        this.folders = folders;
        const setFoldersMs = Date.now() - tSetFolders0;
        console.info(`[OmniSwitch] Hydrate: Phase 4 (setFolderList) in ${setFoldersMs} ms`);

        const ms = Date.now() - start;
        console.info(`[OmniSwitch] Hydrate(baseline): TOTAL ${ms} ms (process=${processMs}ms, seed=${seedMs}ms, resolveFolders=${foldersMs}ms, setFolders=${setFoldersMs}ms) [files=${toSeed.length}, folders=${folders.length}]`);
    }

    private async applyChange(change: IndexChange): Promise<boolean> {
        switch (change.type) {
            case "created":
            case "modified": {
                const file = this.getFile(change.path);
                if (!file) {
                    return false;
                }
                if (this.isExcluded(file.path)) {
                    this.removeFile(file.path);
                    return true;
                }
                // Keep vault map fresh for runtime events
                if (this.vaultMap) {
                    this.vaultMap.set(normalizePath(file.path), {
                        file,
                        extension: file.extension.toLowerCase(),
                        mtime: Math.trunc(file.stat.mtime),
                        size: typeof file.stat.size === "number" ? file.stat.size : -1,
                    });
                }
                const key = normalizePath(file.path);
                const existing = this.snapshots.get(key) ?? null;
                const mtime = Math.trunc(file.stat.mtime);
                const size = typeof file.stat.size === "number" ? file.stat.size : -1;
                if (existing && existing.modified === mtime && existing.size === size && existing.extension === file.extension.toLowerCase()) {
                    // No actual change; skip capture entirely to avoid churn
                    return false;
                }
                const fallback = existing?.headings ?? null;
                return await this.captureFile(file, fallback);
            }
            case "deleted": {
                this.removeFile(change.path);
                if (this.vaultMap) {
                    this.vaultMap.delete(normalizePath(change.path));
                }
                return true;
            }
		case "renamed": {
			const file = this.getFile(change.path);
			if (!change.oldPath) {
				return false;
			}
			const previous = this.snapshots.get(normalizePath(change.oldPath)) ?? null;
			this.removeFile(change.oldPath);
			try { this.journal?.appendRename(change.oldPath, change.path); } catch {}
			if (!file || this.isExcluded(file.path)) {
				return true;
			}
			if (this.vaultMap) {
				this.vaultMap.delete(normalizePath(change.oldPath));
				this.vaultMap.set(normalizePath(file.path), {
					file,
					extension: file.extension.toLowerCase(),
					mtime: Math.trunc(file.stat.mtime),
					size: typeof file.stat.size === "number" ? file.stat.size : -1,
				});
			}
			const fallback = previous?.headings ?? null;
			await this.captureFile(file, fallback);
			return true;
		}
			default:
				return false;
		}
	}

    private async captureFile(file: TFile, fallbackHeadings: PersistedHeadingEntry[] | null): Promise<boolean> {
        const key = normalizePath(file.path);
        const modified = Math.trunc(file.stat.mtime);
        const size = typeof file.stat.size === "number" ? file.stat.size : -1;
        const existing = this.snapshots.get(key);
        const canReuseSnapshot = Boolean(
            existing
            && existing.modified === modified
            && existing.size === size
            && fallbackHeadings !== null,
        );

        let headingList;
        let persistedHeadings: PersistedHeadingEntry[];
        const t0 = Date.now();

        if (canReuseSnapshot) {
            const reuse = fallbackHeadings ?? [];
            // No actual changes; skip doc updates entirely
            const ms = Date.now() - t0;
            console.info(`[OmniSwitch] File upsert [reuse]: ${key} (ext=${file.extension.toLowerCase()}, mtime=${modified}, size=${size}, headings=${reuse.length}) in ${ms} ms`);
            return false;
        } else {
            const isMarkdown = file.extension.toLowerCase() === "md";
            const headings = isMarkdown ? this.app.metadataCache.getFileCache(file)?.headings ?? null : null;
            headingList = headings ?? this.getOrCreateHeadingCaches(key, fallbackHeadings ?? []);
            persistedHeadings = headings
                ? headings.map((heading) => ({
                    text: heading.heading,
                    level: heading.level ?? 0,
                }))
                : fallbackHeadings ?? [];
        }
        // Determine structural change (extension + headings)
        const prevSig = this.structuralSig.get(key) ?? (existing ? this.computeSignature(existing.extension, existing.headings ?? []) : "");
        const newSig = this.computeSignature(file.extension.toLowerCase(), persistedHeadings);
        const structuralChanged = prevSig !== newSig;

        if (structuralChanged) {
            if (existing && !canReuseSnapshot && !this.skipEngineUpdates) {
                this.onEngineFileRemove?.(key);
            }
			// Upsert file doc
			const doc: FileDoc = {
				id: file.path,
				path: file.path,
				name: file.name,
				extension: file.extension,
				parent: file.parent?.path ?? null,
				item: { type: "file", file }
			};
			this.files.set(file.path, doc);

			// Upsert headings
			const headingDocs: HeadingDoc[] = [];
			for (let i = 0; i < headingList.length; i++) {
				const h = headingList[i];
				headingDocs.push({
					id: `${file.path}#${h.heading}::${i}`,
					path: file.path,
					title: h.heading,
					level: h.level ?? 1,
					item: { type: "heading", file, heading: h }
				});
			}
			this.headings.set(file.path, headingDocs);
        }
        this.snapshots.set(key, {
            path: key,
            extension: file.extension.toLowerCase(),
            modified,
            size,
            headings: persistedHeadings,
        });
        this.structuralSig.set(key, newSig);
        if (structuralChanged) {
            try {
                this.journal?.appendUpsert({ path: key, extension: file.extension.toLowerCase(), modified, size, headings: persistedHeadings });
            } catch (e) {
                console.warn("[OmniSwitch] Journal append upsert failed", e);
            }
            if (!this.skipEngineUpdates) {
                this.onEngineFileUpsert?.(key);
            }
        }
        const ms = Date.now() - t0;
        const mode = (file.extension.toLowerCase() === "md" && (this.app.metadataCache.getFileCache(file)?.headings ?? null) ? "read" : "fallback");
        console.info(`[OmniSwitch] File upsert [${mode}${structuralChanged ? ", structural" : ", meta"}]: ${key} (ext=${file.extension.toLowerCase()}, mtime=${modified}, size=${size}, headings=${headingList.length}) in ${ms} ms`);
        this.setFoldersDirty();
        return structuralChanged;
    }

    private removeFile(path: string): void {
        const normalized = normalizePath(path);
        this.onEngineFileRemove?.(normalized);
        const t0 = Date.now();
        this.files.delete(normalized);
		this.headings.delete(normalized);
        this.snapshots.delete(normalized);
        this.structuralSig.delete(normalized);
        try { this.journal?.appendDelete(normalized); } catch {}
        const ms = Date.now() - t0;
        console.info(`[OmniSwitch] File remove: ${normalized} in ${ms} ms`);
        this.setFoldersDirty();
    }

	private refreshFolders(): void {
		this.refreshFoldersFromVaultMap();
	}

	private refreshFoldersFromVaultMap(): number {
		if (!this.vaultMap) {
			this.vaultMap = this.buildVaultMap();
		}
		const t0 = Date.now();
		const folderSet = new Set<string>();
		for (const path of this.vaultMap.keys()) {
			const segments = normalizePath(path).split("/");
			segments.pop(); // remove filename
			let acc = "";
			for (const seg of segments) {
				acc = acc ? `${acc}/${seg}` : seg;
				if (!this.isExcluded(acc)) {
					folderSet.add(acc);
				}
			}
		}
		const folders: TFolder[] = [];
		// Add root folder
		const root = this.app.vault.getRoot();
		if (root) {
			folders.push(root);
		}
		// Add child folders
		for (const folderPath of folderSet) {
			const abstract = this.app.vault.getAbstractFileByPath(folderPath);
			if (abstract && typeof (abstract as TFolder).isRoot === "function") {
				folders.push(abstract as TFolder);
			}
		}
		this.folders = folders;
		const ms = Date.now() - t0;
		console.info(`[OmniSwitch] Folders: synced ${folders.length} (derived) in ${ms} ms`);
		return folders.length;
	}

	private setFoldersDirty(): void {
		this.foldersDirty = true;
	}

    private async persistEngineSidecarsNow(): Promise<void> {
        // No-op: Persistence handled by the coordinator layer.
        return;
    }


	private getFile(path: string): TFile | null {
		const abstract = this.app.vault.getAbstractFileByPath(path);
		return isTFile(abstract) ? abstract : null;
	}

	private hasWork(): boolean {
		return this.pendingFullRebuild || this.queue.length > 0 || this.foldersDirty;
	}

	private syncFolders(): void {
		this.refreshFoldersFromVaultMap();
	}

	private isExcluded(path: string): boolean {
		const normalized = normalizePath(path);
		return this.matchers.some((matcher) => normalized === matcher.exact || normalized.startsWith(matcher.prefix));
	}

	private refreshMatchers(): void {
		const t0 = Date.now();
		const excluded = this.getSettings().excludedPaths ?? [];
		this.matchers = excluded.map((raw) => {
			const normalized = normalizePath(raw);
			const prefix = normalized.endsWith("/") ? normalized : `${normalized}/`;
			return { exact: normalized, prefix };
		});
		const ms = Date.now() - t0;
		console.info(`[OmniSwitch] Exclusions: ${this.matchers.length} rule(s) in ${ms} ms`);
	}

    private resolveHeadingCaches(headings: PersistedHeadingEntry[]): HeadingCache[] {
        return headings.map((entry) => ({
            heading: entry.text,
            level: entry.level,
            position: {
                start: { line: 0, col: 0, offset: 0 },
                end: { line: 0, col: 0, offset: 0 },
            },
        }));
    }

    private computeSignature(ext: string, headings: PersistedHeadingEntry[]): string {
        const parts: string[] = [ext.toLowerCase()];
        for (let i = 0; i < headings.length; i += 1) {
            const h = headings[i];
            const text = typeof h.text === "string" ? h.text : "";
            const level = typeof h.level === "number" ? h.level : 0;
            parts.push(`${i + 1}:${level}:${text}`);
        }
        return parts.join("|");
    }

	private async yieldForIdle(): Promise<void> {
		await new Promise<void>((resolve) => {
			const scheduler = typeof window !== "undefined" ? window.setTimeout.bind(window) : setTimeout;
			scheduler(resolve, IndexManager.BATCH_YIELD_MS);
		});
	}

	rebuildCommandList(): void {
		const manager = getCommandManager(this.app);
		if (!manager) {
			return;
		}

		if (!this.app.workspace.layoutReady) {
			if (!this.commandsDeferred) {
				this.commandsDeferred = true;
				this.app.workspace.onLayoutReady(() => {
					this.commandsDeferred = false;
					this.rebuildCommandList();
				});
			}
			return;
		}

		try {
			const t0 = Date.now();
			const commands = manager.listCommands();
			// Set commands map
			this.commands.clear();
			for (const cmd of commands) {
				const doc: CommandDoc = {
					id: cmd.id,
					name: cmd.name,
					item: { type: "command", command: cmd }
				};
				this.commands.set(cmd.id, doc);
			}
			this.onCommandsUpdated();
			const ms = Date.now() - t0;
			console.info(`[OmniSwitch] Commands: synced ${commands.length} in ${ms} ms`);
			this.lastCommandSyncAt = Date.now();
		} catch (error) {
			console.warn("[OmniSwitch] Failed to enumerate commands", error);
		}
	}

	private buildVaultMap(): Map<string, { file: TFile; extension: string; mtime: number; size: number }> {
		const t0 = Date.now();
		const map = new Map<string, { file: TFile; extension: string; mtime: number; size: number }>();
		const files = this.app.vault.getAllLoadedFiles();
		for (const abstract of files) {
			if (!isTFile(abstract)) {
				continue;
			}
			const file = abstract;
			const path = normalizePath(file.path);
			map.set(path, {
				file,
				extension: file.extension.toLowerCase(),
				mtime: Math.trunc(file.stat.mtime),
				size: typeof file.stat.size === "number" ? file.stat.size : -1,
			});
		}
		const ms = Date.now() - t0;
		console.info(`[OmniSwitch] Vault map: built ${map.size} in ${ms} ms`);
		return map;
	}

    private getOrCreateHeadingCaches(key: string, persisted: PersistedHeadingEntry[]): HeadingCache[] {
		const cached = this.headingCacheMemo.get(key);
		if (cached) {
			return cached;
		}
		const resolved = this.resolveHeadingCaches(persisted);
		this.headingCacheMemo.set(key, resolved);
		return resolved;
    }

    private flagFullRebuild(reason: string, details?: Record<string, unknown>): void {
        if (this.pendingFullRebuild) {
            return;
        }
        this.pendingFullRebuild = true;
        const extra = details ? ` ${JSON.stringify(details)}` : "";
        console.info(`[OmniSwitch] Full rebuild flagged: reason=${reason}${extra}`);
    }
}
