import type { Command, HeadingCache, TFile, TFolder } from "obsidian";

export type SearchItem = FileSearchItem | CommandSearchItem | HeadingSearchItem | FolderSearchItem;

export interface FileSearchItem {
	type: "file";
	file: TFile;
}

export interface CommandSearchItem {
	type: "command";
	command: Command;
}

export interface HeadingSearchItem {
	type: "heading";
	file: TFile;
	heading: HeadingCache;
}

export interface FolderSearchItem {
	type: "folder";
	folder: TFolder;
}

export type SearchEngineId = "fuse" | "mini" | "hybrid";

export interface SearchHit {
	item: SearchItem;
	score: number;
	engine: SearchEngineId;
}
