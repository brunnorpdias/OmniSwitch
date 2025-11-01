import {
    App,
    FileView,
    FuzzyMatch,
    FuzzySuggestModal,
	MarkdownView,
	Notice,
	Platform,
	TFile,
	TFolder,
	WorkspaceLeaf,
	prepareFuzzySearch,
	type Instruction,
    type SearchResult,
} from "obsidian";
import Fuse from "fuse.js";
import type { SearchItem, FileSearchItem, FolderSearchItem, HeadingSearchItem } from "./search/types";
import type { HeadingDocument, MeilisearchIndex, NoteDocument, SearchHit } from "./search/meilisearch-index";
import { getCommandManager } from "./obsidian-helpers";
import {
	collectFileLeaves,
	detectPrefix,
	getLeafFilePath,
	isNoteExtension,
	matchesAttachmentExtension,
	resolveAttachmentCategory,
	type OmniSwitchMode,
	type PrefixDetectionResult,
} from "./search/utils";

export interface OmniSwitchModalOptions {
    initialMode?: OmniSwitchMode;
    extensionFilter?: string | null;
    initialQuery?: string;
    initialDirectoryTrail?: string[];
    excludedPaths?: string[];
    debug?: boolean;
    maxSuggestions?: number;
    engineTopPercent?: number;
    contentSearch?: MeilisearchIndex | null;
}

type ItemSupplier = () => SearchItem[];

export class OmniSwitchModal extends FuzzySuggestModal<SearchItem> {
	private mode: OmniSwitchMode;
	private extensionFilter: string | null;
	private contentSearch: MeilisearchIndex | null;
	private readonly initialQuery: string;
	private isProgrammaticInput = false;
	private pendingNewLeaf = false;
	private directoryStack: TFolder[] = [];
    private modeLabelEl: HTMLSpanElement | null = null;
    private clearButtonObserver: MutationObserver | null = null;
    private excludedMatchers = [] as ReturnType<typeof import("./search/utils").buildExclusionMatchers>;
    private debug = false;
    private maxSuggestions: number | undefined;
    private engineTopPercent: number | undefined;
    private fileLookup = new Map<string, FileSearchItem>();
    private noteRequestToken = 0;
    private noteQuery = "";
    private pendingNoteQuery: string | null = null;
    private noteMatches: FuzzyMatch<SearchItem>[] = [];
    private headingRequestToken = 0;
    private headingQuery = "";
    private pendingHeadingQuery: string | null = null;
    private headingMatches: FuzzyMatch<SearchItem>[] = [];
    private noteError: string | null = null;
    private headingError: string | null = null;

	private readonly handleInput = (_event: Event): void => {
		if (this.isProgrammaticInput) {
			this.isProgrammaticInput = false;
			return;
		}

		const rawValue = this.inputEl.value;
		const detection = this.detectPrefix(rawValue);
		if (detection.prefixApplied) {
			const previousMode = this.mode;
			if (previousMode !== detection.mode) {
				this.handleModeTransition(previousMode, detection.mode);
			}
			this.mode = detection.mode;
			this.extensionFilter = detection.extensionFilter;
			this.updateModeUI();
			this.updateModeLabel();
			this.inputEl.value = detection.search;
			this.inputEl.setSelectionRange(detection.search.length, detection.search.length);
			this.refreshSuggestions();
			return;
		}

		// When the user types normally, ensure the current mode styling stays in sync.
		this.updateModeUI();
		this.updateModeLabel();

        const trimmed = this.inputEl.value.trim();
        if (this.mode === "files" && this.contentSearch) {
            this.requestNoteSuggestions(trimmed);
        } else if (this.mode === "headings" && this.contentSearch) {
            this.requestHeadingSuggestions(trimmed);
        }
	};

	private readonly handleKeyDown = (event: KeyboardEvent): void => {
		const key = event.key.toLowerCase();

		if (this.isNewLeafShortcut(event)) {
			this.pendingNewLeaf = true;
			event.preventDefault();
			event.stopPropagation();
			event.stopImmediatePropagation?.();
			this.useSelectedItem(event);
			return;
		}

		if (event.key === "Backspace") {
			if (this.mode === "directories"
				&& this.inputEl.selectionStart === 0
				&& this.inputEl.selectionEnd === 0
				&& this.inputEl.value.length === 0) {
				event.preventDefault();
				event.stopPropagation();
				event.stopImmediatePropagation?.();
				this.exitDirectoryLevel(true);
				return;
			}
			if ((this.mode !== "files" || this.extensionFilter)
				&& this.inputEl.selectionStart === 0
				&& this.inputEl.selectionEnd === 0
				&& this.inputEl.value.length === 0) {
				event.preventDefault();
				event.stopPropagation();
				event.stopImmediatePropagation?.();
				this.resetToDefaultMode(true);
				return;
			}
		}

		if (event.ctrlKey && !event.metaKey && !event.altKey) {
			if (key === "j") {
				event.preventDefault();
				event.stopPropagation();
				event.stopImmediatePropagation?.();
				this.simulateArrow("ArrowDown");
				return;
			}
			if (key === "k") {
				event.preventDefault();
				event.stopPropagation();
				event.stopImmediatePropagation?.();
				this.simulateArrow("ArrowUp");
				return;
			}
		}

		if (event.key === "Escape" && (this.mode !== "files" || this.extensionFilter)) {
			event.preventDefault();
			event.stopPropagation();
			event.stopImmediatePropagation?.();
			this.resetToDefaultMode(true);
			return;
		}
	};

    constructor(app: App, private readonly supplyItems: ItemSupplier, options: OmniSwitchModalOptions = {}) {
        super(app);
        this.mode = options.initialMode ?? "files";
        this.extensionFilter = options.extensionFilter ?? null;
        this.contentSearch = options.contentSearch ?? null;
        this.initialQuery = options.initialQuery ?? "";
        this.debug = options.debug === true;
        if (options.excludedPaths) {
            const { buildExclusionMatchers } = require("./search/utils");
            this.excludedMatchers = buildExclusionMatchers(options.excludedPaths);
        }
        this.maxSuggestions = options.maxSuggestions;
        this.engineTopPercent = options.engineTopPercent;
        if (this.mode === "directories") {
            this.initializeDirectoryTrail(options.initialDirectoryTrail);
        }
    }

	onOpen(): void {
		super.onOpen();
		this.modalEl.classList.add("omniswitch-modal");
		this.removeCloseButton();
		this.setupInputChrome();

		this.inputEl.value = this.initialQuery;
		this.inputEl.addEventListener("input", this.handleInput, true);
		this.inputEl.addEventListener("keydown", this.handleKeyDown, true);

		this.updateModeUI();
        const initial = this.initialQuery.trim();
        if (this.mode === "files" && this.contentSearch) {
            this.requestNoteSuggestions(initial);
        } else if (this.mode === "headings" && this.contentSearch) {
            this.requestHeadingSuggestions(initial);
        }
		window.setTimeout(() => this.refreshSuggestions(), 0);
	}

