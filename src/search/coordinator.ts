import type { App, HeadingCache, TAbstractFile } from "obsidian";
import { TFile, TFolder } from "obsidian";
import { FuseEngine, type FileDoc, type HeadingDoc, type CommandDoc, type MinimalFileDoc, type MinimalHeadingDoc, type EngineFileDoc, type EngineHeadingDoc } from "./engines/fuse-engine";
import { MiniSearchEngine } from "./engines/mini-engine";
import type { EngineResult } from "./engines/types";
import { IndexManager } from "./index-manager";
import { StatusBroadcaster, type IndexStatus } from "./status";
import { IndexStore } from "./index-store";
import type { OmniSwitchSettings } from "../settings";
import type { SearchEngineId, SearchHit, SearchItem, FileSearchItem, HeadingSearchItem } from "./types";
import type { OmniSwitchMode } from "./utils";
import { matchesAttachmentExtension, isNoteExtension } from "./utils";
import type { AsPlainObject } from "minisearch";
// no custom normalization; rely on engine behavior
import { isTFile } from "./obsidian-guards";

interface CoordinatorOptions {
	app: App;
	initialSettings: OmniSwitchSettings;
	pluginId: string;
	journal?: {
		initialize(): Promise<void>;
		appendUpsert(entry: { path: string; extension: string; modified: number; size: number; headings: Array<{ text: string; level: number }> }): void;
		appendDelete(path: string): void;
		appendRename(oldPath: string, newPath: string): void;
		loadAllEvents(): Promise<Array<{ v: number; ts: number; op: string; path?: string; ext?: string; mtime?: number; size?: number; headings?: Array<{ text: string; level: number; ord: number }>; oldPath?: string; newPath?: string }>>;
	};
	createNotice?: (message: string) => void;
}

export class SearchCoordinator {
	private settings: OmniSwitchSettings;
	private readonly app: App;
	private readonly pluginId: string;
	private readonly fuseEngine = new FuseEngine();
	private readonly miniEngine = new MiniSearchEngine();
	private readonly status: StatusBroadcaster;
    private indexManager: IndexManager | null = null;
    private readonly indexStore: IndexStore;

	private activeEngine: SearchEngineId;
	private ready = false;

	// Track which engines have current doc indexes
	private filesReady: Record<SearchEngineId, boolean> = { fuse: false, mini: false, hybrid: false };
    private headingsReady: Record<SearchEngineId, boolean> = { fuse: false, mini: false, hybrid: false };

	// Store minimal docs for saving to index store
	private currentFileDocs: MinimalFileDoc[] = [];
	private currentHeadingDocs: MinimalHeadingDoc[] = [];

	// Store command docs for lookup (small enough to keep in memory)
	private commandDocs: CommandDoc[] = [];

	// Cache path→TFile for O(1) lookups (avoids O(n) getAbstractFileByPath calls)
	private fileCache = new Map<string, TFile>();

	// ID mapping: numeric ID ↔ full path (for memory optimization)
	private headingIdMap = new Map<string, string>();  // "12345" → "folder/note.md::5"
	private fileIdMap = new Map<string, string>();      // "5678" → "folder/note.md"
	private reverseHeadingIdMap = new Map<string, string>();  // "folder/note.md::5" → "12345"
	private reverseFileIdMap = new Map<string, string>();      // "folder/note.md" → "5678"
	private nextHeadingId = 0;
	private nextFileId = 0;

    constructor(options: CoordinatorOptions) {
		this.app = options.app;
		this.pluginId = options.pluginId;
		this.settings = {
			...options.initialSettings,
			excludedPaths: [...options.initialSettings.excludedPaths],
		};
		this.activeEngine = this.settings.searchEngine ?? "fuse";
        this.status = new StatusBroadcaster({
            createNotice: options.createNotice,
        });
        this.indexStore = new IndexStore(options.app, options.pluginId);

		// IndexManager will be created lazily in slow path only
    }

