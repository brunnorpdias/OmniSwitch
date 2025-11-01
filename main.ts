import { Notice, Plugin, TFile } from "obsidian";
import { DEFAULT_SETTINGS, OmniSwitchSettings, migrateSettings } from "./src/settings";
import { SearchIndex } from "./src/search";
import { OmniSwitchModal, type OmniSwitchModalOptions } from "./src/omni-switch-modal";
import { OmniSwitchSettingTab } from "./src/settings/tab";
import { collectFileLeaves, isNoteExtension } from "./src/search/utils";
import { MeilisearchIndex } from "./src/search/meilisearch-index";

export default class OmniSwitchPlugin extends Plugin {
    settings: OmniSwitchSettings;
    private index: SearchIndex;
    private contentIndex: MeilisearchIndex | null = null;
    private contentInitPromise: Promise<void> | null = null;
    private usageSaveTimer: number | null = null;
    private startupTimings: { step: string; ms: number }[] = [];
    private lastContentError: string | null = null;
	private get debugEnabled(): boolean {
		return this.settings?.debug === true;
	}

	private logDebug(...data: unknown[]): void {
		if (this.debugEnabled) {
			console.log(...data);
		}
	}

	private logInfo(...data: unknown[]): void {
		if (this.debugEnabled) {
			console.info(...data);
		}
	}

    private logWarn(...data: unknown[]): void {
        if (this.debugEnabled) {
            console.warn(...data);
        }
    }

	private trackContentInit(promise: Promise<void>): Promise<void> {
		const wrapped = promise
			.catch((error) => {
				this.logWarn("OmniSwitch: Meilisearch rebuild failed", error);
			})
			.finally(() => {
				if (this.contentInitPromise === wrapped) {
					this.contentInitPromise = null;
				}
			});
		this.contentInitPromise = wrapped;
		return wrapped;
	}

    private timing(step: string, start: number): void {
        const end = (typeof performance !== "undefined" ? performance.now() : Date.now());
        this.startupTimings.push({ step, ms: Math.round(end - start) });
    }

    async onload(): Promise<void> {
        const tAll = (typeof performance !== "undefined" ? performance.now() : Date.now());

        let t = (typeof performance !== "undefined" ? performance.now() : Date.now());
        await this.loadSettings();
        this.timing("loadSettings", t);

        t = (typeof performance !== "undefined" ? performance.now() : Date.now());
        this.index = new SearchIndex(this.app);
        this.contentIndex = new MeilisearchIndex(this.app);
        this.contentIndex.setDebugMode(this.debugEnabled);
        await this.reconfigureContentIndex(false);
        this.timing("createIndex", t);

		this.app.workspace.onLayoutReady(() => {
			const tInit = (typeof performance !== "undefined" ? performance.now() : Date.now());
			const rebuildPromise = this.reconfigureContentIndex(true, { fireAndForget: true });
			rebuildPromise.finally(() => {
				this.timing("createIndex", tInit);
			});

			const tEvents = (typeof performance !== "undefined" ? performance.now() : Date.now());
            this.registerEvent(this.app.vault.on("create", (abstract) => {
                if (abstract instanceof TFile && this.isNoteFile(abstract)) {
                    this.contentIndex?.markDirty(abstract.path);
                }
                this.markIndexDirty();
            }));
            this.registerEvent(this.app.vault.on("delete", (abstract) => {
                if (abstract instanceof TFile && this.isNoteFile(abstract)) {
                    this.contentIndex?.removePath(abstract.path);
                }
                this.markIndexDirty();
            }));
            this.registerEvent(this.app.vault.on("rename", (abstract, oldPath) => {
                if (abstract instanceof TFile && this.isNoteFile(abstract)) {
                    this.contentIndex?.markDirty(abstract.path);
                    this.contentIndex?.removePath(oldPath);
                }
                this.markIndexDirty();
            }));
            this.registerEvent(this.app.vault.on("modify", (abstract) => {
                if (abstract instanceof TFile && this.isNoteFile(abstract)) {
                    this.contentIndex?.markDirty(abstract.path);
                }
                this.markIndexDirty();
            }));
            this.timing("registerEvents", tEvents);
        });

        t = (typeof performance !== "undefined" ? performance.now() : Date.now());
        this.addCommand({
            id: "omniswitch-open",
            name: "Search vault and commands",
            hotkeys: [{ modifiers: ["Mod"], key: "k" }],
            callback: async () => {
                await this.openOmniSwitch();
            },
        });

		this.addCommand({
			id: "omniswitch-open-files",
			name: "Search vault notes",
			callback: async () => {
				await this.openOmniSwitch({ initialMode: "files" });
			},
		});

		this.addCommand({
			id: "omniswitch-open-headings",
			name: "Search vault headings",
			callback: async () => {
				await this.openOmniSwitch({ initialMode: "headings" });
			},
		});

		this.addCommand({
			id: "omniswitch-open-commands",
			name: "Search vault commands",
			callback: async () => {
				await this.openOmniSwitch({ initialMode: "commands" });
			},
		});

        this.addCommand({
            id: "omniswitch-open-attachments",
            name: "Search vault attachments",
            callback: async () => {
                await this.openOmniSwitch({ initialMode: "attachments" });
            },
        });
        this.timing("registerCommands", t);

		this.addCommand({
			id: "omniswitch-debug-log-open-tabs",
			name: "Omni Switch: Log open tabs",
			callback: async () => {
				await this.ensureLayoutReady();
				const mainRoot = this.app.workspace.rootSplit;
				const entries = collectFileLeaves(this.app).map((entry) => {
					const root = entry.leaf.getRoot();
					const location = root === mainRoot ? "main" : "aux";
					return {
						viewType: `${entry.viewType} (${location})`,
						path: entry.path,
					};
				});
				if (!this.debugEnabled) {
					new Notice("Enable OmniSwitch debug mode to log open tabs.");
					return;
				}
				console.table(entries);
				new Notice(`Logged ${entries.length} open file tab${entries.length === 1 ? "" : "s"} to the console.`);
			},
		});

        t = (typeof performance !== "undefined" ? performance.now() : Date.now());
        this.addSettingTab(new OmniSwitchSettingTab(this.app, this));
        this.timing("addSettingTab", t);

        // Track file open frequency for ranking
        t = (typeof performance !== "undefined" ? performance.now() : Date.now());
        this.registerEvent(this.app.workspace.on("file-open", (file) => {
            if (!file) return;
            const path = file.path;
            const map = (this.settings.openCounts ??= {});
            map[path] = (map[path] ?? 0) + 1;
            // Debounce saves to avoid excessive disk writes
            if (this.usageSaveTimer) window.clearTimeout(this.usageSaveTimer);
            this.usageSaveTimer = window.setTimeout(() => {
                this.saveSettings().catch(() => {/* noop */});
            }, 2000);
        }));
        this.timing("initUsageTracker", t);

        // If debug is enabled, schedule index build after layout ready (non-blocking)
        if (this.settings.debug === true) {
            this.app.workspace.onLayoutReady(async () => {
                const tRefresh = (typeof performance !== "undefined" ? performance.now() : Date.now());
                try {
                    await this.index.refresh(this.settings);
                } finally {
                    this.timing("initialIndexRefresh", tRefresh);
                }
            });
        }

        this.timing("onloadTotal", tAll);
    }

