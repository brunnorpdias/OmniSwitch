import { App, Plugin, PluginSettingTab, Setting } from "obsidian";
import { formatExcludedPaths, parseExcludedPaths, type OmniSwitchSettings } from "./index";

interface SettingsHost {
	settings: OmniSwitchSettings;
	saveSettings(): Promise<void>;
	rebuildIndex(): Promise<void>;
}

export class OmniSwitchSettingTab extends PluginSettingTab {
	private readonly host: SettingsHost;

	constructor(app: App, plugin: Plugin & SettingsHost) {
		super(app, plugin);
		this.host = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "OmniSwitch Settings" });

		new Setting(containerEl)
			.setName("Excluded paths")
			.setDesc("List folders or files (one per line) that should never appear in search results.")
			.addTextArea((text) => {
				text.setPlaceholder("Templates/\nArchive/OldNote.md");
				text.setValue(formatExcludedPaths(this.host.settings.excludedPaths));
				text.onChange(async (value) => {
					this.host.settings.excludedPaths = parseExcludedPaths(value);
					await this.host.saveSettings();
				});
				text.inputEl.addClass("omniswitch-settings__textarea");
			});

		new Setting(containerEl)
			.setName("Search engine")
			.setDesc("Fuse (fuzzy), Mini (token), or Hybrid (Fuse for files, Mini for headings - recommended).")
			.addDropdown((dropdown) => {
				dropdown.addOption("fuse", "Fuse.js (Fuzzy)");
				dropdown.addOption("mini", "MiniSearch (Token)");
				dropdown.addOption("hybrid", "Hybrid (Recommended)");
				dropdown.setValue(this.host.settings.searchEngine);
				dropdown.onChange(async (value) => {
					if (value === "mini" || value === "fuse" || value === "hybrid") {
						this.host.settings.searchEngine = value;
					}
					await this.host.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Prebuild both engines")
			.setDesc("Build Fuse and Mini indexes on startup. When off, only the active engine builds and the other builds on first use.")
			.addToggle((toggle) => {
				toggle.setValue(Boolean(this.host.settings.prebuildBothEngines));
				toggle.onChange(async (value) => {
					this.host.settings.prebuildBothEngines = value;
					await this.host.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Force rebuild on startup")
			.setDesc("Always rebuild indexes from scratch instead of loading cached data. Enable this after updates or if experiencing issues.")
			.addToggle((toggle) => {
				toggle.setValue(Boolean(this.host.settings.forceRebuild));
				toggle.onChange(async (value) => {
					this.host.settings.forceRebuild = value;
					await this.host.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Verbose logging")
			.setDesc("Log detailed timing for data load/save and indexing.")
			.addToggle((toggle) => {
				toggle.setValue(Boolean(this.host.settings.verboseLogging));
				toggle.onChange(async (value) => {
					this.host.settings.verboseLogging = value;
					await this.host.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Max results per search")
			.setDesc("Limit the number of results returned by any mode or engine (5–50). Default: 20.")
			.addSlider((slider) => {
				slider.setLimits(5, 50, 1);
				slider.setValue(this.host.settings.maxResults ?? 20);
				slider.setDynamicTooltip();
				slider.onChange(async (value) => {
					this.host.settings.maxResults = Math.min(50, Math.max(5, Math.round(value)));
					await this.host.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Rebuild index")
			.setDesc("Force OmniSwitch to rescan the vault immediately.")
			.addButton((button) =>
				button
					.setButtonText("Rebuild")
					.setCta()
					.onClick(async () => {
						button.setDisabled(true);
						await this.host.rebuildIndex();
						button.setDisabled(false);
					}),
			);
	}

}