    async initialize(): Promise<void> {
        const tInit = Date.now();
        let fuseTimeMs = 0;
        let miniTimeMs = 0;
        console.info("[OmniSwitch] === Coordinator Initialize: START ===");

        // Initialize index store
        const tStore0 = Date.now();
        await this.indexStore.initialize();
        const storeMs = Date.now() - tStore0;
        console.info(`[OmniSwitch] Coordinator: IndexStore.initialize() in ${storeMs} ms`);

        // Determine which engines to load
        // Note: hybrid mode loads only what it needs (Fuse files + Mini headings)
        const prebuildBoth = this.activeEngine === "hybrid" ? false : (this.settings.prebuildBothEngines ?? true);

        // Try to load persisted indexes
        let idMaps = null;
        let persisted = null;  // Fallback for non-hybrid modes
        if (this.settings.forceRebuild) {
            console.info("[OmniSwitch] Coordinator: Force rebuild enabled, skipping persisted indexes");
            // Clear old persisted indexes to avoid conflicts
            await this.indexStore.clearIndexes();
        } else {
            if (this.activeEngine === "hybrid") {
                // HYBRID MODE: Load directly from disk (optimized path)
                idMaps = await this.loadIdMapsFromDisk();

                if (idMaps) {
                    // Fast path: Load indexes directly
                    console.info("[OmniSwitch] Coordinator: Fast load path (hybrid, direct loading)");
                    this.status.announce("loading_indexes");
                }
            } else {
                // NON-HYBRID MODES: Use IndexStore (not yet optimized)
                const tLoad0 = Date.now();
                const engine = prebuildBoth ? 'both' : this.activeEngine;
                persisted = await this.indexStore.loadIndexes(engine);
                const loadMs = Date.now() - tLoad0;

                if (persisted) {
                    console.info(`[OmniSwitch] Coordinator: Loaded persisted indexes in ${loadMs} ms`);
                    this.status.announce("loading_indexes");
                    console.info("[OmniSwitch] Coordinator: Fast load path (via IndexStore)");
                }
            }
        }

        // Create IndexManager (needed for slow path building and incremental updates)
        let needsSlowPath = !idMaps && !persisted;

        if (needsSlowPath) {
            // Slow path: Build from scratch via index manager
            console.info("[OmniSwitch] === Coordinator: SLOW PATH - Building from scratch ===");
            this.status.announce("indexing_vault");
        }

        // Always create IndexManager (needed even in fast path for incremental updates)
        this.indexManager = new IndexManager({
            app: this.app,
            status: this.status,
            getSettings: () => this.settings,
            onFilesUpdated: () => { /* engines updated after build */ },
            onCommandsUpdated: () => this.rebuildCommandDocs(),
            onFullRebuildComplete: () => this.handleFullRebuildComplete(),
            onEngineFileUpsert: (path) => this.applyEngineUpsert(path),
            onEngineFileRemove: (path) => this.applyEngineRemove(path),
        });

        // Only initialize IndexManager in slow path (triggers full rebuild)
        if (needsSlowPath) {
            const tIndexMgr0 = Date.now();
            await this.indexManager.initialize();
            const indexMgrMs = Date.now() - tIndexMgr0;
            console.info(`[OmniSwitch] Coordinator: IndexManager.initialize() in ${indexMgrMs} ms`);
        } else {
            console.info(`[OmniSwitch] Coordinator: IndexManager created (will be used for commands and incremental updates)`);
        }

        // Prepare minimal docs arrays
        let minimalFileDocs: MinimalFileDoc[];
        let minimalHeadingDocs: MinimalHeadingDoc[];

        if (idMaps) {
            // HYBRID MODE: FAST PATH (optimized) - Build docs and maps from ID maps loaded directly from disk
            console.info("[OmniSwitch] === Coordinator: FAST PATH (hybrid, optimized) - Loading from disk ===");

            const tMaps0 = Date.now();

            // Build Maps and docs in one pass for efficiency (no intermediate arrays)
            const fileIdMapArray = idMaps.fileIdMap;

            // Allocate arrays with exact size (faster than dynamic growth)
            minimalFileDocs = new Array(fileIdMapArray.length);

            // Build file data structures
            this.fileIdMap = new Map(fileIdMapArray);
            this.reverseFileIdMap = new Map();
            for (let i = 0; i < fileIdMapArray.length; i++) {
                const [numericId, path] = fileIdMapArray[i];
                this.reverseFileIdMap.set(path, numericId);
                // Build minimal doc inline
                minimalFileDocs[i] = {
                    id: path,
                    name: path.split('/').pop() || path,
                    extension: path.split('.').pop() || '',
                    mtime: 0
                };
            }

            // OPTIMIZATION: Hybrid mode loads Mini headings directly via loadJSON()
            // No need to build heading docs or reverse map!
            this.headingIdMap = new Map(idMaps.headingIdMap);
            this.currentHeadingDocs = [];
            minimalHeadingDocs = [];
            console.info(`[OmniSwitch] Coordinator: Skipping heading doc/reverse map build (hybrid mode optimization)`);

            this.currentFileDocs = minimalFileDocs;
            this.nextFileId = idMaps.nextFileId;
            this.nextHeadingId = idMaps.nextHeadingId;

            const mapsMs = Date.now() - tMaps0;
            console.info(`[OmniSwitch] Coordinator: (1/3) Built file docs & ID maps in ${mapsMs} ms (files=${minimalFileDocs.length}, headingIds=${idMaps.headingIdMap.length})`);

            // Build file cache for O(1) path lookups
            const tCache0 = Date.now();
            this.buildFileCache();
            const cacheMs = Date.now() - tCache0;
            console.info(`[OmniSwitch] Coordinator:   ↳ Built file cache in ${cacheMs} ms`);
        } else if (persisted) {
            // NON-HYBRID MODES: FAST PATH (via IndexStore) - Build docs and maps from persisted ID maps
            console.info("[OmniSwitch] === Coordinator: FAST PATH (via IndexStore) - Loading from disk ===");

            const tMaps0 = Date.now();

            // Build Maps and docs in one pass for efficiency (no intermediate arrays)
            const fileIdMapArray = persisted.fileIdMap!;
            const headingIdMapArray = persisted.headingIdMap!;

            // Allocate arrays with exact size (faster than dynamic growth)
            minimalFileDocs = new Array(fileIdMapArray.length);
            minimalHeadingDocs = new Array(headingIdMapArray.length);

            // Build all data structures in parallel loops
            this.fileIdMap = new Map(fileIdMapArray);
            this.reverseFileIdMap = new Map();
            for (let i = 0; i < fileIdMapArray.length; i++) {
                const [numericId, path] = fileIdMapArray[i];
                this.reverseFileIdMap.set(path, numericId);
                // Build minimal doc inline
                minimalFileDocs[i] = {
                    id: path,
                    name: path.split('/').pop() || path,
                    extension: path.split('.').pop() || '',
                    mtime: 0
                };
            }

            this.headingIdMap = new Map(headingIdMapArray);
            this.reverseHeadingIdMap = new Map();
            for (let i = 0; i < headingIdMapArray.length; i++) {
                const [numericId, path] = headingIdMapArray[i];
                this.reverseHeadingIdMap.set(path, numericId);
                // Build minimal doc inline
                minimalHeadingDocs[i] = {
                    id: path,
                    title: ''
                };
            }

            this.currentFileDocs = minimalFileDocs;
            this.currentHeadingDocs = minimalHeadingDocs;
            this.nextFileId = persisted.nextFileId ?? 0;
            this.nextHeadingId = persisted.nextHeadingId ?? 0;

            const mapsMs = Date.now() - tMaps0;
            console.info(`[OmniSwitch] Coordinator: (1/3) Built docs & ID maps in ${mapsMs} ms (files=${minimalFileDocs.length}, headings=${minimalHeadingDocs.length})`);

            // Build file cache for O(1) path lookups
            const tCache0 = Date.now();
            this.buildFileCache();
            const cacheMs = Date.now() - tCache0;
            console.info(`[OmniSwitch] Coordinator:   ↳ Built file cache in ${cacheMs} ms`);
        } else {
            // SLOW PATH: Don't build engines yet - IndexManager is working asynchronously
            // The onFullRebuildComplete callback will build engines when ready
            console.info(`[OmniSwitch] Coordinator: (1/3) Waiting for IndexManager to build docs asynchronously...`);
            // Set empty arrays for now - will be populated by handleFullRebuildComplete()
            minimalFileDocs = [];
            minimalHeadingDocs = [];
            this.currentFileDocs = [];
            this.currentHeadingDocs = [];
        }

        // Build search engines from docs (or load from cache)
        if (needsSlowPath) {
            // SLOW PATH: Skip engine building - will be done in handleFullRebuildComplete()
            console.info(`[OmniSwitch] Coordinator: (2/3) Skipping engine build - waiting for IndexManager...`);
            console.info(`[OmniSwitch] Coordinator: (3/3) Engines will be built when IndexManager completes`);
        } else {
            // FAST PATH: Load engines from disk
            if (this.activeEngine === "hybrid") {
                // Hybrid mode uses direct loading (idMaps)
                if (!idMaps) throw new Error("Hybrid mode fast path but no ID maps");
                // Hybrid mode: Load Fuse for files, Mini for headings (OPTIMIZED)
                console.info(`[OmniSwitch] Coordinator: (2/3) Loading hybrid engines from disk...`);
                this.status.announce("indexing_files");

                const tFuse0 = Date.now();
                await this.loadFuseFilesFromDisk(minimalFileDocs);
                fuseTimeMs += Date.now() - tFuse0;
                console.info(`[OmniSwitch] Coordinator:   ↳ Files loaded in ${Date.now() - tFuse0} ms (Fuse only)`);

                this.status.announce("indexing_headings");

                const tMini1 = Date.now();
                // OPTIMIZATION: Load Mini headings directly using loadJSON() - NO doc conversion!
                await this.loadMiniHeadingsFromDisk();
                miniTimeMs += Date.now() - tMini1;
                console.info(`[OmniSwitch] Coordinator:   ↳ Headings loaded in ${Date.now() - tMini1} ms (Mini only, direct loadJSON)`);
            } else {
                // Non-hybrid modes use IndexStore (persisted)
                if (!persisted) throw new Error("Non-hybrid mode fast path but no persisted data");

                if (prebuildBoth) {
                    // Load both engines for both modes
                    console.info(`[OmniSwitch] Coordinator: (2/3) Loading both engines from disk...`);
                    this.status.announce("indexing_files");
                    const tFiles0 = Date.now();

                    const engineFileDocs = this.toEngineFileDocs(minimalFileDocs);

                    const tFuse0 = Date.now();
                    this.fuseEngine.loadFilesFromIndex(engineFileDocs, persisted.fuseFiles);
                    this.filesReady.fuse = true;
                    fuseTimeMs += Date.now() - tFuse0;

                    const tMini0 = Date.now();
                    this.miniEngine.loadFilesFromJS(engineFileDocs, persisted.miniFiles as AsPlainObject);
                    this.filesReady.mini = true;
                    miniTimeMs += Date.now() - tMini0;
                    console.info(`[OmniSwitch] Coordinator:   ↳ Files loaded in ${Date.now() - tFiles0} ms (Fuse: ${Date.now() - tFuse0}ms, Mini: ${Date.now() - tMini0}ms)`);

                    this.status.announce("indexing_headings");
                    const tHeadings0 = Date.now();

                    const engineHeadingDocs = this.toEngineHeadingDocs(minimalHeadingDocs);

                    const tFuse1 = Date.now();
                    this.fuseEngine.loadHeadingsFromIndex(engineHeadingDocs, persisted.fuseHeadings);
                    this.headingsReady.fuse = true;
                    fuseTimeMs += Date.now() - tFuse1;

                    const tMini1 = Date.now();
                    this.miniEngine.loadHeadingsFromJS(engineHeadingDocs, persisted.miniHeadings as AsPlainObject);
                    this.headingsReady.mini = true;
                    miniTimeMs += Date.now() - tMini1;
                    console.info(`[OmniSwitch] Coordinator:   ↳ Headings loaded in ${Date.now() - tHeadings0} ms (Fuse: ${Date.now() - tFuse1}ms, Mini: ${Date.now() - tMini1}ms)`);
                } else if (this.activeEngine === "mini") {
                    // Mini-only mode
                    console.info(`[OmniSwitch] Coordinator: (2/3) Loading Mini engine from disk...`);
                    this.status.announce("indexing_files");
                    const tMini0 = Date.now();
                    const engineFileDocs = this.toEngineFileDocs(minimalFileDocs);
                    this.miniEngine.loadFilesFromJS(engineFileDocs, persisted.miniFiles as AsPlainObject);
                    this.filesReady.mini = true;
                    console.info(`[OmniSwitch] Coordinator:   ↳ Files loaded in ${Date.now() - tMini0} ms`);

                    this.status.announce("indexing_headings");
                    const tMini1 = Date.now();
                    const engineHeadingDocs = this.toEngineHeadingDocs(minimalHeadingDocs);
                    this.miniEngine.loadHeadingsFromJS(engineHeadingDocs, persisted.miniHeadings as AsPlainObject);
                    this.headingsReady.mini = true;
                    miniTimeMs = Date.now() - tMini0;
                    console.info(`[OmniSwitch] Coordinator:   ↳ Headings loaded in ${Date.now() - tMini1} ms`);
                } else {
                    // Fuse-only mode
                    console.info(`[OmniSwitch] Coordinator: (2/3) Loading Fuse engine from disk...`);
                    this.status.announce("indexing_files");
                    const tFuse0 = Date.now();
                    const engineFileDocs = this.toEngineFileDocs(minimalFileDocs);
                    this.fuseEngine.loadFilesFromIndex(engineFileDocs, persisted.fuseFiles);
                    this.filesReady.fuse = true;
                    console.info(`[OmniSwitch] Coordinator:   ↳ Files loaded in ${Date.now() - tFuse0} ms`);

                    this.status.announce("indexing_headings");
                    const tFuse1 = Date.now();
                    const engineHeadingDocs = this.toEngineHeadingDocs(minimalHeadingDocs);
                    this.fuseEngine.loadHeadingsFromIndex(engineHeadingDocs, persisted.fuseHeadings);
                    this.headingsReady.fuse = true;
                    fuseTimeMs = Date.now() - tFuse0;
                    console.info(`[OmniSwitch] Coordinator:   ↳ Headings loaded in ${Date.now() - tFuse1} ms`);
                }
            }
        }

        // Index commands (only in fast path)
        // Note: rebuildCommandList() triggers onCommandsUpdated callback which calls rebuildCommandDocs()
        if (!needsSlowPath) {
            // FAST PATH: Initialize commands list
            console.info(`[OmniSwitch] Coordinator: (3/3) Initializing commands...`);
            const tCommands0 = Date.now();

            // Initialize commands from Obsidian (triggers onCommandsUpdated callback -> rebuildCommandDocs())
            if (this.indexManager) {
                this.indexManager.rebuildCommandList();
                // Note: Commands are now indexed via the onCommandsUpdated callback (no duplicate indexing)

                const commandsMs = Date.now() - tCommands0;
                const commandDocs = this.indexManager.getCommandDocs();
                console.info(`[OmniSwitch] Coordinator:   ↳ Commands ready in ${commandsMs} ms (count=${commandDocs.length})`);

                if (commandDocs.length === 0) {
                    console.info(`[OmniSwitch] Coordinator:   ↳ Commands will be indexed when workspace layout is ready`);
                }
            } else {
                console.warn("[OmniSwitch] Coordinator: IndexManager not available for commands");
            }
        }

        this.ready = true;
        this.status.announce("ready");

        const totalMs = Date.now() - tInit;
        const mode = prebuildBoth ? "BOTH" : this.activeEngine.toUpperCase();

        // Separate timing report by engine mode
        if (prebuildBoth && fuseTimeMs > 0 && miniTimeMs > 0) {
            console.info(`[OmniSwitch] === Coordinator Initialize [BOTH]: COMPLETE in ${totalMs} ms (Fuse: ${fuseTimeMs}ms, Mini: ${miniTimeMs}ms) ===`);
        } else if (this.activeEngine === "fuse" && fuseTimeMs > 0) {
            console.info(`[OmniSwitch] === Coordinator Initialize [FUSE-ONLY]: COMPLETE in ${totalMs} ms (Fuse: ${fuseTimeMs}ms) ===`);
        } else if (this.activeEngine === "mini" && miniTimeMs > 0) {
            console.info(`[OmniSwitch] === Coordinator Initialize [MINI-ONLY]: COMPLETE in ${totalMs} ms (Mini: ${miniTimeMs}ms) ===`);
        } else {
            console.info(`[OmniSwitch] === Coordinator Initialize [${mode}]: COMPLETE in ${totalMs} ms ===`);
        }
    }