	onClose(): void {
		this.inputEl.removeEventListener("input", this.handleInput, true);
		this.inputEl.removeEventListener("keydown", this.handleKeyDown, true);
		this.clearButtonObserver?.disconnect();
		this.clearButtonObserver = null;
		super.onClose();
	}

	getItems(): SearchItem[] {
		const items = this.supplyItems();
		this.rebuildFileLookup(items);
		return items;
	}

    getSuggestions(query: string): FuzzyMatch<SearchItem>[] {
        if (this.mode === "headings") {
            return this.getHeadingSuggestions(query);
        }
        if (this.mode === "directories") {
            return this.getDirectorySuggestions(query);
        }

        const items = this.filterItems(this.getItems(), this.mode, this.extensionFilter)
            .filter((it) => (it.type !== "file" || !this.isExcluded(it.file.path))
                        && (it.type !== "folder" || !this.isExcluded(this.folderPath(it.folder))));

        const trimmedLeading = query.trimStart();
        if (this.mode === "files") {
            if (trimmedLeading.startsWith(".") && !trimmedLeading.startsWith(". ") && !/^\.[^ ]+ /.test(trimmedLeading)) {
                return [];
            }
            if (trimmedLeading.startsWith(">") && !trimmedLeading.startsWith("> ")) {
                return [];
            }
            if (trimmedLeading.startsWith("#") && !trimmedLeading.startsWith("# ")) {
                return [];
            }
            if (trimmedLeading.startsWith("/") && !trimmedLeading.startsWith("/ ")) {
                return [];
            }
        }

		const normalizedQuery = query.trim();
		const effectiveQuery = normalizedQuery.length > 0 ? normalizedQuery : query;

        if (this.mode === "files" && effectiveQuery.length === 0) {
            const home = this.collectHomeFileSuggestions(this.maxSuggestions ?? 20);
            if (home.length > 0) return home;
        }

        if (this.mode === "files" && this.contentSearch) {
            return this.getNoteSuggestions(effectiveQuery);
        }

		if (effectiveQuery.length === 0) {
			return items.map((item) => ({ item, match: this.emptyMatch() }));
		}

        return this.fuseSearch(items, effectiveQuery);
    }

	private getDirectorySuggestions(query: string): FuzzyMatch<SearchItem>[] {
        const candidates = this.getDirectoryCandidates();
		if (candidates.length === 0) {
			return [];
		}

		const normalizedQuery = query.trim();
		const effectiveQuery = normalizedQuery.length > 0 ? normalizedQuery : query;

		if (effectiveQuery.length === 0) {
			return this.sortDirectoryItems(candidates).map((item) => ({ item, match: this.emptyMatch() }));
		}

		const fuzzy = prepareFuzzySearch(effectiveQuery);
		const matches: FuzzyMatch<SearchItem>[] = [];
		for (const item of candidates) {
			const match = fuzzy(this.getItemText(item));
			if (match) {
				matches.push({ item, match });
			}
		}
		matches.sort((a, b) => {
			const priorityDiff = this.getDirectoryItemPriority(a.item) - this.getDirectoryItemPriority(b.item);
			if (priorityDiff !== 0) {
				return priorityDiff;
			}
			const scoreDiff = b.match.score - a.match.score;
			if (scoreDiff !== 0) {
				return scoreDiff;
			}
			const textA = this.getItemText(a.item);
			const textB = this.getItemText(b.item);
			return textA.localeCompare(textB);
		});
		return matches;
	}

    private getHeadingSuggestions(query: string): FuzzyMatch<SearchItem>[] {
        if (!this.contentSearch) {
            return [];
        }
        const trimmed = query.trim();
        if (trimmed.length === 0) {
            this.headingMatches = [];
            this.headingQuery = trimmed;
            return [];
        }
        if (this.headingQuery !== trimmed && this.pendingHeadingQuery !== trimmed) {
            this.requestHeadingSuggestions(trimmed);
        }
        if (this.headingQuery === trimmed) {
            return this.headingMatches;
        }
        return [];
    }

    private getNoteSuggestions(query: string): FuzzyMatch<SearchItem>[] {
        if (!this.contentSearch) {
            return [];
        }
        const trimmed = query.trim();
        if (trimmed.length < 2) {
            this.noteMatches = [];
            this.noteQuery = trimmed;
            return [];
        }
        if (this.noteQuery !== trimmed && this.pendingNoteQuery !== trimmed) {
            this.requestNoteSuggestions(trimmed);
        }
        if (this.noteQuery === trimmed) {
            return this.noteMatches;
        }
        return [];
    }

	getItemText(item: SearchItem): string {
        switch (item.type) {
            case "file":
                return item.file.path;
            case "command":
                return `${item.command.name} (${item.command.id})`;
            case "folder":
                return this.folderPath(item.folder);
            case "heading":
                return `${item.file.path}#${item.slug}`;
        }
	}

    private rebuildFileLookup(items: SearchItem[]): void {
        this.fileLookup.clear();
        for (const item of items) {
            if (item.type === "file") {
                this.fileLookup.set(item.file.path, item);
            }
        }
    }

	private sortDirectoryItems(items: SearchItem[]): SearchItem[] {
		return [...items].sort((a, b) => {
			const priorityDiff = this.getDirectoryItemPriority(a) - this.getDirectoryItemPriority(b);
			if (priorityDiff !== 0) {
				return priorityDiff;
			}
			const textA = this.getItemText(a);
			const textB = this.getItemText(b);
			return textA.localeCompare(textB);
		});
	}

	private getDirectoryItemPriority(item: SearchItem): number {
		if (item.type === "folder") {
			return 0;
		}
		if (item.type === "file") {
			return 1;
		}
		return 2;
	}

	private getDirectoryCandidates(): SearchItem[] {
		const allItems = this.getItems();
		if (this.directoryStack.length === 0) {
			const rootPath = "/";
			return allItems.filter((item): item is FolderSearchItem => {
				if (item.type !== "folder") {
					return false;
				}
				const parentPath = this.folderParentPath(item.folder.parent ?? null);
				return parentPath === rootPath;
			});
		}

		const currentFolder = this.getCurrentDirectory();
		if (!currentFolder) {
			return [];
		}
		const currentPath = this.folderPath(currentFolder);

		const results: SearchItem[] = [];
		for (const item of allItems) {
			if (item.type === "folder") {
				if (item.folder.isRoot()) {
					continue;
				}
				const parentPath = this.folderParentPath(item.folder.parent ?? null);
				if (parentPath === currentPath) {
					results.push(item);
				}
				continue;
			}

			if (item.type === "file") {
				const parentPath = this.folderParentPath(item.file.parent ?? null);
				if (parentPath === currentPath) {
					results.push(item);
				}
			}
		}
		return results;
	}

