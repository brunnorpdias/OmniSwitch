import {
	App,
	FileView,
	FuzzyMatch,
	FuzzySuggestModal,
	Notice,
	Platform,
	TFile,
	TFolder,
	WorkspaceLeaf,
	prepareFuzzySearch,
	type Instruction,
	type SearchResult,
} from "obsidian";
import { SearchCoordinator } from "./search";
import type { SearchHit, SearchItem, HeadingSearchItem, FileSearchItem, FolderSearchItem } from "./search";
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
}

export class OmniSwitchModal extends FuzzySuggestModal<SearchItem> {
	private mode: OmniSwitchMode;
	private extensionFilter: string | null;
	private readonly initialQuery: string;
	private isProgrammaticInput = false;
	private pendingNewLeaf = false;
	private directoryStack: TFolder[] = [];
	private modeLabelEl: HTMLSpanElement | null = null;
	private clearButtonObserver: MutationObserver | null = null;
    private refreshTimer: number | null = null;
    private statusTimer: number | null = null;
    private statusEl: HTMLDivElement | null = null;
    private static readonly DEBOUNCE_MS_FILES = 0;
    private static readonly DEBOUNCE_MS_HEADINGS = 0;

    // Track keystroke timing for performance logging
    private lastKeystrokeTime: number | null = null;

    // Track last searched query to avoid duplicate searches
    private lastSearchedQuery = "";
    private isSearching = false;