    private async saveIndexes(): Promise<void> {
        try {
            const fileIdMapArray = Array.from(this.fileIdMap.entries());
            const headingIdMapArray = Array.from(this.headingIdMap.entries());

            console.info(`[OmniSwitch] Coordinator: Saving indexes with ID maps (fileIds=${fileIdMapArray.length}, headingIds=${headingIdMapArray.length}, nextFileId=${this.nextFileId}, nextHeadingId=${this.nextHeadingId})`);

            // Persist engine indexes + ID maps (4 files)
            // NOTE: We don't save fileDocs/headingDocs arrays to save space
            // The ID maps are sufficient to reconstruct paths from numeric IDs
            await this.indexStore.saveIndexes({
                fuseFiles: this.fuseEngine.filesToJSON(),
                fuseHeadings: this.fuseEngine.headingsToJSON(),
                miniFiles: this.miniEngine.filesToJSON(),
                miniHeadings: this.miniEngine.headingsToJSON(),
                // Persist ID maps for numeric ID resolution
                fileIdMap: fileIdMapArray,
                headingIdMap: headingIdMapArray,
                nextFileId: this.nextFileId,
                nextHeadingId: this.nextHeadingId,
            });

            console.info("[OmniSwitch] Coordinator: ✅ ID maps saved successfully");
        } catch (error) {
            console.error("[OmniSwitch] Failed to save indexes", error);
        }
    }


