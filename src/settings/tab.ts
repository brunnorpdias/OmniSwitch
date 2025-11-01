import { App, Plugin, PluginSettingTab, Setting } from "obsidian";
import { DEFAULT_SETTINGS, formatExcludedPaths, parseExcludedPaths, type OmniSwitchSettings } from "./index";

interface SettingsHost {
    settings: OmniSwitchSettings;
    saveSettings(): Promise<void>;
    rebuildIndex(options?: { refreshContent?: boolean }): Promise<void>;
    reconfigureSearchBackend(options?: { fireAndForget?: boolean }): Promise<void>;
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

        // Engine section
        containerEl.createEl("h3", { text: "Engine" });

        const maxSetting = new Setting(containerEl);
        maxSetting.setName("Top results (%)")
            .setDesc("Show a percentage of the best matches.");
        const maxInfo = maxSetting.settingEl.querySelector('.setting-item-info') as HTMLElement ?? maxSetting.settingEl;
        const maxLabel = maxInfo.createDiv({ cls: 'setting-item-description' });
        const applyMaxLabel = (v: number) => maxLabel.setText(`${v}%`);
        const maxInit = this.host.settings.engineTopPercent ?? 20;
        applyMaxLabel(maxInit);
        maxSetting.addSlider((slider) => {
            slider.setLimits(10, 50, 5);
            slider.setValue(maxInit);
            slider.onChange(async (value) => {
                this.host.settings.engineTopPercent = value;
                applyMaxLabel(value);
                await this.host.saveSettings();
            });
        });
        maxSetting.addExtraButton((btn) => btn.setIcon("reset").setTooltip("Reset to 20% ").onClick(async () => {
            this.host.settings.engineTopPercent = 20;
            await this.host.saveSettings();
            this.display();
        }));

        // Tie-break weights (Frequency vs Modified time)
        const weightSetting = new Setting(containerEl);
        weightSetting.setName("Tie break")
            .setDesc("Adjust how ties are ordered. Frequency = times opened, Recency = last modified.");
        const weightInfo = weightSetting.settingEl.querySelector('.setting-item-info') as HTMLElement ?? weightSetting.settingEl;
        const weightLabel = weightInfo.createDiv({ cls: 'setting-item-description' });
        const applyWeightLabel = (v: number) => weightLabel.setText(`${v} / ${100 - v}`);
        const weightInit = this.host.settings.tieBreakFreqPercent ?? 70;
        applyWeightLabel(weightInit);
        weightSetting.addSlider((slider) => {
            slider.setLimits(0, 100, 10);
            slider.setValue(weightInit);
            slider.onChange(async (value) => {
                this.host.settings.tieBreakFreqPercent = value;
                applyWeightLabel(value);
                await this.host.saveSettings();
            });
        });
        weightSetting.addExtraButton((btn) => btn.setIcon("reset").setTooltip("Reset to 70/30").onClick(async () => {
            this.host.settings.tieBreakFreqPercent = 70;
            await this.host.saveSettings();
            this.display();
        }));

        // General section
        containerEl.createEl("h3", { text: "General" });

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

        // Advanced section
        containerEl.createEl("h3", { text: "Advanced" });

        const meiliSection = containerEl.createDiv({ cls: "omniswitch-settings__meili" });
        meiliSection.createEl("h4", { text: "Meilisearch" });

        new Setting(meiliSection)
            .setName("Enable Meilisearch")
            .setDesc("Use Meilisearch for note content and heading search (desktop only).")
            .addToggle((toggle) => {
                toggle.setValue(!!this.host.settings.meilisearchEnabled);
                toggle.onChange(async (value) => {
                    this.host.settings.meilisearchEnabled = value;
                    await this.host.saveSettings();
                    await this.host.reconfigureSearchBackend();
                });
            });

