import type { App } from "obsidian";
import type { MinimalFileDoc, MinimalHeadingDoc } from "./engines/fuse-engine";

/**
 * Index persistence manager for storing and loading pre-built search indexes.
 * Uses 5-file structure: one file per engine per type (files/headings) + separate ID maps file.
 */

interface IndexPaths {
	root: string;
	fuseFiles: string;
	fuseHeadings: string;
	miniFiles: string;
	miniHeadings: string;  // v6: Raw MiniSearch index JSON (no wrapper)
	idMaps: string;
}

interface IndexFile {
	version: number;
	docs?: MinimalFileDoc[] | MinimalHeadingDoc[]; // Optional: not saved in v4+
	index: unknown;
}

interface IdMapsFile {
	version: number;
	// ID maps for numeric ID resolution
	fileIdMap: Array<[string, string]>;
	headingIdMap: Array<[string, string]>;
	nextFileId: number;
	nextHeadingId: number;
}

export class IndexStore {
	private readonly app: App;
	private readonly pluginId: string;
	private paths: IndexPaths | null = null;
	private static readonly VERSION = 6;  // Bumped to store mini-headings as raw JSON (no wrapper) for direct MiniSearch loading
	private static readonly DIR_NAME = "indexes";

	constructor(app: App, pluginId: string) {
		this.app = app;
		this.pluginId = pluginId;
	}

	async initialize(): Promise<void> {
		this.paths = await this.createPaths();
	}

	/**
	 * Save engine indexes and ID maps to disk (5 files)
	 * Note: Does NOT save doc arrays to reduce file size (80-85% savings)
	 * ID maps are stored separately for faster loading
	 */
	async saveIndexes(data: {
		fuseFiles: unknown;
		fuseHeadings: unknown;
		miniFiles: unknown;
		miniHeadings: unknown;
		// ID maps for numeric ID resolution
		fileIdMap: Array<[string, string]>;
		headingIdMap: Array<[string, string]>;
		nextFileId: number;
		nextHeadingId: number;
	}): Promise<void> {
		const t0 = Date.now();
		if (!this.paths) {
			this.paths = await this.createPaths();
		}

		const adapter = this.app.vault.adapter;

		try {
			console.info(`[OmniSwitch] IndexStore: Saving indexes (fileIdMap=${data.fileIdMap.length}, headingIdMap=${data.headingIdMap.length})...`);

			// Save 5 files in parallel (ID maps in separate file for faster loading)
			// v6: mini-headings is saved as RAW MiniSearch JSON (no wrapper) for direct loading
			await Promise.all([
				adapter.write(this.paths.fuseFiles, JSON.stringify({
					version: IndexStore.VERSION,
					index: data.fuseFiles,
				} as IndexFile)),
				adapter.write(this.paths.fuseHeadings, JSON.stringify({
					version: IndexStore.VERSION,
					index: data.fuseHeadings
				} as IndexFile)),
				adapter.write(this.paths.miniFiles, JSON.stringify({
					version: IndexStore.VERSION,
					index: data.miniFiles
				} as IndexFile)),
				// v6: Save mini-headings as RAW JSON (no version wrapper)
				adapter.write(this.paths.miniHeadings, JSON.stringify(data.miniHeadings)),
				adapter.write(this.paths.idMaps, JSON.stringify({
					version: IndexStore.VERSION,
					fileIdMap: data.fileIdMap,
					headingIdMap: data.headingIdMap,
					nextFileId: data.nextFileId,
					nextHeadingId: data.nextHeadingId,
				} as IdMapsFile))
			]);

			const ms = Date.now() - t0;
			console.info(`[OmniSwitch] IndexStore: Saved 5 index files in ${ms} ms total`);
		} catch (error) {
			console.error("[OmniSwitch] IndexStore: Failed to save", error);
			throw error;
		}
	}