	async shutdown(): Promise<void> {
		console.info("[OmniSwitch] Coordinator shutdown: saving indexes...");
		const t0 = Date.now();
		await this.saveIndexes();
		const ms = Date.now() - t0;
		console.info(`[OmniSwitch] Coordinator shutdown: saved in ${ms} ms`);
	}

	getStatus(): IndexStatus | null {
		return this.status.status;
	}

    getStatusMessage(): string | null {
        const current = this.status.status;
        return current ? this.status.getMessage(current) : null;
    }

    getMaxResults(): number {
        const n = Math.round(this.settings.maxResults ?? 20);
        return Math.min(50, Math.max(5, Number.isFinite(n) ? n : 20));
    }

	setEngine(engine: SearchEngineId): void {
		if (this.activeEngine === engine) {
			return;
		}

		const oldEngine = this.activeEngine;
		this.activeEngine = engine;

		// Rebuild if new engine not ready
		// For hybrid: check Fuse for files, Mini for headings
		// For others: check that engine for both
		if (engine === "hybrid") {
			if (!this.filesReady.fuse) {
				this.rebuildFileDocs();
			}
			if (!this.headingsReady.mini) {
				this.rebuildHeadingDocs();
			}
		} else if (engine === "mini") {
			if (!this.filesReady.mini) {
				this.rebuildFileDocs();
			}
			if (!this.headingsReady.mini) {
				this.rebuildHeadingDocs();
			}
		} else {
			// fuse
			if (!this.filesReady.fuse) {
				this.rebuildFileDocs();
			}
			if (!this.headingsReady.fuse) {
				this.rebuildHeadingDocs();
			}
		}

		// If not prebuilding both, clear old engine to save memory
		const prebuildBoth = this.settings.prebuildBothEngines ?? true;
		if (!prebuildBoth) {
			this.clearEngine(oldEngine);
		}
	}

	getEngine(): SearchEngineId {
		return this.activeEngine;
	}

	applySettings(settings: OmniSwitchSettings): void {
		const previous = this.settings;
		const engineChanged = settings.searchEngine !== previous.searchEngine;
		const excludedChanged = !this.areExcludedPathsEqual(settings.excludedPaths, previous.excludedPaths);

		this.settings = {
			...settings,
			excludedPaths: [...settings.excludedPaths],
		};

		if (engineChanged && settings.searchEngine) {
			// Use setEngine to properly handle engine switching
			this.setEngine(settings.searchEngine);
		}

		if (excludedChanged && this.indexManager) {
			this.indexManager.handleSettingsChanged();
		}
	}

	getItems(): SearchItem[] {
		if (!this.ready) {
			return [];
		}
		const items: SearchItem[] = [];

		// Add file items (use O(1) cache lookup)
		for (const f of this.currentFileDocs) {
			const file = this.fileCache.get(f.id);
			if (file) {
				items.push({ type: "file", file });
			}
		}

		// Add folder items (get dynamically from vault)
		const allFiles = this.app.vault.getAllLoadedFiles();
		for (const f of allFiles) {
			if (f instanceof TFolder) {
				items.push({ type: "folder", folder: f });
			}
		}

		return items;
	}

	async rebuild(): Promise<void> {
		if (!this.indexManager) return;
		this.indexManager.requestFullRebuild();
	}

	/**
	 * Get suggestions for empty query (used for initial display)
	 */
	getSuggestions(mode: OmniSwitchMode, limit: number, extensionFilter?: string | null): SearchHit[] {
		// Select engine based on mode when in hybrid mode
		let engine;
		if (this.activeEngine === "hybrid") {
			// Hybrid: Use Mini for headings/commands, Fuse for files
			engine = (mode === "headings" || mode === "commands") ? this.miniEngine : this.fuseEngine;
		} else {
			engine = this.activeEngine === "mini" ? this.miniEngine : this.fuseEngine;
		}

		switch (mode) {
			case "commands": {
				// Return all commands (already in memory, cheap)
				return this.commandDocs.slice(0, limit).map(doc => ({
					item: doc.item,
					score: 1.0,
					engine: this.activeEngine
				}));
			}
			case "headings": {
				// Return first N headings from current docs
				const headingHits: SearchHit[] = [];
				for (const doc of this.currentHeadingDocs) {
					if (headingHits.length >= limit) break;
					const resolved = this.resolveHeadingId(doc.id);
					if (resolved) {
						const item: HeadingSearchItem = { type: "heading", file: resolved.file, heading: resolved.heading };
						headingHits.push({ item, score: 1.0, engine: this.activeEngine });
					}
				}
				return headingHits;
			}
			case "attachments": {
				// Return first N attachments from current docs, filtered by extension
				const attachmentHits: SearchHit[] = [];
				for (const doc of this.currentFileDocs) {
					// Filter by extension/category if specified
					if (!matchesAttachmentExtension(doc.extension, extensionFilter ?? null)) continue;
					if (attachmentHits.length >= limit) break;
					// Use O(1) cache lookup instead of O(n) getAbstractFileByPath
					const file = this.fileCache.get(doc.id);
					if (file) {
						const item: FileSearchItem = { type: "file", file };
						attachmentHits.push({ item, score: 1.0, engine: this.activeEngine });
					}
				}
				return attachmentHits;
			}
			default:
				return [];
		}
	}

