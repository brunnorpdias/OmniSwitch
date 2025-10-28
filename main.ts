import { Notice, Plugin, TFile } from "obsidian";
import { OmniSwitchSettings, migrateSettings } from "./src/settings";
import { SearchIndex } from "./src/search";
import { OmniSwitchModal, type OmniSwitchModalOptions } from "./src/omni-switch-modal";
import { OmniSwitchSettingTab } from "./src/settings/tab";
import { collectFileLeaves, isNoteExtension } from "./src/search/utils";
import { HeadingSearchIndex } from "./src/headings";

export default class OmniSwitchPlugin extends Plugin {
    settings: OmniSwitchSettings;
    private index: SearchIndex;
    private headingSearch: HeadingSearchIndex | null = null;
    private headingInitPromise: Promise<void> | null = null;
    private usageSaveTimer: number | null = null;
    private startupTimings: { step: string; ms: number }[] = [];

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
        this.headingSearch = new HeadingSearchIndex(this.app, this.manifest.id);
        this.headingSearch.setDebugMode(this.settings.debug === true);
        this.headingSearch.setExcludedPaths(this.settings.excludedPaths);
        this.timing("createIndex", t);

        this.app.workspace.onLayoutReady(() => {
            const tInit = (typeof performance !== "undefined" ? performance.now() : Date.now());
            this.headingInitPromise = (async () => {
                if (!this.headingSearch) return;
                try {
                    await this.headingSearch.initialize();
                    if (this.headingSearch.status.indexed === false) {
                        await this.headingSearch.refresh();
                    }
                } catch (error) {
                    console.warn("OmniSwitch: heading search initialization failed", error);
                }
            })();
            this.headingInitPromise?.finally(() => {
                this.timing("createIndex", tInit);
            });

            const tEvents = (typeof performance !== "undefined" ? performance.now() : Date.now());
            this.registerEvent(this.app.vault.on("create", (abstract) => {
                if (abstract instanceof TFile && this.isNoteFile(abstract)) {
                    this.headingSearch?.markDirty(abstract.path);
                }
                this.markIndexDirty();
            }));
            this.registerEvent(this.app.vault.on("delete", (abstract) => {
                if (abstract instanceof TFile && this.isNoteFile(abstract)) {
                    this.headingSearch?.removePathImmediately(abstract.path);
                }
                this.markIndexDirty();
            }));
            this.registerEvent(this.app.vault.on("rename", (abstract, oldPath) => {
                if (abstract instanceof TFile && this.isNoteFile(abstract)) {
                    this.headingSearch?.markDirty(abstract.path);
                    this.headingSearch?.removePathImmediately(oldPath);
                }
                this.markIndexDirty();
            }));
            this.registerEvent(this.app.vault.on("modify", (abstract) => {
                if (abstract instanceof TFile && this.isNoteFile(abstract)) {
                    this.headingSearch?.markDirty(abstract.path);
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
        await this.ensureHeadingReady();

        let headingProvider = this.headingSearch;
        if (this.settings.debug) {
            console.info("OmniSwitch: openOmniSwitch invoked", {
                mode: options?.initialMode ?? "files",
                headingStatus: headingProvider?.status ?? null
            });
        }
        if (headingProvider && (!headingProvider.status.supported || !headingProvider.status.ready)) {
            headingProvider = null;
        }

        const modalOptions: OmniSwitchModalOptions = {
            ...options,
            excludedPaths: this.settings.excludedPaths,
            debug: this.settings.debug === true,
            maxSuggestions: this.settings.maxSuggestions,
            engineTopPercent: this.settings.engineTopPercent,
            headingSearch: headingProvider,
        };
        if (modalOptions.initialMode === "headings" && !headingProvider) {
            modalOptions.initialMode = "files";
            new Notice("Heading search is unavailable on this platform. Falling back to note search.");
        }
        const modal = new OmniSwitchModal(this.app, () => this.index.getItems(), modalOptions);
        if (headingProvider) {
            const refreshPromise = headingProvider.refresh();
            refreshPromise
                .then(() => {
                    modal.handleHeadingIndexReady();
                })
                .catch((error) => {
                    console.warn("OmniSwitch: heading search refresh failed", error);
                    modal.handleHeadingIndexError(error);
                });
        }
        (modal as unknown as { frequencyMap?: Record<string, number>; freqBoost?: number; modifiedBoost?: number; rerankTopK?: number }).frequencyMap = this.settings.openCounts ?? {};
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

	private async ensureHeadingReady(): Promise<void> {
		if (!this.headingSearch) {
			return;
		}
		if (this.headingInitPromise) {
			if (this.settings.debug) {
				console.info("OmniSwitch: waiting for heading init");
			}
			try {
				await this.headingInitPromise;
			} finally {
				this.headingInitPromise = null;
				if (this.settings.debug) {
					console.info("OmniSwitch: heading init resolved");
				}
			}
		}
	}

	markIndexDirty(): void {
		if (this.index) {
			this.index.markDirty();
		}
	}

    async rebuildIndex(): Promise<void> {
        this.markIndexDirty();
        await this.index.refresh(this.settings);
        if (this.headingSearch) {
            this.headingSearch.markDirty();
            await this.ensureHeadingReady();
            if (this.headingSearch.status.supported) {
                await this.headingSearch.refresh();
            }
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
        if (this.headingSearch) {
            this.headingSearch.setExcludedPaths(this.settings.excludedPaths);
            this.headingSearch.setDebugMode(this.settings.debug === true);
        }
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

        console.groupCollapsed("OmniSwitch Debug");
        console.log("Startup timings (ms):");
        console.table(this.startupTimings.reduce<Record<string, number>>((acc, e) => { acc[e.step] = e.ms; return acc; }, {}));
        console.log("Index refresh time (ms):", Math.round(t1 - t0));
        console.log("Index stats:", { total: items.length, files, notes, attachments: atts, folders, commands });
        console.log("Excluded paths:", this.settings.excludedPaths);
        console.log("Attachment prefix:", ".(ext/category)");
        if (this.headingSearch) {
            console.log("Heading index status:", this.headingSearch.status);
        }
        console.groupEnd();
    }
}
