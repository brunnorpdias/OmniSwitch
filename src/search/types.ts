import type { Command, TFile, TFolder } from "obsidian";

export type SearchItem = FileSearchItem | CommandSearchItem | FolderSearchItem;

export interface FileSearchItem {
	type: "file";
	file: TFile;
}

export interface CommandSearchItem {
	type: "command";
	command: Command;
}

export interface FolderSearchItem {
	type: "folder";
	folder: TFolder;
}