	search(mode: OmniSwitchMode, query: string, extensionFilter: string | null): SearchHit[] {
		const t0 = performance.now();
		const trimmed = query.trim();
		if (trimmed.length === 0) {
			return [];
		}

		// Select engine based on mode when in hybrid mode
		let engine;
		let engineName: string;
		if (this.activeEngine === "hybrid") {
			// Hybrid: Use Mini for headings/commands (faster), Fuse for files
			const useMini = (mode === "headings" || mode === "commands");
			engine = useMini ? this.miniEngine : this.fuseEngine;
			engineName = useMini ? "Mini" : "Fuse";
		} else {
			engine = this.activeEngine === "mini" ? this.miniEngine : this.fuseEngine;
			engineName = this.activeEngine === "mini" ? "Mini" : "Fuse";
		}

		const limit = this.getMaxResults();

		switch (mode) {
            case "commands": {
                console.log(`[Coordinator] Commands search: query="${trimmed}", engineName=${engineName}, commandDocsCount=${this.commandDocs.length}`);
                const tEngine0 = performance.now();
                const results = engine.searchCommands(trimmed, limit);
                const engineMs = performance.now() - tEngine0;
                console.log(`[Coordinator]   Engine returned ${results.length} results:`, results.slice(0, 3).map(r => ({ id: r.id, score: r.score })));

                const tMap0 = performance.now();
                const hits = this.mapCommandResults(results);
                const mapMs = performance.now() - tMap0;
                console.log(`[Coordinator]   Mapped to ${hits.length} hits`);

                const totalMs = performance.now() - t0;
                console.log(`[Coordinator] Commands search [${engineName}]: total=${totalMs.toFixed(1)}ms engine=${engineMs.toFixed(1)}ms map=${mapMs.toFixed(1)}ms results=${hits.length}`);
                return hits;
            }
            case "headings": {
                const tEngine0 = performance.now();
                const results = engine.searchHeadings(trimmed, limit);
                const engineMs = performance.now() - tEngine0;

                const tMap0 = performance.now();
                const hits = this.mapHeadingResults(results);
                const mapMs = performance.now() - tMap0;

                const totalMs = performance.now() - t0;
                console.log(`[Coordinator] Headings search [${engineName}]: total=${totalMs.toFixed(1)}ms engine=${engineMs.toFixed(1)}ms map=${mapMs.toFixed(1)}ms results=${hits.length}`);
                return hits;
            }
            case "attachments": {
                console.log(`[Coordinator] Attachments search: query="${trimmed}", extensionFilter="${extensionFilter}"`);
                const tEngine0 = performance.now();
                const results = engine.searchFiles(trimmed, limit);
                const engineMs = performance.now() - tEngine0;

                const tMap0 = performance.now();
                const mapped = this.mapFileResults(results);
                const mapMs = performance.now() - tMap0;
                console.log(`[Coordinator]   Mapped ${mapped.length} files from engine results`);

                const tFilter0 = performance.now();
                let passCount = 0;
                let failCount = 0;
                const filtered = mapped.filter((hit) => {
                    const file = hit.item.type === "file" ? hit.item.file : null;
                    if (!file) return false;
                    const matches = matchesAttachmentExtension(file.extension, extensionFilter);
                    if (matches) passCount++;
                    else failCount++;
                    // Log first few failures for debugging
                    if (!matches && failCount <= 5) {
                        console.log(`[Coordinator]   ❌ Filtered: "${file.basename}.${file.extension}" (ext="${file.extension}", filter="${extensionFilter}")`);
                    }
                    return matches;
                }).slice(0, limit);
                const filterMs = performance.now() - tFilter0;
                console.log(`[Coordinator]   Filter results: ${passCount} passed, ${failCount} filtered out`);

                const totalMs = performance.now() - t0;
                console.log(`[Coordinator] Attachments search [${engineName}]: total=${totalMs.toFixed(1)}ms engine=${engineMs.toFixed(1)}ms map=${mapMs.toFixed(1)}ms filter=${filterMs.toFixed(1)}ms results=${filtered.length}`);

                if (filtered.length > 0) {
                    return filtered;
                }

                // Fallback: lightweight substring scan over minimal docs
                const q = trimmed.toLowerCase();
                const attachments = this.currentFileDocs.filter((d) =>
                    matchesAttachmentExtension(d.extension, extensionFilter));
                const scanned = q.length === 0
                    ? []
                    : attachments.filter((d) =>
                        d.name.toLowerCase().includes(q) || d.id.toLowerCase().includes(q))
                        .slice(0, limit)
                        .map((d) => ({ id: d.id, score: 0.5 }));
                console.log(`[Coordinator] Attachments fallback: ${scanned.length} results from substring scan`);
                return this.mapFileResults(scanned);
            }
            case "files":
            default: {
                const tEngine0 = performance.now();
                const results = engine.searchFiles(trimmed, limit);
                const engineMs = performance.now() - tEngine0;

                const tMap0 = performance.now();
                const mapped = this.mapFileResults(results);
                const mapMs = performance.now() - tMap0;

                const tFilter0 = performance.now();
                const filtered = mapped.filter((hit) => {
                    const file = hit.item.type === "file" ? hit.item.file : null;
                    return file && isNoteExtension(file.extension);
                }).slice(0, limit);
                const filterMs = performance.now() - tFilter0;

                const totalMs = performance.now() - t0;
                console.log(`[Coordinator] Files search [${engineName}]: total=${totalMs.toFixed(1)}ms engine=${engineMs.toFixed(1)}ms map=${mapMs.toFixed(1)}ms filter=${filterMs.toFixed(1)}ms results=${filtered.length}`);
                return filtered;
            }
        }
    }

	handleVaultCreate(file: TAbstractFile): void {
		if (!this.indexManager) return;
		if (isTFile(file)) {
			this.indexManager.queueVaultChange({ type: "created", path: file.path });
			return;
		}
		this.indexManager.notifyFolderMutation();
	}

	handleVaultModify(file: TAbstractFile): void {
		if (!this.indexManager) return;
		if (isTFile(file)) {
			this.indexManager.queueVaultChange({ type: "modified", path: file.path });
			return;
		}
		this.indexManager.notifyFolderMutation();
	}

	handleVaultDelete(file: TAbstractFile): void {
		if (!this.indexManager) return;
		if (isTFile(file)) {
			this.indexManager.queueVaultChange({ type: "deleted", path: file.path });
			return;
		}
		this.indexManager.notifyFolderMutation();
	}

	handleVaultRename(file: TAbstractFile, oldPath: string): void {
		if (!this.indexManager) return;
		if (isTFile(file)) {
			this.indexManager.queueVaultChange({ type: "renamed", path: file.path, oldPath });
			return;
		}
		this.indexManager.notifyFolderMutation();
	}

	handleMetadataChange(file: TFile): void {
		if (!this.indexManager) return;
		this.indexManager.queueVaultChange({ type: "modified", path: file.path });
	}

	/**
	 * Map command search results (look up by ID)
	 */
	private mapCommandResults(results: EngineResult[]): SearchHit[] {
		const hits: SearchHit[] = [];
		for (const r of results) {
			const doc = this.commandDocs.find(cmd => cmd.id === r.id);
			if (doc) {
				hits.push({ item: doc.item, score: r.score, engine: this.activeEngine });
			} else {
				console.warn(`[Coordinator] mapCommandResults: No command doc found for id="${r.id}". Available IDs:`, this.commandDocs.slice(0, 3).map(c => c.id));
			}
		}
		return hits;
	}

	/**
	 * Map file search results (resolve numeric ID→path→TFile using ID map + cache)
	 */
	private mapFileResults(results: EngineResult[]): SearchHit[] {
		const hits: SearchHit[] = [];
		for (const r of results) {
			// Step 1: Resolve numeric ID to full path using ID map
			const fullPath = this.fileIdMap.get(r.id);
			if (!fullPath) continue;

			// Step 2: Use O(1) cache lookup for TFile
			const file = this.fileCache.get(fullPath);
			if (file) {
				const item: FileSearchItem = { type: "file", file };
				hits.push({ item, score: r.score, engine: this.activeEngine });
			}
		}
		return hits;
	}

