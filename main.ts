import { Notice, Plugin, type TAbstractFile, type TFile } from "obsidian";
import { OmniSwitchSettings, migrateSettings } from "./src/settings";
import { SearchCoordinator } from "./src/search";
import { JournalStore } from "./src/search/persist-journal";
import { OmniSwitchModal, type OmniSwitchModalOptions } from "./src/omni-switch-modal";
import { OmniSwitchSettingTab } from "./src/settings/tab";
import { collectFileLeaves } from "./src/search/utils";

interface PersistedState {
	settings: OmniSwitchSettings;
}

export default class OmniSwitchPlugin extends Plugin {
	settings: OmniSwitchSettings;
	private search: SearchCoordinator | null = null;
	private searchInitPromise: Promise<void> | null = null;
	private searchInitialized = false;

	private readonly handleVaultCreate = (file: TAbstractFile): void => {
		this.search?.handleVaultCreate(file);
	};

	private readonly handleVaultModify = (file: TAbstractFile): void => {
		this.search?.handleVaultModify(file);
	};

	private readonly handleVaultDelete = (file: TAbstractFile): void => {
		this.search?.handleVaultDelete(file);
	};

	private readonly handleVaultRename = (file: TAbstractFile, oldPath: string): void => {
		this.search?.handleVaultRename(file, oldPath);
	};

	private readonly handleMetadataChange = (file: TFile): void => {
		this.search?.handleMetadataChange(file);
	};

	async onload(): Promise<void> {
		await this.loadState();
		this.bootstrapSearch();

		this.registerEvent(this.app.vault.on("create", this.handleVaultCreate));
		this.registerEvent(this.app.vault.on("delete", this.handleVaultDelete));
		this.registerEvent(this.app.vault.on("rename", this.handleVaultRename));
		this.registerEvent(this.app.vault.on("modify", this.handleVaultModify));
		this.registerEvent(this.app.metadataCache.on("changed", this.handleMetadataChange));

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

		this.addSettingTab(new OmniSwitchSettingTab(this.app, this));
	}

	async onunload(): Promise<void> {
		// Save corpus state before unload
		if (this.search) {
			await this.search.shutdown();
		}
	}

    private async openOmniSwitch(options?: OmniSwitchModalOptions): Promise<void> {
        try {
            await this.ensureSearchInitialized();
            if (!this.search) {
                new Notice("OmniSwitch is still starting up. Please try again in a moment.");
                return;
            }
            console.info("[OmniSwitch] UI: opening modal…");
            const modal = new OmniSwitchModal(this.app, this.search, options);
            modal.open();
        } catch (e) {
            console.error("[OmniSwitch] UI: failed to open modal", e);
            new Notice("OmniSwitch failed to open. Check console for details.");
        }
    }

	private async ensureLayoutReady(): Promise<void> {
		if (this.app.workspace.layoutReady) {
			return;
		}
		await new Promise<void>((resolve) => {
			this.app.workspace.onLayoutReady(resolve);
		});
	}

	async rebuildIndex(): Promise<void> {
		await this.ensureSearchInitialized();
		await this.search?.rebuild();
		new Notice("OmniSwitch index rebuilt.");
	}

	private async initializeSearchCoordinator(): Promise<void> {
		if (this.search) {
			return;
		}

		// Initialize NDJSON journal (writer); IndexManager will call initialize()
		// Use the actual folder name for data storage, not manifest.id
		const pluginFolderName = "obsidian-omniswitch-plugin";
		const journal = new JournalStore(this.app, pluginFolderName);

		this.search = new SearchCoordinator({
			app: this.app,
			pluginId: pluginFolderName,
			initialSettings: this.settings,
			journal,
			createNotice: (message) => new Notice(message),
		});

		await this.search.initialize();
		this.searchInitialized = true;
	}

	async saveSettings(): Promise<void> {
		await this.persistState();
		if (this.search) {
			const cloned: OmniSwitchSettings = {
				...this.settings,
				excludedPaths: [...this.settings.excludedPaths],
			};
			this.search.applySettings(cloned);
		}
	}

	private async loadState(): Promise<void> {
		const raw = await this.loadData();
		if (raw && typeof raw === "object" && "settings" in (raw as Record<string, unknown>)) {
			const record = raw as Record<string, unknown>;
			this.settings = migrateSettings(record.settings);
			return;
		}
		this.settings = migrateSettings(raw);
	}

	private async persistState(): Promise<void> {
		const state: PersistedState = {
			settings: this.settings,
		};
		await this.saveData(state);
	}

	private bootstrapSearch(): void {
		if (this.searchInitialized || this.searchInitPromise) {
			return;
		}

		this.searchInitPromise = (async () => {
			try {
				await this.ensureLayoutReady();
				await this.initializeSearchCoordinator();
			} catch (error) {
				console.error("[OmniSwitch] Failed to initialize search", error);
			} finally {
				this.searchInitPromise = null;
			}
		})();
	}

	private async ensureSearchInitialized(): Promise<void> {
		if (this.searchInitialized && this.search) {
			return;
		}

		if (!this.searchInitPromise) {
			this.bootstrapSearch();
		}

		if (this.searchInitPromise) {
			await this.searchInitPromise;
		}
	}
}
