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
import type { SearchItem, HeadingSearchItem, FileSearchItem, FolderSearchItem } from "./search/types";
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

type ItemSupplier = () => SearchItem[];

export class OmniSwitchModal extends FuzzySuggestModal<SearchItem> {
	private mode: OmniSwitchMode;
	private extensionFilter: string | null;
	private readonly initialQuery: string;
	private isProgrammaticInput = false;
	private pendingNewLeaf = false;
	private directoryStack: TFolder[] = [];
	private modeLabelEl: HTMLSpanElement | null = null;
	private clearButtonObserver: MutationObserver | null = null;

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

		this.inputEl.value = this.initialQuery;
		this.inputEl.addEventListener("input", this.handleInput, true);
		this.inputEl.addEventListener("keydown", this.handleKeyDown, true);

		this.updateModeUI();
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
		return this.supplyItems();
	}

	getSuggestions(query: string): FuzzyMatch<SearchItem>[] {
		if (this.mode === "directories") {
			return this.getDirectorySuggestions(query);
		}
		const items = this.filterItems(this.getItems(), this.mode, this.extensionFilter);
		const trimmedLeading = query.trimStart();
		if (this.mode === "files") {
			if (trimmedLeading.startsWith("!") && !trimmedLeading.startsWith("! ") && !/^![^ ]+ /.test(trimmedLeading)) {
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
			const recent = this.collectRecentFileSuggestions();
			if (recent.length > 0) {
				return recent;
			}
		}

		if (effectiveQuery.length === 0) {
			return items.map((item) => ({ item, match: this.emptyMatch() }));
		}

		const fuzzy = prepareFuzzySearch(effectiveQuery);
		const matches: FuzzyMatch<SearchItem>[] = [];
		for (const item of items) {
			const text = this.getItemText(item);
			const match = fuzzy(text);
			if (match) {
				matches.push({ item, match });
			}
		}
		matches.sort((a, b) => {
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
			{ command: "!(ext/category)", purpose: "attachments" },
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
				return items.filter((item) => item.type === "heading");
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

	private matchesAttachmentFilter(file: TFile, extensionFilter: string | null): boolean {
		return matchesAttachmentExtension(file.extension, extensionFilter);
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
