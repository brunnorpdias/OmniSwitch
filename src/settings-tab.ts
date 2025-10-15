import { App, Plugin, PluginSettingTab, Setting } from "obsidian";
import { formatExcludedPaths, parseExcludedPaths, type OmniSwitchSettings } from "./settings";

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
