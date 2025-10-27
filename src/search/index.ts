import { App, TFile, TFolder } from "obsidian";
import type { OmniSwitchSettings } from "../settings";
import { SearchItem, CommandSearchItem, FileSearchItem, FolderSearchItem } from "./types";
import { getCommandManager } from "../obsidian-helpers";
import { buildExclusionMatchers, isExcluded } from "./utils";

export class SearchIndex {
    private items: SearchItem[] = [];
    private dirty = true;
    private matchers = [] as ReturnType<typeof buildExclusionMatchers>;

	constructor(private readonly app: App) {}

	markDirty(): void {
		this.dirty = true;
	}

    async refresh(settings: OmniSwitchSettings): Promise<void> {
        if (!this.dirty) {
            return;
        }
        const debug = (settings as { debug?: boolean }).debug === true;
        const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();

        this.matchers = buildExclusionMatchers(settings.excludedPaths);

        const items: SearchItem[] = [];

        // Commands
        const tCmd = typeof performance !== "undefined" ? performance.now() : Date.now();
        const commandManager = getCommandManager(this.app);
        const commands = commandManager?.listCommands() ?? [];
        for (const command of commands) {
            const commandItem: CommandSearchItem = { type: "command", command };
            items.push(commandItem);
        }
        if (debug) console.log("OmniSwitch: collected commands:", commands.length, "in", Math.round(((typeof performance !== "undefined" ? performance.now() : Date.now()) - tCmd)), "ms");

        // Files (single API call)
        if (debug) console.log("OmniSwitch: walking the vault (getAllLoadedFiles)…");
        const tFiles = typeof performance !== "undefined" ? performance.now() : Date.now();
        const all = this.app.vault.getAllLoadedFiles();
        const files: TFile[] = [];
        for (const af of all) {
            if (af instanceof TFile) files.push(af);
        }
        if (debug) console.log("OmniSwitch: building index from files…", files.length, "files");

        for (const file of files) {
            const fileItem: FileSearchItem = { type: "file", file };
            items.push(fileItem);
        }
        if (debug) console.log("OmniSwitch: files indexed in", Math.round(((typeof performance !== "undefined" ? performance.now() : Date.now()) - tFiles)), "ms");

        // Folders via Obsidian's folder tree (easiest way)
        const tFolders = typeof performance !== "undefined" ? performance.now() : Date.now();
        const folders: TFolder[] = [];
        const appendFolders = (folder: TFolder): void => {
            folders.push(folder);
            for (const child of folder.children) {
                if (child instanceof TFolder) appendFolders(child);
            }
        };
        appendFolders(this.app.vault.getRoot());
        for (const folder of folders) {
            const folderItem: FolderSearchItem = { type: "folder", folder };
            items.push(folderItem);
        }
        if (debug) console.log("OmniSwitch: folders collected:", folders.length, "in", Math.round(((typeof performance !== "undefined" ? performance.now() : Date.now()) - tFolders)), "ms");

        this.items = items;
        this.dirty = false;

        if (debug) {
            const t1 = typeof performance !== "undefined" ? performance.now() : Date.now();
            console.log("OmniSwitch: indexing complete in", Math.round(t1 - t0), "ms. Ready for engine.");
        }
    }

    getItems(): SearchItem[] {
        return this.items;
    }
}