        new Setting(meiliSection)
            .setName("Host")
            .setDesc("Protocol and host of the Meilisearch instance (e.g. http://127.0.0.1:7700).")
            .addText((text) => {
                text.setPlaceholder("http://127.0.0.1:7700");
                text.setValue(this.host.settings.meilisearchHost ?? "");
                text.onChange(async (value) => {
                    this.host.settings.meilisearchHost = value.trim();
                    await this.host.saveSettings();
                });
            });

        new Setting(meiliSection)
            .setName("API key")
            .setDesc("Optional API key for authenticated Meilisearch instances.")
            .addText((text) => {
                text.inputEl.type = "password";
                text.setPlaceholder("Leave blank for public access");
                text.setValue(this.host.settings.meilisearchApiKey ?? "");
                text.onChange(async (value) => {
                    const trimmed = value.trim();
                    this.host.settings.meilisearchApiKey = trimmed.length > 0 ? trimmed : null;
                    await this.host.saveSettings();
                });
            })
            .addExtraButton((btn) =>
                btn
                    .setIcon("reset")
                    .setTooltip("Clear API key")
                    .onClick(async () => {
                        this.host.settings.meilisearchApiKey = null;
                        await this.host.saveSettings();
                        this.display();
                    }));

        new Setting(meiliSection)
            .setName("Notes index")
            .setDesc("UID of the index that stores full note content.")
            .addText((text) => {
                text.setPlaceholder(DEFAULT_SETTINGS.meilisearchNotesIndex ?? "omniswitch-notes");
                text.setValue(this.host.settings.meilisearchNotesIndex ?? DEFAULT_SETTINGS.meilisearchNotesIndex ?? "omniswitch-notes");
                text.onChange(async (value) => {
                    this.host.settings.meilisearchNotesIndex = value.trim() || DEFAULT_SETTINGS.meilisearchNotesIndex;
                    await this.host.saveSettings();
                });
            });

        new Setting(meiliSection)
            .setName("Headings index")
            .setDesc("UID of the index that stores individual headings.")
            .addText((text) => {
                text.setPlaceholder(DEFAULT_SETTINGS.meilisearchHeadingsIndex ?? "omniswitch-headings");
                text.setValue(this.host.settings.meilisearchHeadingsIndex ?? DEFAULT_SETTINGS.meilisearchHeadingsIndex ?? "omniswitch-headings");
                text.onChange(async (value) => {
                    this.host.settings.meilisearchHeadingsIndex = value.trim() || DEFAULT_SETTINGS.meilisearchHeadingsIndex;
                    await this.host.saveSettings();
                });
            });

        new Setting(meiliSection)
            .setName("Apply Meilisearch changes")
            .setDesc("Reconnect to Meilisearch and rebuild the remote indexes now.")
            .addButton((button) =>
                button
                    .setButtonText("Apply & Rebuild")
                    .setCta()
                    .onClick(async () => {
                        button.setDisabled(true);
                        await this.host.reconfigureSearchBackend({ fireAndForget: true });
                        await this.host.rebuildIndex({ refreshContent: false });
                        button.setDisabled(false);
                    }));

        containerEl.createEl("h3", { text: "Advanced" });

        new Setting(containerEl)
            .setName("Rebuild index")
            .setDesc("Rescan the vault now.")
            .addButton((button) =>
                button
                    .setButtonText("Rebuild")
                    .setCta()
                    .onClick(async () => {
                        button.setDisabled(true);
                        await this.host.rebuildIndex({ refreshContent: true });
                        button.setDisabled(false);
                    }),
            );

        const debug = new Setting(containerEl)
            .setName("Debug mode")
            .setDesc("Show live startup logs in the console.")
            .addToggle((toggle) => {
                toggle.setValue(!!this.host.settings.debug);
                toggle.onChange(async (value) => {
                    this.host.settings.debug = value;
                    await this.host.saveSettings();
                });
            });
        debug.settingEl.querySelector(".setting-item-name")?.classList.add("omniswitch-debug-label");
    }

}