	/**
	 * Load engine indexes from disk
	 * @param engine Which engine to load: 'fuse', 'mini', 'hybrid', or 'both'
	 * - 'fuse': Load Fuse files + Fuse headings
	 * - 'mini': Load Mini files + Mini headings
	 * - 'hybrid': Load Fuse files + Mini headings (Fuse for files/commands, Mini for headings)
	 * - 'both': Load all 4 indexes
	 * Returns null if indexes don't exist or loading fails
	 */
	async loadIndexes(engine: 'fuse' | 'mini' | 'hybrid' | 'both'): Promise<{
		fuseFiles?: unknown;
		fuseHeadings?: unknown;
		miniFiles?: unknown;
		miniHeadings?: unknown;
		// Raw ID map arrays (not converted to MinimalDocs - Coordinator will handle that)
		fileIdMap?: Array<[string, string]>;
		headingIdMap?: Array<[string, string]>;
		nextFileId?: number;
		nextHeadingId?: number;
	} | null> {
		const t0 = Date.now();
		if (!this.paths) {
			this.paths = await this.createPaths();
		}

		const adapter = this.app.vault.adapter;

		try {
			let fuseFiles: unknown | undefined;
			let fuseHeadings: unknown | undefined;
			let miniFiles: unknown | undefined;
			let miniHeadings: unknown | undefined;
			let fileIdMap: Array<[string, string]> | undefined;
			let headingIdMap: Array<[string, string]> | undefined;
			let nextFileId: number | undefined;
			let nextHeadingId: number | undefined;

			// Check if ID maps file exists first (required)
			const paths = this.paths; // Store reference for TypeScript
			if (!(await adapter.exists(paths.idMaps))) {
				console.info("[OmniSwitch] IndexStore: No id-maps.json found");
				return null;
			}

			// Load everything in parallel for maximum speed
			const loadPromises: Promise<void>[] = [];

			// 1. Load ID maps
			loadPromises.push((async () => {
				const t = Date.now();
				const content = await adapter.read(paths.idMaps);
				const data: IdMapsFile = JSON.parse(content);

				if (data.version !== IndexStore.VERSION) {
					console.info(`[OmniSwitch] IndexStore: Invalid version in id-maps.json (expected=${IndexStore.VERSION}, got=${data.version})`);
					throw new Error("Version mismatch");
				}

				fileIdMap = data.fileIdMap;
				headingIdMap = data.headingIdMap;
				nextFileId = data.nextFileId;
				nextHeadingId = data.nextHeadingId;

				console.info(`[OmniSwitch] IndexStore: Loaded ID maps in ${Date.now() - t} ms (fileIds=${fileIdMap?.length ?? 0}, headingIds=${headingIdMap?.length ?? 0})`);
			})());

			// 2. Load engine indexes (in parallel with ID maps)
			if (engine === 'fuse' || engine === 'hybrid' || engine === 'both') {
				// Load Fuse files
				loadPromises.push((async () => {
					if (await adapter.exists(paths.fuseFiles)) {
						const t = Date.now();
						const content = await adapter.read(paths.fuseFiles);
						const data: IndexFile = JSON.parse(content);

						if (data.version !== IndexStore.VERSION) {
							console.info(`[OmniSwitch] IndexStore: Invalid version in fuse-files.json (expected=${IndexStore.VERSION}, got=${data.version})`);
							throw new Error("Version mismatch");
						}

						fuseFiles = data.index;
						console.info(`[OmniSwitch] IndexStore: Loaded Fuse files in ${Date.now() - t} ms`);
					} else {
						throw new Error("fuse-files.json not found");
					}
				})());

				// Load Fuse headings (only for fuse and both modes, NOT hybrid)
				if (engine === 'fuse' || engine === 'both') {
					loadPromises.push((async () => {
						if (await adapter.exists(paths.fuseHeadings)) {
							const t = Date.now();
							const content = await adapter.read(paths.fuseHeadings);
							const data: IndexFile = JSON.parse(content);

							if (data.version !== IndexStore.VERSION) {
								console.info(`[OmniSwitch] IndexStore: Invalid version in fuse-headings.json`);
								throw new Error("Version mismatch");
							}

							fuseHeadings = data.index;
							console.info(`[OmniSwitch] IndexStore: Loaded Fuse headings in ${Date.now() - t} ms`);
						}
					})());
				}
			}

			if (engine === 'mini' || engine === 'both') {
				// Load Mini files (only for mini and both modes, NOT hybrid)
				loadPromises.push((async () => {
					if (await adapter.exists(paths.miniFiles)) {
						const t = Date.now();
						const content = await adapter.read(paths.miniFiles);
						const data: IndexFile = JSON.parse(content);

						if (data.version !== IndexStore.VERSION) {
							console.info(`[OmniSwitch] IndexStore: Invalid version in mini-files.json`);
							throw new Error("Version mismatch");
						}

						miniFiles = data.index;
						console.info(`[OmniSwitch] IndexStore: Loaded Mini files in ${Date.now() - t} ms`);
					} else if (engine === 'mini') {
						throw new Error("mini-files.json not found");
					}
				})());
			}

			if (engine === 'mini' || engine === 'hybrid' || engine === 'both') {
				// Load Mini headings (needed for mini, hybrid, and both modes)
				loadPromises.push((async () => {
					if (await adapter.exists(paths.miniHeadings)) {
						const t = Date.now();
						const content = await adapter.read(paths.miniHeadings);
						// v6: mini-headings is stored as RAW JSON (no wrapper)
						// Version check is implicit in filename (mini-headings-v6.json)
						miniHeadings = JSON.parse(content);
						console.info(`[OmniSwitch] IndexStore: Loaded Mini headings in ${Date.now() - t} ms`);
					}
				})());
			}

			// Wait for all parallel loads to complete
			await Promise.all(loadPromises);

			const ms = Date.now() - t0;
			console.info(`[OmniSwitch] IndexStore: Loaded ${engine} indexes in ${ms} ms total (parallel)`);

			return {
				fuseFiles,
				fuseHeadings,
				miniFiles,
				miniHeadings,
				fileIdMap,
				headingIdMap,
				nextFileId,
				nextHeadingId,
			};
		} catch (error) {
			console.warn("[OmniSwitch] IndexStore: Failed to load indexes", error);
			return null;
		}
	}

	/**
	 * Clear persisted indexes
	 */
	async clearIndexes(): Promise<void> {
		if (!this.paths) {
			this.paths = await this.createPaths();
		}

		const adapter = this.app.vault.adapter;

		const filesToRemove = [
			this.paths.fuseFiles,
			this.paths.fuseHeadings,
			this.paths.miniFiles,
			this.paths.miniHeadings,
			this.paths.idMaps
		];

		for (const file of filesToRemove) {
			if (await adapter.exists(file)) {
				await adapter.remove(file);
			}
		}

		console.info("[OmniSwitch] IndexStore: Cleared all indexes");
	}

	private async createPaths(): Promise<IndexPaths> {
		const adapter = this.app.vault.adapter;
		const pluginRoot = `.obsidian/plugins/${this.pluginId}`;
		const root = `${pluginRoot}/${IndexStore.DIR_NAME}`;

		// Ensure directory exists
		if (!(await adapter.exists(root))) {
			await adapter.mkdir(root);
		}

		return {
			root,
			fuseFiles: `${root}/fuse-files.json`,
			fuseHeadings: `${root}/fuse-headings.json`,
			miniFiles: `${root}/mini-files.json`,
			miniHeadings: `${root}/mini-headings-v${IndexStore.VERSION}.json`,  // v6: Versioned, raw JSON
			idMaps: `${root}/id-maps.json`,
		};
	}
}