	private initializeDirectoryTrail(trail: string[] | undefined): void {
		this.directoryStack = [];
		if (!trail || trail.length === 0) {
			return;
		}
		for (const path of trail) {
			const folder = this.getFolderByPath(path);
			if (!folder) {
				break;
			}
			if (folder.isRoot()) {
				continue;
			}
			this.directoryStack.push(folder);
		}
	}

	private getCurrentDirectory(): TFolder | null {
		if (this.directoryStack.length === 0) {
			return null;
		}
		return this.directoryStack[this.directoryStack.length - 1] ?? null;
	}

	private folderPath(folder: TFolder): string {
		const path = folder.path;
		if (!path || path.length === 0) {
			return "/";
		}
		return path;
	}

	private folderParentPath(folder: TFolder | null): string {
		if (!folder) {
			return "/";
		}
		return this.folderPath(folder);
	}

	private getFolderByPath(path: string | undefined): TFolder | null {
		if (!path || path === "/" || path.length === 0) {
			return this.app.vault.getRoot();
		}
		const abstract = this.app.vault.getAbstractFileByPath(path);
		return abstract instanceof TFolder ? abstract : null;
	}

	private formatFolderDisplayPath(folder: TFolder): string {
		if (folder.isRoot()) {
			return "/";
		}
		const normalized = folder.path.replace(/\\/g, "/");
		return `/${normalized}/`;
	}

	private getFolderTitle(folder: TFolder): string {
		return folder.isRoot() ? "/" : folder.name;
	}

	renderSuggestion(result: FuzzyMatch<SearchItem>, el: HTMLElement): void {
		const item = result.item;
		el.empty();
		el.addClass("omniswitch-suggestion");

		const container = el.createDiv({ cls: "omniswitch-suggestion__content" });
		const textWrapper = container.createDiv({ cls: "omniswitch-suggestion__text" });
		const title = textWrapper.createDiv({ cls: "omniswitch-suggestion__title" });
		const subtitle = textWrapper.createDiv({ cls: "omniswitch-suggestion__subtitle" });
		subtitle.removeClass("omniswitch-suggestion__subtitle--hidden");

		switch (item.type) {
			case "file": {
				title.setText(item.file.basename);
				if (this.mode === "directories") {
					subtitle.empty();
					subtitle.addClass("omniswitch-suggestion__subtitle--hidden");
				} else {
					subtitle.setText(this.getDirectoryLabel(item.file));
				}
				break;
			}
			case "command": {
				title.setText(item.command.name);
				subtitle.empty();
				subtitle.addClass("omniswitch-suggestion__subtitle--hidden");
				break;
			}
			case "heading": {
				title.setText(item.heading);
				subtitle.setText(item.file.path);
				break;
			}
			
			case "folder": {
				title.setText(`📂  ${this.getFolderTitle(item.folder)}`);
				subtitle.empty();
				subtitle.addClass("omniswitch-suggestion__subtitle--hidden");
				break;
			}
		}

		const extensionLabel = this.getExtensionLabel(item);
		if (extensionLabel) {
			container.createDiv({ cls: "omniswitch-suggestion__meta", text: extensionLabel });
		}
	}

	selectSuggestion(result: FuzzyMatch<SearchItem>, evt: MouseEvent | KeyboardEvent): void {
		if (this.mode === "directories" && result.item.type === "folder") {
			this.pendingNewLeaf = false;
			this.enterDirectory(result.item.folder);
			return;
		}
		super.selectSuggestion(result, evt);
	}

	async onChooseItem(item: SearchItem, evt: MouseEvent | KeyboardEvent): Promise<void> {
		if (item.type === "folder") {
			this.pendingNewLeaf = false;
			if (this.mode === "directories") {
				this.enterDirectory(item.folder);
			} else {
				new Notice("Folder navigation is only available in folder mode.");
			}
			return;
		}

		const openInNewPane = this.shouldOpenInNewLeaf(evt, item);

		switch (item.type) {
			case "file":
				await this.openFile(item.file, openInNewPane);
				break;
			case "command":
				this.runCommand(item.command.id);
				break;
			case "heading":
				await this.openHeading(item, openInNewPane);
				break;
                
			default:
				new Notice("Unsupported item type.");
				break;
		}
	}

	private setupInputChrome(): void {
		const parent = this.inputEl.parentElement;
		if (!parent) {
			return;
		}
		parent.classList.add("omniswitch-input-container");
		if (!this.modeLabelEl) {
			this.modeLabelEl = parent.createSpan({ cls: "omniswitch-mode-pill" });
			this.modeLabelEl.textContent = this.modeLabelFor(this.mode);
		} else {
			this.updateModeLabel();
		}
		this.inputEl.classList.add("omniswitch-input");
		this.removeSearchClearButton(parent);
		this.observeSearchClearButton(parent);
	}

	private removeCloseButton(): void {
		const closeButtons = this.modalEl.querySelectorAll<HTMLElement>(".modal-close-button, .modal-close-x, button[aria-label='Close']");
		closeButtons.forEach((button) => button.remove());
	}

	private removeSearchClearButton(container: HTMLElement): void {
		const clearButton = container.querySelector<HTMLElement>(".search-input-clear-button");
		clearButton?.remove();
	}

	private observeSearchClearButton(container: HTMLElement): void {
		this.clearButtonObserver?.disconnect();
		this.clearButtonObserver = new MutationObserver(() => {
			this.removeSearchClearButton(container);
		});
		this.clearButtonObserver.observe(container, { childList: true, subtree: true });
	}
	private detectPrefix(raw: string): PrefixDetectionResult {
		return detectPrefix(raw, this.mode, this.extensionFilter);
	}

	private handleModeTransition(previous: OmniSwitchMode, next: OmniSwitchMode): void {
		if (previous === "directories" || next === "directories") {
			this.directoryStack = [];
		}
		this.updateModeLabel();
        const trimmed = this.inputEl.value.trim();
        if (next === "files" && this.contentSearch) {
            this.requestNoteSuggestions(trimmed);
        }
        if (next === "headings" && this.contentSearch) {
            this.requestHeadingSuggestions(trimmed);
        }
	}

