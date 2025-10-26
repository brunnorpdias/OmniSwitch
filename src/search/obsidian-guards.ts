import type { TAbstractFile, TFile, TFolder } from "obsidian";

export function isTFile(file: TAbstractFile | null | undefined): file is TFile {
	return !!file
		&& typeof (file as TFile).extension === "string"
		&& typeof (file as TFile).stat === "object";
}

export function isTFolder(entry: unknown): entry is TFolder {
	return !!entry
		&& typeof (entry as TFolder).isRoot === "function"
		&& Array.isArray((entry as TFolder).children);
}