	/**
	 * Map heading search results (resolve numeric ID→path→TFile+HeadingCache using ID map)
	 */
	private mapHeadingResults(results: EngineResult[]): SearchHit[] {
		const t0 = performance.now();
		const hits: SearchHit[] = [];
		let resolveTimeTotal = 0;
		let resolveCount = 0;

		for (const r of results) {
			const tResolve = performance.now();
			// Step 1: Resolve numeric ID to full path using ID map
			const fullPath = this.headingIdMap.get(r.id);
			if (!fullPath) continue;

			// Step 2: Resolve path to TFile + HeadingCache
			const resolved = this.resolveHeadingId(fullPath);
			resolveTimeTotal += performance.now() - tResolve;
			resolveCount++;

			if (resolved) {
				const item: HeadingSearchItem = { type: "heading", file: resolved.file, heading: resolved.heading };
				hits.push({ item, score: r.score, engine: this.activeEngine });
			}
		}

		const totalMs = performance.now() - t0;
		const avgResolveMs = resolveCount > 0 ? resolveTimeTotal / resolveCount : 0;
		console.log(`[Coordinator] mapHeadingResults: total=${totalMs.toFixed(1)}ms resolutions=${resolveCount} avgResolve=${avgResolveMs.toFixed(2)}ms`);
		return hits;
	}

	/**
	 * Parse heading ID ("path/file.md::0") and resolve to TFile + HeadingCache using cache
	 */
	private resolveHeadingId(id: string): { file: TFile; heading: HeadingCache } | null {
		// Parse "path/file.md::0" format
		const parts = id.split('::');
		if (parts.length !== 2) return null;

		const filePath = parts[0];
		const index = parseInt(parts[1], 10);
		if (isNaN(index)) return null;

		// Use O(1) cache lookup instead of O(n) getAbstractFileByPath
		const file = this.fileCache.get(filePath);
		if (!file) return null;

		// Get heading from metadata cache
		const cache = this.app.metadataCache.getFileCache(file);
		const heading = cache?.headings?.[index];
		if (!heading) return null;

		return { file, heading };
	}

	/**
	 * Build path→TFile cache for O(1) lookups (avoids O(n) getAbstractFileByPath)
	 */
	private buildFileCache(): void {
		this.fileCache.clear();
		for (const doc of this.currentFileDocs) {
			const file = this.app.vault.getAbstractFileByPath(doc.id) as TFile;
			if (file) {
				this.fileCache.set(doc.id, file);
			}
		}
	}

	private rebuildFileDocs(): void {
		// Use cached minimal docs (already loaded from persisted indexes or built in slow path)
		const minimalFileDocs = this.currentFileDocs;

		if (minimalFileDocs.length === 0) {
			console.warn("[OmniSwitch] rebuildFileDocs: No file docs available");
			return;
		}

		// Convert to engine docs with numeric IDs
		const engineFileDocs = this.toEngineFileDocs(minimalFileDocs);

        // In hybrid mode, files use Fuse; otherwise use the active engine
        if (this.activeEngine === "hybrid" || this.activeEngine === "fuse") {
            this.fuseEngine.setFiles(engineFileDocs);
            this.filesReady.fuse = true;
        } else {
            this.miniEngine.setFiles(engineFileDocs);
            this.filesReady.mini = true;
        }
	}

    private rebuildCommandDocs(): void {
		if (!this.indexManager) return;
        const commandDocs = this.indexManager.getCommandDocs();
        this.commandDocs = commandDocs;  // Store for ID lookup
        this.status.announce("indexing_commands");

        // Index commands in the engine that will be used for command search
        if (this.activeEngine === "hybrid" || this.activeEngine === "mini") {
            this.miniEngine.setCommands(commandDocs);
        } else {
            this.fuseEngine.setCommands(commandDocs);
        }
    }

	private rebuildHeadingDocs(): void {
		// Use cached minimal docs (already loaded from persisted indexes or built in slow path)
		const minimalHeadingDocs = this.currentHeadingDocs;

		if (minimalHeadingDocs.length === 0) {
			console.warn("[OmniSwitch] rebuildHeadingDocs: No heading docs available");
			return;
		}

		// Convert to engine docs with numeric IDs
		const engineHeadingDocs = this.toEngineHeadingDocs(minimalHeadingDocs);

		// In hybrid mode, headings use Mini; otherwise use the active engine
		if (this.activeEngine === "hybrid" || this.activeEngine === "mini") {
			this.miniEngine.setHeadings(engineHeadingDocs);
			this.headingsReady.mini = true;
		} else {
			this.fuseEngine.setHeadings(engineHeadingDocs);
			this.headingsReady.fuse = true;
		}
	}

	private clearEngine(engine: SearchEngineId): void {
		// Clear old engine's indexes to free memory
		console.info(`[OmniSwitch] Coordinator: Clearing ${engine} engine indexes to save memory`);
		this.filesReady[engine] = false;
		this.headingsReady[engine] = false;
		// Note: The actual engine objects remain, but they'll be rebuilt when needed
	}

    /**
     * Called when IndexManager completes full rebuild (force rebuild or manual rebuild)
     */
    private async handleFullRebuildComplete(): Promise<void> {
        console.info("[OmniSwitch] === SLOW PATH: IndexManager build complete, building engines ===");
        const t0 = Date.now();

		if (!this.indexManager) {
			console.error("[OmniSwitch] Coordinator: IndexManager not initialized");
			return;
		}

        // Clear ID maps before rebuilding (ensure fresh state)
        this.fileIdMap.clear();
        this.headingIdMap.clear();
        this.reverseFileIdMap.clear();
        this.reverseHeadingIdMap.clear();
        this.nextFileId = 0;
        this.nextHeadingId = 0;
        console.info("[OmniSwitch] Coordinator: Cleared ID maps for fresh rebuild");

        // Step 1: Get docs from IndexManager and convert to minimal
        console.info("[OmniSwitch] Coordinator: (1/4) Converting docs to minimal format...");
        const tConvert0 = Date.now();
        const fileDocs = this.indexManager.getFileDocs();
        const headingDocs = this.indexManager.getHeadingDocs();

		const minimalFileDocs = fileDocs.map((f: FileDoc) => {
			const file = this.app.vault.getAbstractFileByPath(f.id) as TFile;
			return {
				id: f.id,
				name: f.name,
				extension: f.extension,
				mtime: file ? file.stat.mtime : 0
			};
		});

		const minimalHeadingDocs = headingDocs.map((h: HeadingDoc) => {
			const parts = h.id.split('#');
			const pathAndIndex = parts.length > 1 ? `${parts[0]}::${parts[1].split('::')[1]}` : h.id;
			return {
				id: pathAndIndex,
				title: h.title
			};
		});

		this.currentFileDocs = minimalFileDocs;
		this.currentHeadingDocs = minimalHeadingDocs;
        const convertMs = Date.now() - tConvert0;
        console.info(`[OmniSwitch] Coordinator:   ↳ Converted ${minimalFileDocs.length} files, ${minimalHeadingDocs.length} headings in ${convertMs} ms`);

        // Build file cache for O(1) path lookups
        const tCache0 = Date.now();
        this.buildFileCache();
        const cacheMs = Date.now() - tCache0;
        console.info(`[OmniSwitch] Coordinator:   ↳ Built file cache in ${cacheMs} ms`);

        // Step 2: Build file engines
        console.info("[OmniSwitch] Coordinator: (2/4) Building file engines...");
        const tFiles0 = Date.now();
        this.status.announce("indexing_files");
        const engineFileDocs = this.toEngineFileDocs(minimalFileDocs);
        this.fuseEngine.setFiles(engineFileDocs);
        this.miniEngine.setFiles(engineFileDocs);
        this.filesReady.fuse = true;
        this.filesReady.mini = true;
        const filesMs = Date.now() - tFiles0;
        console.info(`[OmniSwitch] Coordinator:   ↳ File engines built in ${filesMs} ms`);

        // Step 3: Build heading engines
        console.info("[OmniSwitch] Coordinator: (3/4) Building heading engines...");
        const tHeadings0 = Date.now();
        this.status.announce("indexing_headings");

        const engineHeadingDocs = this.toEngineHeadingDocs(minimalHeadingDocs);

        // Build Fuse (fast, synchronous)
        const tFuse = Date.now();
        this.fuseEngine.setHeadings(engineHeadingDocs);
        this.headingsReady.fuse = true;
        const fuseMs = Date.now() - tFuse;
        console.info(`[OmniSwitch] Coordinator:   ↳ Fuse headings built in ${fuseMs} ms`);

        // Build Mini (use async with chunk size 4000 for non-blocking)
        const tMini = Date.now();
        await this.miniEngine.setHeadingsAsync(engineHeadingDocs);
        this.headingsReady.mini = true;
        const miniMs = Date.now() - tMini;
        console.info(`[OmniSwitch] Coordinator:   ↳ Mini headings built in ${miniMs} ms`);

        const headingsMs = Date.now() - tHeadings0;
        console.info(`[OmniSwitch] Coordinator:   ↳ Total heading engines built in ${headingsMs} ms`);

        // Step 4: Index commands and save
        console.info("[OmniSwitch] Coordinator: (4/4) Indexing commands and saving...");
        const tFinal0 = Date.now();
        this.status.announce("indexing_commands");
        const commandDocs = this.indexManager.getCommandDocs();
        this.commandDocs = commandDocs;
        this.fuseEngine.setCommands(commandDocs);
        this.miniEngine.setCommands(commandDocs);
        console.info(`[OmniSwitch] Coordinator:   ↳ Commands indexed (count=${commandDocs.length})`);

        await this.saveIndexes();
        const finalMs = Date.now() - tFinal0;
        console.info(`[OmniSwitch] Coordinator:   ↳ Commands + save completed in ${finalMs} ms`);

        const totalMs = Date.now() - t0;
        console.info(`[OmniSwitch] === SLOW PATH COMPLETE: Engines built in ${totalMs} ms ===`);

        // Mark as ready
        this.ready = true;
        this.status.announce("ready");
    }


