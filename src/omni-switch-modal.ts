import {
	App,
	FileView,
	FuzzyMatch,
	FuzzySuggestModal,
	Notice,
	Platform,
	TFile,
	WorkspaceLeaf,
	prepareFuzzySearch,
	type Instruction,
	type SearchResult,
} from "obsidian";
import type { SearchItem, HeadingSearchItem, FileSearchItem } from "./search-types";
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
} from "./search-utils";

export interface OmniSwitchModalOptions {
	initialMode?: OmniSwitchMode;
	extensionFilter?: string | null;
	initialQuery?: string;
}

type ItemSupplier = () => SearchItem[];

export class OmniSwitchModal extends FuzzySuggestModal<SearchItem> {
	private mode: OmniSwitchMode;
	private extensionFilter: string | null;
	private readonly initialQuery: string;
	private isProgrammaticInput = false;
	private pendingNewLeaf = false;

	private readonly handleInput = (_event: Event): void => {
		if (this.isProgrammaticInput) {
			this.isProgrammaticInput = false;
			return;
		}

		const rawValue = this.inputEl.value;
		const detection = this.detectPrefix(rawValue);
		if (detection.prefixApplied) {
			this.mode = detection.mode;
			this.extensionFilter = detection.extensionFilter;
			this.updateModeUI();
			this.inputEl.value = detection.search;
			this.inputEl.setSelectionRange(detection.search.length, detection.search.length);
			this.refreshSuggestions();
			return;
		}

		// When the user types normally, ensure the current mode styling stays in sync.
		this.updateModeUI();
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
	}

	onOpen(): void {
		super.onOpen();
		this.modalEl.classList.add("omniswitch-modal");
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
		super.onClose();
	}

	getItems(): SearchItem[] {
		return this.supplyItems();
	}

	getSuggestions(query: string): FuzzyMatch<SearchItem>[] {
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

	getItemText(item: SearchItem): string {
		switch (item.type) {
			case "file":
				return item.file.path;
			case "command":
				return `${item.command.name} (${item.command.id})`;
			case "heading":
				return `${item.file.path}#${item.heading.heading}`;
		}
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
				subtitle.setText(this.getDirectoryLabel(item.file));
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
		}

		const extensionLabel = this.getExtensionLabel(item);
		if (extensionLabel) {
			container.createDiv({ cls: "omniswitch-suggestion__meta", text: extensionLabel });
		}
	}

	async onChooseItem(item: SearchItem, evt: MouseEvent | KeyboardEvent): Promise<void> {
		const openInNewPane = this.shouldOpenInNewLeaf(evt);

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
		this.inputEl.classList.add("omniswitch-input");
	}

	private detectPrefix(raw: string): PrefixDetectionResult {
		return detectPrefix(raw, this.mode, this.extensionFilter);
	}

	private resetToDefaultMode(clearQuery = false): void {
		if (this.mode === "files" && !this.extensionFilter) {
			return;
		}
		this.mode = "files";
		this.extensionFilter = null;
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
		}
	}

	private applyModeClass(): void {
		const classes: OmniSwitchMode[] = ["files", "commands", "attachments", "headings"];
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
			{ command: "# ", purpose: "headings" },
		];
	}

	private openInstructions(): Instruction[] {
		return [
			{ command: "enter", purpose: "open" },
			{ command: this.newTabShortcutLabel(), purpose: "new tab" },
		];
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

	private shouldOpenInNewLeaf(evt: MouseEvent | KeyboardEvent): boolean {
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
