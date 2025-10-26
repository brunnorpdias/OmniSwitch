import { describe, it, expect, beforeEach } from "vitest";
import type { App, Command, HeadingCache, TFile, TFolder } from "obsidian";
import { SearchCoordinator } from "../src/search";
import type { OmniSwitchSettings } from "../src/settings";

interface MockFileDescriptor {
	path: string;
	mtime: number;
}

interface HeadingDescriptor {
	text: string;
	level?: number;
}

class MockAdapter {
	private readonly storage = new Map<string, string>();
	private readonly dirs = new Set<string>();

	async exists(path: string): Promise<boolean> {
		return this.storage.has(path) || this.dirs.has(path);
	}

	async mkdir(path: string): Promise<void> {
		this.dirs.add(path);
	}

	async read(path: string): Promise<string> {
		return this.storage.get(path) ?? "";
	}

	async write(path: string, data: string): Promise<void> {
		this.storage.set(path, data);
	}

	async remove(path: string): Promise<void> {
		this.storage.delete(path);
	}

	async list(path: string): Promise<{ files: string[]; folders: string[] }> {
		const files: string[] = [];
		for (const key of this.storage.keys()) {
			if (key.startsWith(path + "/")) {
				files.push(key);
			}
		}
		return { files, folders: [] };
	}
}

class MockVault {
	private readonly files = new Map<string, TFile>();
	private readonly root: TFolder;
	readonly adapter = new MockAdapter();

	constructor() {
		this.root = {
			path: "",
			name: "",
			parent: null,
			children: [],
			isRoot(): boolean {
				return true;
			},
		} as unknown as TFolder;
	}

	addFile(file: TFile): void {
		if (!file.parent) {
			file.parent = this.root;
		}
		this.files.set(file.path, file);
	}

	removeFile(path: string): void {
		this.files.delete(path);
	}

	getFile(path: string): TFile | null {
		return this.files.get(path) ?? null;
	}

	getAllLoadedFiles(): TFile[] {
		return Array.from(this.files.values());
	}

	getAbstractFileByPath(path: string): TFile | null {
		return this.getFile(path);
	}

	getRoot(): TFolder {
		return this.root;
	}
}

class MockMetadataCache {
	private readonly headings = new Map<string, HeadingCache[]>();

	setHeadings(path: string, descriptors: HeadingDescriptor[]): void {
		const entries = descriptors.map((descriptor) => createHeading(descriptor.text, descriptor.level ?? 1));
		this.headings.set(path, entries);
	}

	clear(): void {
		this.headings.clear();
	}

	getFileCache(file: TFile): { headings: HeadingCache[] } | null {
		const stored = this.headings.get(file.path);
		return stored ? { headings: stored } : null;
	}
}

class MockCommandManager {
	constructor(private readonly commands: Command[]) {}

	listCommands(): Command[] {
		return this.commands;
	}

	executeCommandById(_id: string): boolean {
		return false;
	}
}

class MockApp {
	readonly vault: MockVault = new MockVault();
	readonly metadataCache = new MockMetadataCache();
	readonly commands: MockCommandManager;
	readonly workspace = {
		layoutReady: true,
		onLayoutReady: (callback: () => void): void => {
			callback();
		},
	};

	constructor(commands: Command[] = []) {
		this.commands = new MockCommandManager(commands);
	}
}

function createFile(descriptor: MockFileDescriptor): TFile {
	const segments = descriptor.path.split("/");
	const name = segments.at(-1) ?? descriptor.path;
	const dot = name.lastIndexOf(".");
	const extension = dot === -1 ? "" : name.slice(dot + 1);
	const basename = dot === -1 ? name : name.slice(0, dot);
	const parent: TFolder = {
		path: segments.slice(0, -1).join("/"),
		name: segments.at(-2) ?? "",
		parent: null,
		children: [],
		isRoot(): boolean {
			return this.path.length === 0;
		},
	} as unknown as TFolder;

	const file = {
		path: descriptor.path,
		name,
		basename,
		extension,
		stat: { mtime: descriptor.mtime } as { mtime: number },
		parent,
	} as unknown as TFile;
	return file;
}

function createHeading(text: string, level: number): HeadingCache {
	return {
		heading: text,
		level,
		position: {
			start: { line: 0, col: 0, offset: 0 },
			end: { line: 0, col: 0, offset: 0 },
		},
	} as HeadingCache;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}


interface CoordinatorSetup {
	app: MockApp;
	coordinator: SearchCoordinator;
	vault: MockVault;
	cache: MockMetadataCache;
}


interface JournalEventLike { v: number; ts: number; op: string; path?: string; ext?: string; mtime?: number; size?: number; headings?: Array<{ text: string; level: number; ord: number }>; oldPath?: string; newPath?: string }

class InMemoryJournal {
    private events: JournalEventLike[];
    constructor(events: JournalEventLike[]) { this.events = events; }
    async initialize(): Promise<void> { /* no-op */ }
    appendUpsert(entry: { path: string; extension: string; modified: number; size: number; headings: Array<{ text: string; level: number }> }): void {
        const ts = Date.now();
        const ev: JournalEventLike = {
            v: 1, ts, op: "upsert", path: entry.path, ext: entry.extension, mtime: entry.modified, size: entry.size,
            headings: entry.headings.map((h, i) => ({ text: h.text, level: h.level, ord: i + 1 })),
        };
        this.events.push(ev);
    }
    appendDelete(path: string): void { this.events.push({ v: 1, ts: Date.now(), op: "delete", path }); }
    appendRename(oldPath: string, newPath: string): void { this.events.push({ v: 1, ts: Date.now(), op: "rename", oldPath, newPath }); }
    async loadAllEvents(): Promise<JournalEventLike[]> { return this.events.slice(); }
}

