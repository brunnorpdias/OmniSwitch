import { Notice, Plugin } from "obsidian";
import { OmniSwitchSettings, migrateSettings } from "./src/settings";
import { SearchIndex } from "./src/search";
import { OmniSwitchModal, type OmniSwitchModalOptions } from "./src/omni-switch-modal";
import { OmniSwitchSettingTab } from "./src/settings/tab";
import { collectFileLeaves } from "./src/search/utils";

export default class OmniSwitchPlugin extends Plugin {
	settings: OmniSwitchSettings;
	private index: SearchIndex;

	private readonly handleVaultMutation = (): void => {
		this.markIndexDirty();
	};

	private readonly handleMetadataChange = (): void => {
		this.markIndexDirty();
	};

	async onload(): Promise<void> {
		await this.loadSettings();

		this.index = new SearchIndex(this.app);

		this.registerEvent(this.app.vault.on("create", this.handleVaultMutation));
		this.registerEvent(this.app.vault.on("delete", this.handleVaultMutation));
		this.registerEvent(this.app.vault.on("rename", this.handleVaultMutation));
		this.registerEvent(this.app.vault.on("modify", this.handleVaultMutation));
		this.registerEvent(this.app.metadataCache.on("changed", this.handleMetadataChange));
		this.registerEvent(this.app.metadataCache.on("resolved", this.handleMetadataChange));

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

	onunload(): void {
		// Nothing to clean up beyond registered events.
	}

	private async openOmniSwitch(options?: OmniSwitchModalOptions): Promise<void> {
		await this.index.refresh(this.settings);
		new OmniSwitchModal(this.app, () => this.index.getItems(), options).open();
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
}