	private readonly handleInput = (_event: Event): void => {
		if (this.isProgrammaticInput) {
			this.isProgrammaticInput = false;
			return;
		}

		// Capture keystroke time for performance logging
		this.lastKeystrokeTime = performance.now();

		const rawValue = this.inputEl.value;
		const detection = this.detectPrefix(rawValue);
		if (detection.prefixApplied) {
			const previousMode = this.mode;
			if (previousMode !== detection.mode) {
				this.handleModeTransition(previousMode, detection.mode);
			}
			this.mode = detection.mode;
			this.extensionFilter = detection.extensionFilter;
			console.log(`[Modal] Prefix detected: mode=${this.mode}, extensionFilter=${this.extensionFilter}, search="${detection.search}"`);
			this.updateModeUI();
			this.updateModeLabel();
			this.inputEl.value = detection.search;
			this.inputEl.setSelectionRange(detection.search.length, detection.search.length);
			this.scheduleRefreshSuggestions();
			return;
		}

		// When the user types normally, ensure the current mode styling stays in sync.
		this.updateModeUI();
		this.updateModeLabel();
		this.scheduleRefreshSuggestions();
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

	constructor(app: App, private readonly search: SearchCoordinator, options: OmniSwitchModalOptions = {}) {
		super(app);
		this.mode = options.initialMode ?? "files";
		this.extensionFilter = options.extensionFilter ?? null;
		this.initialQuery = options.initialQuery ?? "";
		if (this.mode === "directories") {
			this.initializeDirectoryTrail(options.initialDirectoryTrail);
		}
	}

	onOpen(): void {
		super.onOpen();
		this.modalEl.classList.add("omniswitch-modal");
		this.removeCloseButton();
		this.setupInputChrome();

		// Status ribbon
		this.statusEl = this.contentEl.createDiv({ cls: "omniswitch-status" });
		this.statusEl.style.cssText = "font-size:12px;opacity:0.8;margin:4px 8px 0;";
		const updateStatus = () => {
			const msg = this.search.getStatusMessage();
			if (!msg || /ready/i.test(msg)) {
				this.statusEl!.setText("");
				return;
			}
			this.statusEl!.setText(msg);
		};
		updateStatus();
		this.statusTimer = window.setInterval(updateStatus, 250);

		this.inputEl.value = this.initialQuery;
		this.inputEl.addEventListener("input", this.handleInput, true);
		this.inputEl.addEventListener("keydown", this.handleKeyDown, true);

		this.updateModeUI();
		window.setTimeout(() => this.scheduleRefreshSuggestions(), 0);
	}

	onClose(): void {
		this.inputEl.removeEventListener("input", this.handleInput, true);
		this.inputEl.removeEventListener("keydown", this.handleKeyDown, true);
		this.clearButtonObserver?.disconnect();
		this.clearButtonObserver = null;
        if (this.statusTimer) { window.clearInterval(this.statusTimer); this.statusTimer = null; }
		super.onClose();
	}

	getItems(): SearchItem[] {
		return this.search.getItems();
	}

	getSuggestions(query: string): FuzzyMatch<SearchItem>[] {
		const t0 = performance.now();

		if (this.mode === "directories") {
			const matches = this.getDirectorySuggestions(query);
			const limit = this.search.getMaxResults ? this.search.getMaxResults() : 20;
			return matches.slice(0, limit);
		}

		const normalizedQuery = query.trim();
		const maxResults = this.search.getMaxResults ? this.search.getMaxResults() : 20;

		// Handle empty query - show suggestions based on mode
		if (normalizedQuery.length === 0) {
			const suggestions = this.getEmptyQuerySuggestions(maxResults);
			const totalMs = performance.now() - t0;
			console.log(`[Modal] ${this.mode} mode: empty query suggestions in ${totalMs.toFixed(1)}ms (results=${suggestions.length})`);
			return suggestions;
		}

		console.log(`[Modal] ${this.mode} mode: Starting search for "${normalizedQuery}"`);
		const tSearch0 = performance.now();
		const hits = this.search.search(this.mode, normalizedQuery, this.extensionFilter);
		const searchMs = performance.now() - tSearch0;
		// Safety filter by mode at UI layer as well, to avoid any engine-specific leakage
		const filtered = hits.filter((hit) => {
			if (hit.item.type !== "file") return true; // headings/commands filtered elsewhere
			const ext = hit.item.file.extension;
			if (this.mode === "files") {
				return isNoteExtension(ext);
			}
			if (this.mode === "attachments") {
				return matchesAttachmentExtension(ext, this.extensionFilter);
			}
			return true;
		});
		if (hits.length === 0) {
			return [];
		}

		const tSort0 = performance.now();
		const sorted = filtered.sort((a, b) => {
			const scoreDiff = b.score - a.score;
			if (scoreDiff !== 0) {
				return scoreDiff;
			}
			const textA = this.getItemText(a.item);
			const textB = this.getItemText(b.item);
			return textA.localeCompare(textB);
		});
		const sortMs = performance.now() - tSort0;

		const results = sorted.slice(0, maxResults).map((hit) => this.toFuzzyMatch(hit));

		// Calculate total time
		const totalMs = performance.now() - t0;
		const keystrokeToDisplayMs = this.lastKeystrokeTime !== null ? (performance.now() - this.lastKeystrokeTime) : null;

		// Log breakdown
		console.log(`[Modal] ${this.mode} mode: search=${searchMs.toFixed(1)}ms, filter+sort=${sortMs.toFixed(1)}ms, total=${totalMs.toFixed(1)}ms, results=${results.length}`);
		if (keystrokeToDisplayMs !== null) {
			console.log(`[Modal] ⏱️  KEYSTROKE→DISPLAY: ${keystrokeToDisplayMs.toFixed(1)}ms (includes ${OmniSwitchModal.DEBOUNCE_MS_HEADINGS}ms debounce for headings)`);
		}

		return results;
	}

    private scheduleRefreshSuggestions(): void {
        const delay = this.mode === "headings" ? OmniSwitchModal.DEBOUNCE_MS_HEADINGS : OmniSwitchModal.DEBOUNCE_MS_FILES;

        // Get current query to check if we should even schedule
        const currentQuery = this.inputEl.value;

        // Skip if query hasn't changed from last search
        if (currentQuery === this.lastSearchedQuery) {
            return;
        }

        // Skip if already searching the same query
        if (this.isSearching) {
            return;
        }

        // Clear existing timer
        if (this.refreshTimer !== null) {
            window.clearTimeout(this.refreshTimer);
            this.refreshTimer = null;
        }

        // Schedule new search after debounce period
        this.refreshTimer = window.setTimeout(() => {
            this.refreshTimer = null;

            // Double-check query hasn't changed and we're not already searching
            const finalQuery = this.inputEl.value;
            if (finalQuery === this.lastSearchedQuery || this.isSearching) {
                return;
            }

            // Update last searched query and mark as searching
            this.lastSearchedQuery = finalQuery;
            this.isSearching = true;
            console.log(`[Modal] ${this.mode} mode: Starting search for "${finalQuery}"`);

            // Defer search execution to next frame to unblock UI thread
            // This allows the browser to paint typed characters before we block with search
            requestAnimationFrame(() => {
                try {
                    this.refreshSuggestions();
                } catch (error) {
                    console.error("[Modal] Search error:", error);
                } finally {
                    // Mark search as complete
                    this.isSearching = false;
                }
            });
        }, delay);
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

	getItemText(item: SearchItem): string {
		switch (item.type) {
			case "file":
				return item.file.path;
			case "command":
				return `${item.command.name} (${item.command.id})`;
			case "heading":
				return `${item.file.path}#${item.heading.heading}`;
			case "folder":
				return this.folderPath(item.folder);
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
				title.setText(item.heading.heading);
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
		// Reset search state when mode changes
		this.lastSearchedQuery = "";
		this.updateModeLabel();
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

	private toFuzzyMatch(hit: SearchHit): FuzzyMatch<SearchItem> {
		const match: SearchResult = {
			score: hit.score,
			matches: [],
		};
		return { item: hit.item, match };
	}

	private emptyMatch(): SearchResult {
		return { score: 0, matches: [] };
	}

	private updateModeUI(): void {
		this.applyModeClass();

		switch (this.mode) {
			case "files":
				this.setPlaceholder("Search vault…");
				this.setInstructions(this.defaultInstructions());
				this.emptyStateText = "No files found";
				break;
			case "commands":
				this.setPlaceholder("Search commands");
				this.setInstructions([{ command: "enter", purpose: "run" }]);
				this.emptyStateText = "No commands found";
				break;
			case "attachments": {
				const category = resolveAttachmentCategory(this.extensionFilter);
				const placeholder = category
					? `Search ${this.extensionFilter} attachments`
					: this.extensionFilter
						? `Search .${this.extensionFilter} files`
						: "Search attachments";
				this.setPlaceholder(placeholder);
				this.setInstructions(this.openInstructions());
				this.emptyStateText = "No attachments found";
				break;
			}
			case "headings":
				this.setPlaceholder("Search headings");
				this.setInstructions(this.openInstructions());
				this.emptyStateText = "No headings found";
				break;
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
			{ command: ".(ext/category)", purpose: "attachments" },
			{ command: "/ ", purpose: "folders" },
			{ command: "# ", purpose: "headings" },
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
			case "directories":
				return "Folders";
			case "headings":
				return "Headings";
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


	private getEmptyQuerySuggestions(limit: number): FuzzyMatch<SearchItem>[] {
		switch (this.mode) {
			case "files": {
				// Show recent files (up to 10)
				const recent = this.collectRecentFileSuggestions();
				if (recent.length > 0) {
					return recent;
				}
				// Fallback: show nothing for files to avoid expensive getItems()
				return [];
			}
			case "commands":
			case "headings":
			case "attachments": {
				// Get suggestions from coordinator (efficient, uses cached data)
				const hits = this.search.getSuggestions(this.mode, limit, this.extensionFilter);
				return hits.map((hit) => this.toFuzzyMatch(hit));
			}
			default:
				return [];
		}
	}

	private collectRecentFileSuggestions(): FuzzyMatch<SearchItem>[] {
		const allItems = this.getItems();
		const fileLookup = new Map<string, FileSearchItem>();
		for (const item of allItems) {
			if (item.type === "file") {
				fileLookup.set(item.file.path, item);
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

	private getDirectoryLabel(file: TFile): string {
		const parent = file.parent;
		if (!parent || parent.isRoot()) {
			return "/";
		}
		return parent.path;
	}

	private getExtensionLabel(item: SearchItem): string | null {
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

	private async openHeading(item: HeadingSearchItem, newLeaf: boolean): Promise<void> {
		const linkText = `${item.file.path}#${item.heading.heading}`;
		if (!newLeaf && await this.focusExistingLeaf(item.file)) {
			this.app.workspace.openLinkText(linkText, "", false);
			return;
		}
		this.app.workspace.openLinkText(linkText, "", newLeaf);
	}

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