    private applyEngineUpsert(path: string): void {
        const t0 = Date.now();
		if (!this.indexManager) return;
        const fileDoc = this.indexManager.getFileDocs().find((f: FileDoc) => f.path === path);
        const headingDocs = this.indexManager.getHeadingDocs().filter((h: HeadingDoc) => h.path === path);
        let addedFiles = 0;
        let addedHeadings = 0;

        if (fileDoc) {
            // Convert to minimal doc
            const file = this.app.vault.getAbstractFileByPath(fileDoc.id) as TFile;
            const minimalFileDoc: MinimalFileDoc = {
                id: fileDoc.id,
                name: fileDoc.name,
                extension: fileDoc.extension,
                mtime: file ? file.stat.mtime : 0
            };

            // Convert to engine doc with numeric ID
            const engineFileDocs = this.toEngineFileDocs([minimalFileDoc]);

            // Add or replace file doc (removal already handled prior to update when needed)
            this.fuseEngine.addFiles(engineFileDocs);
            this.miniEngine.addFiles(engineFileDocs);

            // Update stored minimal docs
            const idx = this.currentFileDocs.findIndex(f => f.id === path);
            if (idx >= 0) {
                this.currentFileDocs[idx] = minimalFileDoc;
            } else {
                this.currentFileDocs.push(minimalFileDoc);
            }

            // Update file cache
            if (file) {
                this.fileCache.set(path, file);
            }
            addedFiles = 1;
        }

        if (headingDocs.length > 0) {
            // Convert to minimal docs
            const minimalHeadingDocs = headingDocs.map((h: HeadingDoc) => {
                const parts = h.id.split('#');
                const pathAndIndex = parts.length > 1 ? `${parts[0]}::${parts[1].split('::')[1]}` : h.id;
                return {
                    id: pathAndIndex,
                    title: h.title
                };
            });

            // Convert to engine docs with numeric IDs
            const engineHeadingDocs = this.toEngineHeadingDocs(minimalHeadingDocs);

            // Add individual heading docs
            this.fuseEngine.addHeadings(engineHeadingDocs);
            this.miniEngine.addHeadings(engineHeadingDocs);

            // Update stored minimal docs
            this.currentHeadingDocs = this.currentHeadingDocs.filter(h => !h.id.startsWith(path));
            this.currentHeadingDocs.push(...minimalHeadingDocs);
            addedHeadings = minimalHeadingDocs.length;
        }
        const ms = Date.now() - t0;
        console.info(`[OmniSwitch] Engine diff: +files=${addedFiles}, +headings=${addedHeadings} for ${path} in ${ms} ms`);
    }

    private applyEngineRemove(path: string): void {
        const t0 = Date.now();
        // Remove existing docs for this file path before updating
        let removedFiles = 0;
        let removedHeadings = 0;

        // Remove file doc
        const fileDoc = this.currentFileDocs.find(f => f.id === path);
        if (fileDoc) {
            // Get numeric ID from reverse map
            const numericId = this.reverseFileIdMap.get(path);
            if (numericId) {
                // Convert to engine doc for removal
                const engineFileDoc: EngineFileDoc = {
                    id: numericId,
                    name: this.stripExtension(fileDoc.name)
                };
                this.fuseEngine.removeFiles((d) => d.id === numericId);
                this.miniEngine.removeFiles([engineFileDoc]);

                // Clean up ID maps
                this.fileIdMap.delete(numericId);
                this.reverseFileIdMap.delete(path);
            }
            // Update stored minimal docs
            this.currentFileDocs = this.currentFileDocs.filter(f => f.id !== path);
            // Remove from file cache
            this.fileCache.delete(path);
            removedFiles = 1;
        } else {
            // Fallback: look up numeric ID and remove
            const numericId = this.reverseFileIdMap.get(path);
            if (numericId) {
                this.fuseEngine.removeFiles((d) => d.id === numericId);
                this.fileIdMap.delete(numericId);
                this.reverseFileIdMap.delete(path);
            }
            // Remove from file cache anyway
            this.fileCache.delete(path);
        }

        // Remove individual headings for this path
        const headingDocsToRemove = this.currentHeadingDocs.filter(h => h.id.startsWith(path));
        if (headingDocsToRemove.length > 0) {
            // Convert to engine docs for removal
            const engineHeadingDocs: EngineHeadingDoc[] = [];
            for (const h of headingDocsToRemove) {
                const numericId = this.reverseHeadingIdMap.get(h.id);
                if (numericId) {
                    engineHeadingDocs.push({ id: numericId, title: h.title });
                    // Clean up ID maps
                    this.headingIdMap.delete(numericId);
                    this.reverseHeadingIdMap.delete(h.id);
                }
            }
            // Remove using numeric IDs
            const numericIds = engineHeadingDocs.map(d => d.id);
            this.fuseEngine.removeHeadings((d) => numericIds.includes(d.id));
            this.miniEngine.removeHeadings(engineHeadingDocs);
            // Update stored minimal docs
            this.currentHeadingDocs = this.currentHeadingDocs.filter(h => !h.id.startsWith(path));
            removedHeadings = headingDocsToRemove.length;
        } else {
            // Fallback: find all numeric IDs for this path
            const headingIds = Array.from(this.reverseHeadingIdMap.entries())
                .filter(([fullPath]) => fullPath.startsWith(path))
                .map(([fullPath, numericId]) => {
                    this.headingIdMap.delete(numericId);
                    this.reverseHeadingIdMap.delete(fullPath);
                    return numericId;
                });
            if (headingIds.length > 0) {
                this.fuseEngine.removeHeadings((d) => headingIds.includes(d.id));
            }
        }

        const ms = Date.now() - t0;
        console.info(`[OmniSwitch] Engine diff: -files=${removedFiles}, -headings=${removedHeadings} for ${path} in ${ms} ms`);
    }

