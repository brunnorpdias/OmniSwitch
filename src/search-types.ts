import type { Command } from "obsidian";
import type { HeadingCache, TFile } from "obsidian";

export type SearchItem = FileSearchItem | CommandSearchItem | HeadingSearchItem;

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