function buildJournalEvents(files: MockFileDescriptor[], headings: Record<string, HeadingDescriptor[]>): JournalEventLike[] {
    const events: JournalEventLike[] = [];
    for (const descriptor of files) {
        const path = descriptor.path;
        const hs = (headings[path] ?? []).map((h, i) => ({ text: h.text, level: h.level ?? 0, ord: i + 1 }));
        events.push({ v: 1, ts: 1, op: "upsert", path, ext: "md", mtime: descriptor.mtime, size: -1, headings: hs });
    }
    return events;
}

async function setupCoordinator(
    files: MockFileDescriptor[],
    headings: Record<string, HeadingDescriptor[]>,
    commands: Command[] = [],
    settings: OmniSwitchSettings = { excludedPaths: [], searchEngine: "fuse" },
): Promise<CoordinatorSetup> {
    const app = new MockApp(commands);

    for (const descriptor of files) {
        const file = createFile(descriptor);
        app.vault.addFile(file);
        const headingDescriptors = headings[descriptor.path] ?? [];
        if (headingDescriptors.length > 0) {
            app.metadataCache.setHeadings(descriptor.path, headingDescriptors);
        }
    }

    const coordinator = new SearchCoordinator({
        app: app as unknown as App,
        pluginId: "test-plugin",
        initialSettings: settings,
        journal: new InMemoryJournal(buildJournalEvents(files, headings)),
    });

    await coordinator.initialize();
    await delay(100);

    return {
        app,
        coordinator,
        vault: app.vault,
        cache: app.metadataCache,
    };
}

describe("SearchCoordinator", () => {
	const baselineFiles: MockFileDescriptor[] = [
		{ path: "Notes/alpha.md", mtime: 1 },
		{ path: "Notes/beta.md", mtime: 2 },
	];
	const baselineHeadings: Record<string, HeadingDescriptor[]> = {
		"Notes/alpha.md": [{ text: "Overview", level: 1 }],
	};

	it("indexes files and provides search hits for both engines", async () => {
		const setup = await setupCoordinator(baselineFiles, baselineHeadings);
		const { coordinator } = setup;

		const fuseHits = coordinator.search("files", "alpha", null);
		expect(fuseHits).toHaveLength(1);
		expect(fuseHits[0]?.item.type).toBe("file");

		const headingHits = coordinator.search("headings", "overview", null);
		expect(headingHits).toHaveLength(1);
		expect(headingHits[0]?.item.type).toBe("heading");

		coordinator.setEngine("mini");
		const miniHits = coordinator.search("files", "alpha", null);
		expect(miniHits).toHaveLength(1);
		expect(miniHits[0]?.item.type).toBe("file");
	});

    it("initializes across sessions and returns results using shared docs", async () => {
        const first = await setupCoordinator(baselineFiles, baselineHeadings);
        const hits1 = first.coordinator.search("files", "alpha", null);
        expect(hits1).toHaveLength(1);

        const second = await setupCoordinator(baselineFiles, baselineHeadings);
        const hits2 = second.coordinator.search("files", "alpha", null);
        expect(hits2).toHaveLength(1);
    });

    it("handles created and deleted files incrementally", async () => {
        const setup = await setupCoordinator(baselineFiles, baselineHeadings);
        const { coordinator, vault, cache } = setup;

		const newFile = createFile({ path: "Notes/gamma.md", mtime: 3 });
		vault.addFile(newFile);
		cache.setHeadings("Notes/gamma.md", [{ text: "Details", level: 2 }]);

        coordinator.handleVaultCreate(newFile);
        await delay(500);

		const afterCreate = coordinator.search("files", "gamma", null);
		expect(afterCreate).toHaveLength(1);
        // No sidecars are saved anymore

		vault.removeFile("Notes/gamma.md");
        coordinator.handleVaultDelete(newFile);
        await delay(500);

		const afterDelete = coordinator.search("files", "gamma", null);
        expect(afterDelete).toHaveLength(0);
    });

    it("mini heading search matches headings beyond the first few", async () => {
        const files = [{ path: "Notes/big.md", mtime: 10 }];
        const hs = [
            { text: "Intro alpha", level: 1 },
            { text: "Background bravo", level: 2 },
            { text: "Context charlie", level: 2 },
            { text: "Details delta", level: 2 },
            { text: "Evaluation echo", level: 2 },
            { text: "Findings foxtrot", level: 2 },
            { text: "Conclusion golf", level: 1 },
        ];
        const setup = await setupCoordinator(files, { "Notes/big.md": hs }, [], { excludedPaths: [], searchEngine: "mini" });
        const { coordinator } = setup;
        // search for a later heading token that would be missed if only the first tokens were indexed
        const hits = coordinator.search("headings", "foxtrot", null);
        expect(hits.some((h) => h.item.type === "heading")).toBe(true);
    });
});