	onunload(): void {
		// Nothing to clean up beyond registered events.
	}

    private async openOmniSwitch(options?: OmniSwitchModalOptions): Promise<void> {
        await this.ensureLayoutReady();
        await this.index.refresh(this.settings);
        await this.ensureContentReady(false);

        let provider =
            this.contentIndex && this.settings.meilisearchEnabled ? this.contentIndex : null;
        if (provider && !provider.status.reachable) {
            provider = null;
        }
        this.logInfo("OmniSwitch: openOmniSwitch invoked", {
            mode: options?.initialMode ?? "files",
            meilisearch: provider?.status ?? null,
        });

        const modalOptions: OmniSwitchModalOptions = {
            ...options,
            excludedPaths: this.settings.excludedPaths,
            debug: this.settings.debug === true,
            maxSuggestions: this.settings.maxSuggestions,
            engineTopPercent: this.settings.engineTopPercent,
            contentSearch: provider,
        };
        if (modalOptions.initialMode === "headings" && !provider) {
            modalOptions.initialMode = "files";
            new Notice("Heading search requires Meilisearch. Falling back to note search.");
        }
        const modal = new OmniSwitchModal(this.app, () => this.index.getItems(), modalOptions);
        (modal as unknown as { frequencyMap?: Record<string, number>; freqBoost?: number; modifiedBoost?: number }).frequencyMap = this.settings.openCounts ?? {};
        const freqWeight = Math.max(0, Math.min(100, this.settings.tieBreakFreqPercent ?? 70)) / 100;
        (modal as unknown as { freqBoost?: number }).freqBoost = freqWeight;
        (modal as unknown as { modifiedBoost?: number }).modifiedBoost = 1 - freqWeight;
        modal.open();
    }

    private isNoteFile(file: TFile): boolean {
        const ext = file.extension?.toLowerCase() ?? "";
        return isNoteExtension(ext);
    }

	private async ensureLayoutReady(): Promise<void> {
		if (this.app.workspace.layoutReady) {
			return;
		}
		await new Promise<void>((resolve) => {
			this.app.workspace.onLayoutReady(resolve);
		});
	}

