import { App, TFile } from "obsidian";
import type { OmniSwitchSettings } from "./settings";
import { SearchItem, CommandSearchItem, FileSearchItem, HeadingSearchItem } from "./search-types";
import { getCommandManager } from "./obsidian-helpers";

interface ExclusionMatcher {
	exact: string;
	prefix: string;
}

function buildExclusionMatchers(paths: string[]): ExclusionMatcher[] {
	return paths.map((raw) => {
		const normalized = normalizePath(raw);
		const prefix = normalized.endsWith("/") ? normalized : `${normalized}/`;
		return { exact: normalized, prefix };
	});
}

function normalizePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

function isExcluded(path: string, matchers: ExclusionMatcher[]): boolean {
	const normalized = normalizePath(path);
	return matchers.some((matcher) => normalized === matcher.exact || normalized.startsWith(matcher.prefix));
}

export class SearchIndex {
	private items: SearchItem[] = [];
	private dirty = true;
	private matchers: ExclusionMatcher[] = [];

	constructor(private readonly app: App) {}

	markDirty(): void {
		this.dirty = true;
	}

	async refresh(settings: OmniSwitchSettings): Promise<void> {
		if (!this.dirty) {
			return;
		}

		this.matchers = buildExclusionMatchers(settings.excludedPaths);

		const items: SearchItem[] = [];

		const commandManager = getCommandManager(this.app);
		const commands = commandManager?.listCommands() ?? [];
		for (const command of commands) {
			const commandItem: CommandSearchItem = {
				type: "command",
				command,
			};
			items.push(commandItem);
		}

		const allFiles = this.app.vault.getAllLoadedFiles();
		for (const abstractFile of allFiles) {
			if (!(abstractFile instanceof TFile)) {
				continue;
			}
			if (isExcluded(abstractFile.path, this.matchers)) {
				continue;
			}
			const fileItem: FileSearchItem = {
				type: "file",
				file: abstractFile,
			};
			items.push(fileItem);

			if (abstractFile.extension.toLowerCase() === "md") {
				const cache = this.app.metadataCache.getFileCache(abstractFile);
				const headings = cache?.headings ?? [];
				for (const heading of headings) {
					const headingItem: HeadingSearchItem = {
						type: "heading",
						file: abstractFile,
						heading,
					};
					items.push(headingItem);
				}
			}
		}

		this.items = items;
		this.dirty = false;
	}

	getItems(): SearchItem[] {
		return this.items;
	}
}