	private exitDirectoryLevel(clearQuery: boolean): void {
		if (this.mode !== "directories") {
			this.resetToDefaultMode(clearQuery);
			return;
		}
		if (this.directoryStack.length === 0) {
			this.resetToDefaultMode(clearQuery);
			return;
		}
		this.directoryStack.pop();
		this.onDirectoryContextChanged(clearQuery);
	}

	private enterDirectory(folder: TFolder): void {
		if (this.mode !== "directories") {
			return;
		}
		const current = this.getCurrentDirectory();
		if (current && current.path === folder.path) {
			return;
		}
		this.directoryStack.push(folder);
		this.onDirectoryContextChanged(true);
	}

	private onDirectoryContextChanged(clearQuery: boolean): void {
		this.updateModeUI();
		this.updateModeLabel();
		if (clearQuery) {
			this.clearQuery();
		} else {
			this.refreshSuggestions();
		}
	}

	private resetToDefaultMode(clearQuery = false): void {
		if (this.mode === "files" && !this.extensionFilter) {
			return;
		}
		const previousMode = this.mode;
		this.mode = "files";
		this.extensionFilter = null;
		if (previousMode !== "files") {
			this.handleModeTransition(previousMode, "files");
		}
		this.updateModeUI();
		if (clearQuery) {
			this.clearQuery();
		} else {
			this.refreshSuggestions();
		}
	}

	private refreshSuggestions(): void {
		this.isProgrammaticInput = true;
		this.inputEl.dispatchEvent(new Event("input"));
	}

	private emptyMatch(): SearchResult {
		return { score: 0, matches: [] };
	}

	private createScoreMatch(score: number): SearchResult {
		const normalized = Number.isFinite(score) ? score : 0;
		return { score: normalized, matches: [] };
	}

    private updateModeUI(): void {
        this.applyModeClass();

		switch (this.mode) {
		case "files":
			this.setPlaceholder("Search vault…");
			this.setInstructions(this.defaultInstructions());
			this.emptyStateText = this.contentSearch && this.noteError ? this.noteError : "No files found";
			break;
			case "commands":
				this.setPlaceholder("Search commands");
				this.setInstructions([{ command: "enter", purpose: "run" }]);
				this.emptyStateText = "No commands found";
				break;
		case "headings": {
			if (!this.contentSearch) {
				this.setPlaceholder("Heading search unavailable");
				this.setInstructions([{ command: "esc", purpose: "cancel" }]);
				this.emptyStateText = "Configure Meilisearch to search headings.";
			} else if (this.headingError) {
				this.setPlaceholder("Heading search error");
				this.setInstructions([{ command: "esc", purpose: "cancel" }]);
				this.emptyStateText = this.headingError;
			} else if (this.pendingHeadingQuery) {
				this.setPlaceholder("Searching headings…");
				this.setInstructions(this.openInstructions());
				this.emptyStateText = "Searching…";
			} else {
				this.setPlaceholder("Search headings (# )");
				this.setInstructions(this.openInstructions());
				this.emptyStateText = "No headings found";
			}
			break;
		}
			case "attachments": {
				const category = resolveAttachmentCategory(this.extensionFilter);
				const placeholder = category
					? `Search ${this.extensionFilter} attachments`
					: this.extensionFilter
                        ? `Search .${this.extensionFilter} files`
                        : "Search attachments (.ext)";
                this.setPlaceholder(placeholder);
                this.setInstructions(this.openInstructions());
                this.emptyStateText = "No attachments found";
                break;
            }
			case "directories": {
				this.setPlaceholder(this.directoryPlaceholder());
				this.setInstructions(this.directoryInstructions());
				this.emptyStateText = this.directoryStack.length > 0 ? "No items in folder" : "No folders found";
				break;
			}
		}
	}

	private applyModeClass(): void {
        const classes: OmniSwitchMode[] = ["files", "commands", "attachments", "headings", "directories"];
		for (const mode of classes) {
			this.modalEl.classList.remove(`omniswitch-mode-${mode}`);
		}
		this.modalEl.classList.add(`omniswitch-mode-${this.mode}`);
	}

    private defaultInstructions(): Instruction[] {
        return [
            { command: "enter", purpose: "open" },
            { command: this.newTabShortcutLabel(), purpose: "new tab" },
            { command: "> ", purpose: "commands" },
            { command: "# ", purpose: "headings" },
            { command: ".(ext/category)", purpose: "attachments" },
            { command: "/ ", purpose: "folders" },
        ];
    }

	private openInstructions(): Instruction[] {
		return [
			{ command: "enter", purpose: "open" },
			{ command: this.newTabShortcutLabel(), purpose: "new tab" },
		];
	}

	private directoryInstructions(): Instruction[] {
		const instructions: Instruction[] = [
			{ command: "enter", purpose: this.directoryStack.length > 0 ? "open" : "enter" },
		];

		if (this.directoryViewHasFiles()) {
			instructions.push({ command: this.newTabShortcutLabel(), purpose: "new tab" });
		}

		instructions.push({ command: "backspace", purpose: this.directoryStack.length > 0 ? "up" : "exit" });

		return instructions;
	}

	private directoryPlaceholder(): string {
		const current = this.getCurrentDirectory();
		if (!current) {
			return "Browse folders";
		}
		const path = this.formatFolderDisplayPath(current);
		return `Searching in folder "${path}"`;
	}

	private updateModeLabel(): void {
		if (!this.modeLabelEl) {
			return;
		}
		this.modeLabelEl.textContent = this.modeLabelFor(this.mode);
	}

	private modeLabelFor(mode: OmniSwitchMode): string {
		switch (mode) {
			case "files":
				return "Notes";
			case "commands":
				return "Commands";
			case "attachments":
				return "Attachments";
			case "headings":
				return "Headings";
                case "directories":
                    return "Folders";
			default:
				return (mode as string).toUpperCase();
		}
	}

	private directoryViewHasFiles(): boolean {
		if (this.mode !== "directories") {
			return false;
		}
		return this.getDirectoryCandidates().some((item) => item.type === "file");
	}

	private filterItems(items: SearchItem[], mode: OmniSwitchMode, extensionFilter: string | null): SearchItem[] {
		switch (mode) {
			case "commands":
				return items.filter((item) => item.type === "command");
			case "attachments":
				return items.filter(
					(item) =>
						item.type === "file"
						&& this.matchesAttachmentFilter(item.file, extensionFilter),
				);
			case "headings":
				return [];
			
			case "files":
			default:
				return items.filter((item) => {
					if (item.type !== "file") {
                        return false;
                    }
                    return isNoteExtension(item.file.extension);
                });
        }
    }