	private async reconfigureContentIndex(rebuild: boolean, options?: { fireAndForget?: boolean }): Promise<void> {
		if (!this.contentIndex) {
			return;
		}
		this.contentIndex.setExcludedPaths(this.settings.excludedPaths);
		this.contentIndex.setDebugMode(this.debugEnabled);
		if (!this.settings.meilisearchEnabled) {
			this.contentIndex.setCredentials(null);
			return;
		}
		const host =
			this.settings.meilisearchHost && this.settings.meilisearchHost.trim().length > 0
				? this.settings.meilisearchHost.trim()
				: DEFAULT_SETTINGS.meilisearchHost!;
		const notesIndex =
			this.settings.meilisearchNotesIndex && this.settings.meilisearchNotesIndex.trim().length > 0
				? this.settings.meilisearchNotesIndex.trim()
				: DEFAULT_SETTINGS.meilisearchNotesIndex!;
		const headingsIndex =
			this.settings.meilisearchHeadingsIndex && this.settings.meilisearchHeadingsIndex.trim().length > 0
				? this.settings.meilisearchHeadingsIndex.trim()
				: DEFAULT_SETTINGS.meilisearchHeadingsIndex!;

		this.contentIndex.setCredentials({
			host,
			apiKey: this.settings.meilisearchApiKey ?? null,
			notesIndex,
			headingsIndex,
		});
		try {
			await this.contentIndex.initialize();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (this.lastContentError !== message) {
				this.logWarn("OmniSwitch: initialization failed", message);
				this.lastContentError = message;
			}
			return;
		}
		const status = this.contentIndex.status;
		if (!status.reachable) {
			const message = status.lastError ? `Meilisearch unreachable: ${status.lastError}` : "Meilisearch unreachable.";
			if (this.lastContentError !== message) {
				new Notice(message);
				this.lastContentError = message;
			}
			return;
		}
		this.lastContentError = null;
		if (rebuild) {
			const tracked = this.trackContentInit(this.contentIndex.requestRebuild());
			if (options?.fireAndForget) {
				return tracked;
			}
			await tracked;
		}
		return;
	}

	private async ensureContentReady(waitForCompletion = false): Promise<void> {
		if (!this.contentIndex || !this.settings.meilisearchEnabled) {
			return;
		}
		if (this.contentInitPromise) {
			if (!waitForCompletion) {
				this.logInfo("OmniSwitch: Meilisearch rebuild in progress; continuing without waiting.");
				return;
			}
			this.logInfo("OmniSwitch: waiting for Meilisearch init");
			await this.contentInitPromise;
			this.logInfo("OmniSwitch: Meilisearch init resolved");
		}
	}

	markIndexDirty(): void {
		if (this.index) {
			this.index.markDirty();
		}
	}

    async rebuildIndex(options?: { refreshContent?: boolean }): Promise<void> {
        const refreshContent = options?.refreshContent ?? true;
        this.markIndexDirty();
        await this.index.refresh(this.settings);
        if (refreshContent && this.contentIndex && this.settings.meilisearchEnabled) {
            await this.reconfigureContentIndex(true);
        }
        new Notice("OmniSwitch index rebuilt.");
    }

	async loadSettings(): Promise<void> {
		const stored = await this.loadData();
		this.settings = migrateSettings(stored);
	}

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
        this.markIndexDirty();
        await this.reconfigureContentIndex(false);
        this.contentIndex?.setDebugMode(this.debugEnabled);
    }

	async reconfigureSearchBackend(options?: { fireAndForget?: boolean }): Promise<void> {
		if (options?.fireAndForget) {
			void this.reconfigureContentIndex(true, options);
			return;
		}
		await this.reconfigureContentIndex(true, options);
	}

    async debugLog(): Promise<void> {
        const t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
        await this.index.refresh(this.settings);
        const t1 = (typeof performance !== "undefined" ? performance.now() : Date.now());

        const items = this.index.getItems();
        let files = 0, notes = 0, atts = 0, commands = 0, folders = 0;
        for (const it of items) {
            switch (it.type) {
                case "file":
                    files++;
                    if (it.file.extension && it.file.extension.toLowerCase() !== "md" && it.file.extension.toLowerCase() !== "canvas" && it.file.extension.toLowerCase() !== "base") {
                        atts++;
                    } else {
                        notes++;
                    }
                    break;
                case "command": commands++; break;
                case "folder": folders++; break;
                
            }
        }

        if (!this.debugEnabled) {
            new Notice("Enable OmniSwitch debug mode to print diagnostics to the console.");
            return;
        }
        console.groupCollapsed("OmniSwitch Debug");
        console.log("Startup timings (ms):");
        console.table(this.startupTimings.reduce<Record<string, number>>((acc, e) => { acc[e.step] = e.ms; return acc; }, {}));
        console.log("Index refresh time (ms):", Math.round(t1 - t0));
        console.log("Index stats:", { total: items.length, files, notes, attachments: atts, folders, commands });
        console.log("Excluded paths:", this.settings.excludedPaths);
        console.log("Attachment prefix:", ".(ext/category)");
        console.log("Meilisearch status:", this.contentIndex?.status ?? null);
        console.groupEnd();
    }
}
