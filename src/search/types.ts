import type { Command, TFile, TFolder } from "obsidian";

export type SearchItem =
    | FileSearchItem
    | CommandSearchItem
    | FolderSearchItem
    | HeadingSearchItem;

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

export interface HeadingSearchItem {
	type: "heading";
	file: TFile;
	heading: string;
	slug: string;
	line: number;
	level: number;
	score: number;
}