    private requestNoteSuggestions(query: string): void {
        if (!this.contentSearch) {
            return;
        }
        const trimmed = query.trim();
        if (trimmed.length < 2) {
            this.noteMatches = [];
            this.noteQuery = trimmed;
            this.pendingNoteQuery = null;
            return;
        }
        this.pendingNoteQuery = trimmed;
        const token = ++this.noteRequestToken;
        const topPercent = Math.max(10, Math.min(50, this.engineTopPercent ?? 20));
        void this.contentSearch
            .searchNotes(trimmed, {
                limit: this.maxSuggestions ?? 20,
                topPercent,
            })
            .then((hits) => {
                if (token !== this.noteRequestToken) return;
                this.noteMatches = this.mapNoteResults(hits);
                this.noteQuery = trimmed;
                this.pendingNoteQuery = null;
                this.noteError = null;
                this.refreshSuggestions();
            })
            .catch((error) => {
                if (token !== this.noteRequestToken) return;
                this.noteMatches = [];
                this.noteQuery = trimmed;
                this.pendingNoteQuery = null;
                this.noteError = error instanceof Error ? error.message : String(error);
                if (this.debug) {
                    console.warn("OmniSwitch: note search failed", error);
                }
                this.refreshSuggestions();
            });
    }

    private requestHeadingSuggestions(query: string): void {
        if (!this.contentSearch) {
            return;
        }
        const trimmed = query.trim();
        if (trimmed.length === 0) {
            this.headingMatches = [];
            this.headingQuery = trimmed;
            this.pendingHeadingQuery = null;
            return;
        }
        this.pendingHeadingQuery = trimmed;
        const token = ++this.headingRequestToken;
        const activePath = this.app.workspace.getActiveFile()?.path ?? null;
        void this.contentSearch
            .searchHeadings(trimmed, {
                limit: this.maxSuggestions ?? 20,
                activePath,
            })
            .then((hits) => {
                if (token !== this.headingRequestToken) return;
                this.headingMatches = this.mapHeadingResults(hits);
                this.headingQuery = trimmed;
                this.pendingHeadingQuery = null;
                this.headingError = null;
                this.refreshSuggestions();
            })
            .catch((error) => {
                if (token !== this.headingRequestToken) return;
                this.headingMatches = [];
                this.headingQuery = trimmed;
                this.pendingHeadingQuery = null;
                this.headingError = error instanceof Error ? error.message : String(error);
                if (this.debug) {
                    console.warn("OmniSwitch: heading search failed", error);
                }
                this.refreshSuggestions();
            });
    }

    private mapNoteResults(hits: Array<SearchHit<NoteDocument>>): FuzzyMatch<SearchItem>[] {
        if (hits.length === 0) {
            return [];
        }
        const freqMap = (this as unknown as { frequencyMap?: Record<string, number> }).frequencyMap ?? {};
        const freqWeight = (this as unknown as { freqBoost?: number }).freqBoost ?? 0.7;
        const recencyWeight = (this as unknown as { modifiedBoost?: number }).modifiedBoost ?? 0.3;
        const rows: Array<{ file: TFile; score: number; freq: number; mtime: number }> = [];
        for (const hit of hits) {
            const doc = hit.document;
            const existing = this.fileLookup.get(doc.path);
            let file: TFile | null = existing?.file ?? null;
            if (!file) {
                const abstract = this.app.vault.getAbstractFileByPath(doc.path);
                if (abstract instanceof TFile) {
                    file = abstract;
                }
            }
            if (!file) continue;
            if (this.isExcluded(file.path)) continue;
            const stat = (file as unknown as { stat?: { mtime?: number } }).stat ?? {};
            const mtime = typeof stat.mtime === "number" ? stat.mtime : doc.modified;
            const freq = freqMap[file.path] ?? 0;
            const score = Number.isFinite(hit.score) ? hit.score : 0;
            rows.push({ file, score, freq, mtime });
        }
        if (rows.length === 0) {
            return [];
        }

        const bands = new Map<number, Array<{ file: TFile; score: number; freq: number; mtime: number }>>();
        for (const row of rows) {
            const key = Math.floor(row.score * 100) / 100;
            const bucket = bands.get(key) ?? [];
            bucket.push(row);
            bands.set(key, bucket);
        }

        const orderedBandKeys = Array.from(bands.keys()).sort((a, b) => b - a);
        const ranked: Array<{ file: TFile; score: number }> = [];
        for (const key of orderedBandKeys) {
            const group = bands.get(key)!;
            if (group.length <= 1) {
                ranked.push(...group.map((entry) => ({ file: entry.file, score: entry.score })));
                continue;
            }
            const freqValues = group.map((entry) => entry.freq);
            const mtimeValues = group.map((entry) => entry.mtime);
            const freqMin = Math.min(...freqValues);
            const freqMax = Math.max(...freqValues);
            const mtimeMin = Math.min(...mtimeValues);
            const mtimeMax = Math.max(...mtimeValues);
            group.sort((a, b) => {
                const freqRange = freqMax - freqMin || 1;
                const recencyRange = mtimeMax - mtimeMin || 1;
                const normFreqA = (a.freq - freqMin) / freqRange;
                const normFreqB = (b.freq - freqMin) / freqRange;
                const normRecentA = (a.mtime - mtimeMin) / recencyRange;
                const normRecentB = (b.mtime - mtimeMin) / recencyRange;
                const scoreA = a.score + normFreqA * freqWeight + normRecentA * recencyWeight;
                const scoreB = b.score + normFreqB * freqWeight + normRecentB * recencyWeight;
                if (scoreA !== scoreB) {
                    return scoreB - scoreA;
                }
                return a.file.path.localeCompare(b.file.path);
            });
            ranked.push(...group.map((entry) => ({ file: entry.file, score: entry.score })));
        }

        const keepPercent = this.engineTopPercent ?? 20;
        const keepCount = Math.max(
            1,
            Math.min(ranked.length, Math.ceil((ranked.length * keepPercent) / 100)),
        );
        return ranked.slice(0, keepCount).map((entry) => {
            const item: FileSearchItem = { type: "file", file: entry.file };
            return { item, match: this.createScoreMatch(entry.score) };
        });
    }

    private mapHeadingResults(hits: Array<SearchHit<HeadingDocument>>): FuzzyMatch<SearchItem>[] {
        const matches: FuzzyMatch<SearchItem>[] = [];
        for (const hit of hits) {
            const doc = hit.document;
            const existing = this.fileLookup.get(doc.path);
            let file: TFile | null = existing?.file ?? null;
            if (!file) {
                const abstract = this.app.vault.getAbstractFileByPath(doc.path);
                if (abstract instanceof TFile) {
                    file = abstract;
                }
            }
            if (!file) continue;
            if (this.isExcluded(file.path)) continue;
            const heading: HeadingSearchItem = {
                type: "heading",
                file,
                heading: doc.heading,
                slug: doc.slug,
                line: doc.line,
                level: doc.level,
                score: hit.score,
            };
            matches.push({ item: heading, match: this.createScoreMatch(hit.score) });
        }
        return matches;
    }