	/**
	 * Strip file extension from name
	 */
	private stripExtension(name: string): string {
		const lastDot = name.lastIndexOf('.');
		return lastDot > 0 ? name.substring(0, lastDot) : name;
	}

	/**
	 * Convert MinimalFileDocs to EngineFileDocs with numeric IDs
	 */
	private toEngineFileDocs(minimalDocs: MinimalFileDoc[]): EngineFileDoc[] {
		return minimalDocs.map(doc => {
			// Check if we already have an ID for this path
			let numericId = this.reverseFileIdMap.get(doc.id);
			if (!numericId) {
				// Generate new numeric ID
				numericId = String(this.nextFileId++);
				this.fileIdMap.set(numericId, doc.id);
				this.reverseFileIdMap.set(doc.id, numericId);
			}
			return {
				id: numericId,
				name: this.stripExtension(doc.name)
			};
		});
	}

	/**
	 * Convert MinimalHeadingDocs to EngineHeadingDocs with numeric IDs
	 */
	private toEngineHeadingDocs(minimalDocs: MinimalHeadingDoc[]): EngineHeadingDoc[] {
		return minimalDocs.map(doc => {
			// Check if we already have an ID for this path
			let numericId = this.reverseHeadingIdMap.get(doc.id);
			if (!numericId) {
				// Generate new numeric ID
				numericId = String(this.nextHeadingId++);
				this.headingIdMap.set(numericId, doc.id);
				this.reverseHeadingIdMap.set(doc.id, numericId);
			}
			return {
				id: numericId,
				title: doc.title
			};
		});
	}

	private areExcludedPathsEqual(next: string[], prev: string[]): boolean {
		if (next.length !== prev.length) {
			return false;
		}
		const normalizedNext = next.map((entry) => entry.trim()).sort();
		const normalizedPrev = prev.map((entry) => entry.trim()).sort();
		for (let index = 0; index < normalizedNext.length; index += 1) {
			if (normalizedNext[index] !== normalizedPrev[index]) {
				return false;
			}
		}
		return true;
	}

	/**
	 * Helper to get index directory path
	 */
	private getIndexDir(): string {
		return `.obsidian/plugins/${this.pluginId}/indexes`;
	}

	/**
	 * Load ID maps directly from disk (bypasses IndexStore)
	 * Returns null if file doesn't exist or version mismatch
	 */
	private async loadIdMapsFromDisk(): Promise<{
		fileIdMap: Array<[string, string]>;
		headingIdMap: Array<[string, string]>;
		nextFileId: number;
		nextHeadingId: number;
	} | null> {
		const t0 = Date.now();
		const adapter = this.app.vault.adapter;
		const path = `${this.getIndexDir()}/id-maps.json`;

		try {
			if (!(await adapter.exists(path))) {
				console.info("[OmniSwitch] Coordinator: No id-maps.json found");
				return null;
			}

			const content = await adapter.read(path);
			const data = JSON.parse(content) as {
				version: number;
				fileIdMap: Array<[string, string]>;
				headingIdMap: Array<[string, string]>;
				nextFileId: number;
				nextHeadingId: number;
			};

			// Check version (must be 6)
			if (data.version !== 6) {
				console.info(`[OmniSwitch] Coordinator: Invalid version in id-maps.json (expected=6, got=${data.version})`);
				return null;
			}

			const ms = Date.now() - t0;
			console.info(`[OmniSwitch] Coordinator: Loaded ID maps in ${ms} ms (fileIds=${data.fileIdMap.length}, headingIds=${data.headingIdMap.length})`);

			return {
				fileIdMap: data.fileIdMap,
				headingIdMap: data.headingIdMap,
				nextFileId: data.nextFileId,
				nextHeadingId: data.nextHeadingId,
			};
		} catch (error) {
			console.warn("[OmniSwitch] Coordinator: Failed to load ID maps", error);
			return null;
		}
	}

	/**
	 * Load Mini headings index directly from disk using MiniSearch.loadJSON()
	 * v6: Reads raw JSON string and passes directly to MiniSearch (no intermediate parsing)
	 * Returns false if file doesn't exist
	 */
	private async loadMiniHeadingsFromDisk(): Promise<boolean> {
		const t0 = Date.now();
		const adapter = this.app.vault.adapter;
		const version = 6;  // Current version
		const path = `${this.getIndexDir()}/mini-headings-v${version}.json`;

		try {
			if (!(await adapter.exists(path))) {
				console.info(`[OmniSwitch] Coordinator: No ${path} found`);
				return false;
			}

			// v6: Read raw JSON string and pass directly to MiniSearch
			// NO intermediate parsing! This saves ~3000ms
			const jsonString = await adapter.read(path);
			this.miniEngine.loadHeadingsFromJSON(jsonString);
			this.headingsReady.mini = true;

			const ms = Date.now() - t0;
			console.info(`[OmniSwitch] Coordinator: Loaded Mini headings index in ${ms} ms (direct load, no parse)`);

			return true;
		} catch (error) {
			console.warn("[OmniSwitch] Coordinator: Failed to load Mini headings index", error);
			return false;
		}
	}

	/**
	 * Load Fuse files index directly from disk
	 * Returns false if file doesn't exist or version mismatch
	 */
	private async loadFuseFilesFromDisk(minimalFileDocs: MinimalFileDoc[]): Promise<boolean> {
		const t0 = Date.now();
		const adapter = this.app.vault.adapter;
		const path = `${this.getIndexDir()}/fuse-files.json`;

		try {
			if (!(await adapter.exists(path))) {
				console.info("[OmniSwitch] Coordinator: No fuse-files.json found");
				return false;
			}

			const content = await adapter.read(path);
			const data = JSON.parse(content) as { version: number; index: unknown };

			if (data.version !== 6) {
				console.info(`[OmniSwitch] Coordinator: Invalid version in fuse-files.json (expected=6, got=${data.version})`);
				return false;
			}

			const engineFileDocs = this.toEngineFileDocs(minimalFileDocs);
			this.fuseEngine.loadFilesFromIndex(engineFileDocs, data.index);
			this.filesReady.fuse = true;

			const ms = Date.now() - t0;
			console.info(`[OmniSwitch] Coordinator: Loaded Fuse files index in ${ms} ms`);

			return true;
		} catch (error) {
			console.warn("[OmniSwitch] Coordinator: Failed to load Fuse files index", error);
			return false;
		}
	}
}
