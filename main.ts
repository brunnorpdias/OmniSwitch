import { Notice, Plugin } from "obsidian";
import { OmniSwitchSettings, migrateSettings } from "./src/settings";
import { SearchIndex } from "./src/search";
import { OmniSwitchModal, type OmniSwitchModalOptions } from "./src/omni-switch-modal";
import { OmniSwitchSettingTab } from "./src/settings/tab";
import { collectFileLeaves } from "./src/search/utils";

export default class OmniSwitchPlugin extends Plugin {
    settings: OmniSwitchSettings;
    private index: SearchIndex;
    private usageSaveTimer: number | null = null;
    private startupTimings: { step: string; ms: number }[] = [];

    private timing(step: string, start: number): void {
        const end = (typeof performance !== "undefined" ? performance.now() : Date.now());
        this.startupTimings.push({ step, ms: Math.round(end - start) });
    }

	private readonly handleVaultMutation = (): void => {
		this.markIndexDirty();
	};

	private readonly handleMetadataChange = (): void => {
		this.markIndexDirty();
	};

    async onload(): Promise<void> {
        const tAll = (typeof performance !== "undefined" ? performance.now() : Date.now());

        let t = (typeof performance !== "undefined" ? performance.now() : Date.now());
        await this.loadSettings();
        this.timing("loadSettings", t);

        t = (typeof performance !== "undefined" ? performance.now() : Date.now());
        this.index = new SearchIndex(this.app);
        this.timing("createIndex", t);

        t = (typeof performance !== "undefined" ? performance.now() : Date.now());
        this.registerEvent(this.app.vault.on("create", this.handleVaultMutation));
        this.registerEvent(this.app.vault.on("delete", this.handleVaultMutation));
        this.registerEvent(this.app.vault.on("rename", this.handleVaultMutation));
        this.registerEvent(this.app.vault.on("modify", this.handleVaultMutation));
        this.registerEvent(this.app.metadataCache.on("changed", this.handleMetadataChange));
        this.registerEvent(this.app.metadataCache.on("resolved", this.handleMetadataChange));
        this.timing("registerEvents", t);

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

        // headings mode removed

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
        const modal = new OmniSwitchModal(this.app, () => this.index.getItems(), {
            ...options,
            excludedPaths: this.settings.excludedPaths,
            debug: this.settings.debug === true,
            maxSuggestions: this.settings.maxSuggestions,
            engineTopPercent: this.settings.engineTopPercent,
        });
        // Pass frequency map + weight to modal for ranking
        (modal as unknown as { frequencyMap?: Record<string, number>; freqBoost?: number; modifiedBoost?: number; rerankTopK?: number }).frequencyMap = this.settings.openCounts ?? {};
        const freqWeight = Math.max(0, Math.min(100, this.settings.tieBreakFreqPercent ?? 70)) / 100;
        (modal as unknown as { freqBoost?: number }).freqBoost = freqWeight;
        (modal as unknown as { modifiedBoost?: number }).modifiedBoost = 1 - freqWeight;
        // rerankTopK now computed dynamically in the modal from engineTopPercent or maxSuggestions fallback
        modal.open();
    }

	private async ensureLayoutReady(): Promise<void> {
		if (this.app.workspace.layoutReady) {
			return;
		}
		await new Promise<void>((resolve) => {
			this.app.workspace.onLayoutReady(resolve);
		});
	}

	markIndexDirty(): void {
		if (this.index) {
			this.index.markDirty();
		}
	}

    async rebuildIndex(): Promise<void> {
        this.markIndexDirty();
        await this.index.refresh(this.settings);
        new Notice("OmniSwitch index rebuilt.");
    }

	async loadSettings(): Promise<void> {
		const stored = await this.loadData();
		this.settings = migrateSettings(stored);
	}

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
        this.markIndexDirty();
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
        console.groupEnd();
    }
}