    // --- Fuse.js integration (notes + attachments) ---
    private fuseNotes: any | null = null;
    private fuseAttachments: any | null = null;

    private ensureFuseIndexes(items: SearchItem[]): void {
        if (!this.fuseNotes || !this.fuseAttachments) {

            const noteDocs: { key: string; basename: string; folder: string; aliases: string[]; ctime: number; mtime: number; ref: SearchItem }[] = [];
            const attDocs: { key: string; basename: string; folder: string; extension: string; ctime: number; mtime: number; ref: SearchItem }[] = [];

            for (const it of items) {
                if (it.type !== "file") continue;
                const file = it.file;
                const folder = this.folderParentPath(file.parent ?? null);
                const basename = file.basename;
                if (isNoteExtension(file.extension)) {
                    const cache = this.app.metadataCache.getFileCache(file);
                    const rawAliases = (cache as any)?.frontmatter?.aliases;
                    const aliases: string[] = Array.isArray(rawAliases)
                        ? rawAliases.filter((v) => typeof v === "string")
                        : (typeof rawAliases === "string" ? [rawAliases] : []);
                    const stat = (file as any).stat ?? {};
                    const ctime = typeof stat.ctime === "number" ? stat.ctime : 0;
                    const mtime = typeof stat.mtime === "number" ? stat.mtime : 0;
                    noteDocs.push({ key: file.path, basename, folder, aliases, ctime, mtime, ref: it });
                } else {
                    const stat = (file as any).stat ?? {};
                    const ctime = typeof stat.ctime === "number" ? stat.ctime : 0;
                    const mtime = typeof stat.mtime === "number" ? stat.mtime : 0;
                    attDocs.push({ key: file.path, basename, folder, extension: file.extension.toLowerCase(), ctime, mtime, ref: it });
                }
            }

            // Include ctime/mtime in docs (not used in keys yet)
            this.fuseNotes = new Fuse(noteDocs, {
                includeScore: true,
                ignoreLocation: true,
                threshold: 0.3,
                keys: [
                    { name: "basename", weight: 0.8 },
                    { name: "aliases", weight: 0.15 },
                    { name: "folder", weight: 0.05 },
                ],
            });

            this.fuseAttachments = new Fuse(attDocs, {
                includeScore: true,
                ignoreLocation: true,
                threshold: 0.3,
                keys: [
                    { name: "basename", weight: 0.7 },
                    { name: "extension", weight: 0.2 },
                    { name: "folder", weight: 0.1 },
                ],
            });
            if (this.debug) {
                console.log("OmniSwitch: passing info to engine (Fuse)…", `notes=${noteDocs.length}`, `attachments=${attDocs.length}`);
            }
        }
    }

    private fuseSearch(items: SearchItem[], query: string): FuzzyMatch<SearchItem>[] {
        this.ensureFuseIndexes(this.getItems());
        const results: FuzzyMatch<SearchItem>[] = [];
        const mode = this.mode;

        const buildBase = (fuseResults: any[]) => fuseResults.map((r: any) => {
            const item = r.item.ref as FileSearchItem;
            const textScore = 1 - (typeof r.score === 'number' ? r.score : 0);
            return { file: item.file, textScore };
        });

        // No tie-break; rely purely on text scores

        if (mode === 'files') {
            const allowed = new Set(items.filter((i) => i.type === 'file').map((i: any) => i.file.path));
            const fuseResults = this.fuseNotes.search(query).filter((r: any) => allowed.has(r.item.key) && !this.isExcluded(r.item.key));
            // Build base with freq + mtime
            const freqMap = (this as unknown as { frequencyMap?: Record<string, number> }).frequencyMap ?? {};
            const base = fuseResults.map((r: any) => {
                const item = r.item.ref as FileSearchItem;
                const textScore = 1 - (typeof r.score === 'number' ? r.score : 0);
                const stat = (item.file as any).stat ?? {};
                const mtime = typeof stat.mtime === 'number' ? stat.mtime : 0;
                const freq = freqMap[item.file.path] ?? 0;
                return { file: item.file, textScore, freq, mtime };
            });
            // Band-based reorder (two-decimal floor) using in-band percentiles (unitless)
            base.sort((a: { textScore: number }, b: { textScore: number }) => b.textScore - a.textScore);
            const wf = (this as unknown as { freqBoost?: number }).freqBoost ?? 0.7;
            const wr = (this as unknown as { modifiedBoost?: number }).modifiedBoost ?? 0.3;
            const bandWidth = 0.01;
            const bands = new Map<number, Array<{ file: TFile; textScore: number; freq: number; mtime: number }>>();
            for (const row of base) {
                const bandKey = Math.floor(row.textScore * 100) / 100; // two-decimal floor
                const arr = bands.get(bandKey) ?? [];
                arr.push(row);
                bands.set(bandKey, arr);
            }
            const orderedBandKeys = Array.from(bands.keys()).sort((a, b) => b - a);
            const reassembled: Array<{ file: TFile; textScore: number; freq: number; mtime: number }> = [];
            for (const key of orderedBandKeys) {
                const group = bands.get(key)!;
                if (group.length <= 1) {
                    reassembled.push(...group);
                    continue;
                }
                // Compute in-band percentiles for freq and mtime (ascending)
                const denom = Math.max(1, group.length - 1);
                const freqSorted = [...group].sort((a, b) => a.freq - b.freq);
                const timeSorted = [...group].sort((a, b) => a.mtime - b.mtime);
                const freqPct = new Map<typeof group[number], number>();
                const recPct = new Map<typeof group[number], number>();
                for (let r = 0; r < freqSorted.length; r++) freqPct.set(freqSorted[r], r / denom);
                for (let r = 0; r < timeSorted.length; r++) recPct.set(timeSorted[r], r / denom);
                const finals = group.map((g) => {
                    const p = wf * (freqPct.get(g) ?? 0) + wr * (recPct.get(g) ?? 0);
                    const bandOffset = (g.textScore - key) / bandWidth; // 0..1
                    const textWeight = 0.8;
                    const finalInBand = textWeight * bandOffset + (1 - textWeight) * p;
                    return { row: g, finalInBand };
                });
                finals.sort((a, b) => b.finalInBand - a.finalInBand);
                for (const f of finals) reassembled.push(f.row);
            }
            // Apply score threshold (slider) and 20-item cap AFTER band sort
            const best = reassembled[0]?.textScore ?? 0;
            const capPct = Math.max(0, Math.min(100, this.engineTopPercent ?? 20));
            const threshold = best * (1 - capPct / 100);
            const finalSlice = reassembled.filter((r) => r.textScore >= threshold).slice(0, 20);
            for (const r of finalSlice) results.push({ item: { type: 'file', file: r.file } as FileSearchItem, match: { score: r.textScore, matches: [] } });
            if (this.debug) this.debugLogEngineResultsSimple(finalSlice.map((row) => ({ file: row.file, textScore: row.textScore, freq: row.freq, mtime: row.mtime })));
            return results;
        }

        if (mode === 'attachments') {
            const allowed = new Set(items.filter((i) => i.type === 'file').map((i: any) => i.file.path));
            let fuseResults = this.fuseAttachments.search(query);
            fuseResults = fuseResults.filter((r: any) => allowed.has(r.item.key) && !this.isExcluded(r.item.key));
            const freqMap = (this as unknown as { frequencyMap?: Record<string, number> }).frequencyMap ?? {};
            const base = fuseResults.map((r: any) => {
                const item = r.item.ref as FileSearchItem;
                const textScore = 1 - (typeof r.score === 'number' ? r.score : 0);
                const stat = (item.file as any).stat ?? {};
                const mtime = typeof stat.mtime === 'number' ? stat.mtime : 0;
                const freq = freqMap[item.file.path] ?? 0;
                return { file: item.file, textScore, freq, mtime };
            });
            // Band-based reorder for attachments using in-band percentiles
            base.sort((a: { textScore: number }, b: { textScore: number }) => b.textScore - a.textScore);
            const wf2 = (this as unknown as { freqBoost?: number }).freqBoost ?? 0.7;
            const wr2 = (this as unknown as { modifiedBoost?: number }).modifiedBoost ?? 0.3;
            const bandWidth2 = 0.01;
            const bands2 = new Map<number, Array<{ file: TFile; textScore: number; freq: number; mtime: number }>>();
            for (const row of base) {
                const bandKey = Math.floor(row.textScore * 100) / 100;
                const arr = bands2.get(bandKey) ?? [];
                arr.push(row);
                bands2.set(bandKey, arr);
            }
            const orderedBandKeys2 = Array.from(bands2.keys()).sort((a, b) => b - a);
            const reassembled2: Array<{ file: TFile; textScore: number; freq: number; mtime: number }> = [];
            for (const key of orderedBandKeys2) {
                const group = bands2.get(key)!;
                if (group.length <= 1) { reassembled2.push(...group); continue; }
                const denom = Math.max(1, group.length - 1);
                const freqSorted = [...group].sort((a, b) => a.freq - b.freq);
                const timeSorted = [...group].sort((a, b) => a.mtime - b.mtime);
                const freqPct = new Map<typeof group[number], number>();
                const recPct = new Map<typeof group[number], number>();
                for (let r = 0; r < freqSorted.length; r++) freqPct.set(freqSorted[r], r / denom);
                for (let r = 0; r < timeSorted.length; r++) recPct.set(timeSorted[r], r / denom);
                const finals = group.map((g, idx) => {
                    const p = wf2 * (freqPct.get(g) ?? 0) + wr2 * (recPct.get(g) ?? 0);
                    const bandOffset = (g.textScore - key) / bandWidth2;
                    const textWeight = 0.8;
                    const finalInBand = textWeight * bandOffset + (1 - textWeight) * p;
                    return { row: g, finalInBand };
                });
                finals.sort((a, b) => b.finalInBand - a.finalInBand);
                for (const f of finals) reassembled2.push(f.row);
            }
            // Apply score threshold and 20 cap AFTER band sort
            const best2 = reassembled2[0]?.textScore ?? 0;
            const capPct2 = Math.max(0, Math.min(100, this.engineTopPercent ?? 20));
            const threshold2 = best2 * (1 - capPct2 / 100);
            const finalSlice2 = reassembled2.filter((r) => r.textScore >= threshold2).slice(0, 20);
            for (const r of finalSlice2) results.push({ item: { type: 'file', file: r.file } as FileSearchItem, match: { score: r.textScore, matches: [] } });
            if (this.debug) this.debugLogEngineResultsSimple(finalSlice2.map((row) => ({ file: row.file, textScore: row.textScore, freq: row.freq, mtime: row.mtime })));
            return results;
        }

        // Fallback (non-Fuse) for other modes
        const fuzzy = prepareFuzzySearch(query);
        for (const item of items) {
            const text = this.getItemText(item);
            const match = fuzzy(text);
            if (match) results.push({ item, match });
        }
        results.sort((a, b) => {
            const d = b.match.score - a.match.score;
            if (d !== 0) return d;
            const ta = this.getItemText(a.item);
            const tb = this.getItemText(b.item);
            return ta.localeCompare(tb);
        });
        return results;
    }

	private matchesAttachmentFilter(file: TFile, extensionFilter: string | null): boolean {
		return matchesAttachmentExtension(file.extension, extensionFilter);
	}

    private collectRecentFileSuggestions(): FuzzyMatch<SearchItem>[] {
        const allItems = this.getItems();
        const fileLookup = new Map<string, FileSearchItem>();
        for (const item of allItems) {
            if (item.type === "file") {
                if (!this.isExcluded(item.file.path)) {
                    fileLookup.set(item.file.path, item);
                }
            }
        }

        const recentPaths = this.app.workspace.getLastOpenFiles();
        const suggestions: FuzzyMatch<SearchItem>[] = [];
        for (const path of recentPaths) {
            const item = fileLookup.get(path);
            if (!item) {
                continue;
            }
            if (!isNoteExtension(item.file.extension)) {
                continue;
            }
            suggestions.push({ item, match: this.emptyMatch() });
            if (suggestions.length >= 10) {
                break;
            }
        }
        return suggestions;
    }

    private collectHomeFileSuggestions(limit: number): FuzzyMatch<SearchItem>[] {
        const allItems = this.getItems();
        const freqMap = (this as unknown as { frequencyMap?: Record<string, number> }).frequencyMap ?? {};
        const freqWeight = (this as unknown as { freqBoost?: number }).freqBoost ?? 0.7;
        const modWeight = (this as unknown as { modifiedBoost?: number }).modifiedBoost ?? 0.3;
        const candidates: { item: FileSearchItem; freq: number; mtime: number }[] = [];
        for (const it of allItems) {
            if (it.type !== "file") continue;
            if (!isNoteExtension(it.file.extension)) continue;
            if (this.isExcluded(it.file.path)) continue;
            const freq = freqMap[it.file.path] ?? 0;
            const stat = (it.file as any).stat ?? {};
            const mtime = typeof stat.mtime === "number" ? stat.mtime : 0;
            candidates.push({ item: it, freq, mtime });
        }
        if (candidates.length === 0) return [];

        // Percentile ranks within candidates
        const byFreq = [...candidates].sort((a, b) => a.freq - b.freq);
        const byMod = [...candidates].sort((a, b) => a.mtime - b.mtime);
        const freqRank = new Map<typeof candidates[number], number>();
        const modRank = new Map<typeof candidates[number], number>();
        for (let i = 0; i < byFreq.length; i++) freqRank.set(byFreq[i], byFreq.length > 1 ? i / (byFreq.length - 1) : 0);
        for (let i = 0; i < byMod.length; i++) modRank.set(byMod[i], byMod.length > 1 ? i / (byMod.length - 1) : 0);

        // If everyone has zero freq and same mtime, fallback to recents
        const allFreqZero = byFreq[byFreq.length - 1]?.freq === 0;
        const sameMtime = byMod[0]?.mtime === byMod[byMod.length - 1]?.mtime;
        if (allFreqZero && sameMtime) {
            return this.collectRecentFileSuggestions();
        }

        const scored = candidates.map((c) => ({
            item: c.item,
            score: (freqWeight * (freqRank.get(c) ?? 0)) + (modWeight * (modRank.get(c) ?? 0)),
        }));
        scored.sort((a, b) => {
            const d = b.score - a.score;
            if (d !== 0) return d;
            // tie-break by name for stability
            return this.getItemText(a.item).localeCompare(this.getItemText(b.item));
        });
        const topCount = this.topCountFor(scored.length);
        const out: FuzzyMatch<SearchItem>[] = [];
        for (const s of scored.slice(0, topCount)) out.push({ item: s.item, match: this.emptyMatch() });
        return out;
    }

    private topCountFor(total: number): number {
        if (total <= 0) return 0;
        const percent = typeof this.engineTopPercent === 'number' ? this.engineTopPercent : 30;
        const clamped = Math.max(10, Math.min(50, Math.round(percent / 5) * 5));
        return Math.max(1, Math.round((clamped / 100) * total));
    }

    private debugLogEngineResultsSimple(rows: Array<{ file: TFile; textScore: number; freq: number; mtime: number }>): void {
        if (!this.debug) return;
        try {
            const out = rows.slice(0, 20).map((r) => ({
                name: r.file.basename,
                Score: Number(r.textScore.toFixed(4)),
                freq: r.freq,
                mtime: r.mtime,
            }));
            console.table(out);
        } catch { /* noop */ }
    }

    private isExcluded(path: string): boolean {
        if (!this.excludedMatchers || this.excludedMatchers.length === 0) return false;
        const { isExcluded } = require("./search/utils");
        return isExcluded(path, this.excludedMatchers);
    }

	private getDirectoryLabel(file: TFile): string {
		const parent = file.parent;
		if (!parent || parent.isRoot()) {
			return "/";
		}
		return parent.path;
	}

	private getExtensionLabel(item: SearchItem): string | null {
		if (item.type === "heading") {
			const level = Math.max(1, item.level || 1);
			return `H${level}`;
		}
		if (item.type !== "file") {
			return null;
		}
		const extension = item.file.extension;
		if (!extension || extension.toLowerCase() === "md") {
			return null;
		}
		return extension.toLowerCase();
	}

	private shouldOpenInNewLeaf(evt: MouseEvent | KeyboardEvent, item: SearchItem): boolean {
		if (item.type === "folder") {
			this.pendingNewLeaf = false;
			return false;
		}

		if (this.pendingNewLeaf) {
			this.pendingNewLeaf = false;
			return true;
		}

		if (evt instanceof KeyboardEvent && this.isNewLeafShortcut(evt)) {
			return true;
		}

		if (evt instanceof MouseEvent) {
			if (Platform.isMacOS) {
				return evt.metaKey;
			}
			return evt.ctrlKey;
		}

		return false;
	}

	private async openHeading(item: HeadingSearchItem, newLeaf: boolean): Promise<void> {
		await this.openFile(item.file, newLeaf);
		await this.ensureLayoutReady();
		const entry = collectFileLeaves(this.app).find((leaf) => leaf.path === item.file.path);
		const leaf = entry?.leaf ?? this.app.workspace.activeLeaf ?? undefined;
		if (!leaf) {
			return;
		}
		const view = leaf.view;
		if (view instanceof MarkdownView) {
			const editor = view.editor;
			if (editor) {
				const line = Math.max(0, item.line);
				editor.setCursor({ line, ch: 0 });
				editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
			}
		}
	}

	private async openFile(file: TFile, newLeaf: boolean): Promise<void> {
		if (!newLeaf) {
			const activeFile = this.app.workspace.getActiveFile();
			if (activeFile?.path === file.path) {
				return;
			}
			if (await this.focusExistingLeaf(file)) {
				return;
			}
		}

		const leaf = this.app.workspace.getLeaf(newLeaf);
		await leaf.openFile(file);
	}

    // headings removed

	private runCommand(id: string): void {
		const commandManager = getCommandManager(this.app);
		if (!commandManager) {
			new Notice("Unable to access command palette.");
			return;
		}
		commandManager.executeCommandById(id);
	}

	private async focusExistingLeaf(file: TFile): Promise<boolean> {
		await this.ensureLayoutReady();
		const entry = collectFileLeaves(this.app).find((leaf) => leaf.path === file.path);
		if (!entry) {
			return false;
		}

		await this.app.workspace.revealLeaf(entry.leaf);
		this.app.workspace.setActiveLeaf(entry.leaf, { focus: true });
		return true;
	}


	private ensureLayoutReady(): Promise<void> {
		if (this.app.workspace.layoutReady) {
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			this.app.workspace.onLayoutReady(resolve);
		});
	}

	private useSelectedItem(event: KeyboardEvent): void {
		const chooser = (this as unknown as { chooser?: any }).chooser;
		if (chooser && typeof chooser.useSelectedItem === "function") {
			chooser.useSelectedItem(event);
			return;
		}
		this.selectActiveSuggestion(event);
	}

	private simulateArrow(key: "ArrowUp" | "ArrowDown"): void {
		const event = new KeyboardEvent("keydown", {
			key,
			bubbles: true,
		});
		this.inputEl.dispatchEvent(event);
	}

	private clearQuery(): void {
		this.inputEl.value = "";
		this.inputEl.setSelectionRange(0, 0);
		this.refreshSuggestions();
	}

	private isNewLeafShortcut(event: KeyboardEvent): boolean {
		if (Platform.isMacOS) {
			return event.metaKey && event.key === "Enter";
		}
		return event.ctrlKey && event.key === "Enter";
	}

	private newTabShortcutLabel(): string {
		return Platform.isMacOS ? "cmd+enter" : "ctrl+enter";
	}
}
