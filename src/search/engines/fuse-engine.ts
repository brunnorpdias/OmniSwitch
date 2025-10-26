import Fuse, { type IFuseOptions, type FuseIndex, type FuseOptionKey } from "fuse.js";
import type { EngineResult } from "./types";
import type { FileSearchItem, HeadingSearchItem, CommandSearchItem } from "../types";

// Engine-only doc types (minimal data for search indexes - numeric IDs, no extensions)
export interface EngineFileDoc {
	id: string;   // numeric ID (e.g., "5678")
	name: string; // filename without extension (e.g., "note")
}

export interface EngineHeadingDoc {
	id: string;   // numeric ID (e.g., "12345")
	title: string; // heading text for search
}

// Coordinator storage types (kept for filtering and metadata)
export interface MinimalFileDoc {
	id: string;        // path (e.g., "folder/file.md")
	name: string;      // for search
	extension: string; // for filtering
	mtime: number;     // for change detection
}

export interface MinimalHeadingDoc {
	id: string;   // "path/file.md::0" (shortened)
	title: string; // for search
}

// Full doc types with TFile references (for slow path building)
export interface FileDoc {
	id: string;
	path: string;
	name: string;
	extension: string;
	parent: string | null;
	item: FileSearchItem | null;
}

export interface HeadingDoc {
	id: string;
	path: string;
	title: string;
	level: number;
	item: HeadingSearchItem | null;
}

export interface CommandDoc {
	id: string;
	name: string;
	item: CommandSearchItem;
}

export class FuseEngine {
    private fileIndex: Fuse<EngineFileDoc> | null = null;
    private headingIndex: Fuse<EngineHeadingDoc> | null = null;
    private commandIndex: Fuse<CommandDoc> | null = null;

    setFiles(docs: EngineFileDoc[]): void {
        const t0 = Date.now();
        if (docs.length > 0) {
            const opts = this.fileOptions();
            // Prebuild index to speed initial search
            const keys = (opts.keys ?? []).map((k: FuseOptionKey<EngineFileDoc>) => (typeof k === "string" ? k : (k as { name: string }).name));
            const idx = Fuse.createIndex(keys, docs);
            this.fileIndex = new Fuse(docs, opts, idx);
        } else {
            this.fileIndex = null;
        }
        const ms = Date.now() - t0;
        console.info(`[OmniSwitch] Fuse: files index in ${ms} ms (files=${docs.length})`);
    }

    setHeadings(docs: EngineHeadingDoc[]): void {
        const t0 = Date.now();
        if (docs.length > 0) {
            const opts = this.headingOptions();
            const keys = (opts.keys ?? []).map((k: FuseOptionKey<EngineHeadingDoc>) => (typeof k === "string" ? k : (k as { name: string }).name));
            const idx = Fuse.createIndex(keys, docs);
            this.headingIndex = new Fuse(docs, opts, idx);
        } else {
            this.headingIndex = null;
        }
        const ms = Date.now() - t0;
        console.info(`[OmniSwitch] Fuse: headings index in ${ms} ms (headings=${docs.length})`);
    }

    setCommands(docs: CommandDoc[]): void {
        const t0 = Date.now();
        this.commandIndex = docs.length > 0 ? new Fuse(docs, this.commandOptions()) : null;
        const ms = Date.now() - t0;
        console.info(`[OmniSwitch] Fuse: commands index in ${ms} ms (commands=${docs.length})`);
    }

    // Load from persisted index JSON (toJSON output)
    loadFilesFromIndex(docs: EngineFileDoc[], rawIndex: unknown): void {
        const t0 = Date.now();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const parsed = (Fuse as any).parseIndex ? (Fuse as any).parseIndex(rawIndex) : rawIndex;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.fileIndex = docs.length > 0 ? new (Fuse as any)(docs, this.fileOptions(), parsed) as Fuse<EngineFileDoc> : null;
        const ms = Date.now() - t0;
        console.info(`[OmniSwitch] Fuse: files loadIndex in ${ms} ms (files=${docs.length})`);
    }

    loadHeadingsFromIndex(docs: EngineHeadingDoc[], rawIndex: unknown): void {
        const t0 = Date.now();
        console.info(`[OmniSwitch] Fuse: Loading headings index with ${docs.length} docs...`);

        // Debug: Check first doc ID format
        if (docs.length > 0) {
            console.info(`[OmniSwitch] Fuse: First doc ID format: "${docs[0].id}" (length=${docs[0].id.length})`);
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const parsed = (Fuse as any).parseIndex ? (Fuse as any).parseIndex(rawIndex) : rawIndex;

        // Debug: Check index records format
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (parsed && (parsed as any).records && (parsed as any).records.length > 0) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const firstRecord = (parsed as any).records[0];
            console.info(`[OmniSwitch] Fuse: First index record: ${JSON.stringify(firstRecord).slice(0, 100)}`);
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.headingIndex = docs.length > 0 ? new (Fuse as any)(docs, this.headingOptions(), parsed) as Fuse<EngineHeadingDoc> : null;
        const ms = Date.now() - t0;
        console.info(`[OmniSwitch] Fuse: headings loadIndex in ${ms} ms (headings=${docs.length})`);
    }

    // Persist current indexes
    filesToJSON(): unknown | null {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return this.fileIndex ? (this.fileIndex as any).getIndex().toJSON() : null;
    }
    headingsToJSON(): unknown | null {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return this.headingIndex ? (this.headingIndex as any).getIndex().toJSON() : null;
    }

    hasFilesIndex(): boolean {
        return !!this.fileIndex;
    }
    hasHeadingsIndex(): boolean {
        return !!this.headingIndex;
    }

    // Incremental updates (Fuse v6)
    addFiles(docs: EngineFileDoc[]): void {
        if (!this.fileIndex) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const f = this.fileIndex as any;
        for (const d of docs) f.add(d);
    }
    removeFiles(predicate: (doc: EngineFileDoc) => boolean): void {
        if (!this.fileIndex) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (this.fileIndex as any).remove(predicate);
    }
    addHeadings(docs: EngineHeadingDoc[]): void {
        if (!this.headingIndex) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const f = this.headingIndex as any;
        for (const d of docs) f.add(d);
    }
    removeHeadings(predicate: (doc: EngineHeadingDoc) => boolean): void {
        if (!this.headingIndex) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (this.headingIndex as any).remove(predicate);
    }

	searchFiles(query: string, limit?: number): EngineResult[] {
		return this.run(this.fileIndex, query, limit);
	}

	// Search returns individual heading results directly
	searchHeadings(query: string, limit?: number): EngineResult[] {
		return this.run(this.headingIndex, query, limit);
	}

	searchCommands(query: string, limit?: number): EngineResult[] {
		return this.run(this.commandIndex, query, limit);
	}

	private run<T extends { id: string }>(index: Fuse<T> | null, query: string, limit?: number): EngineResult[] {
		const trimmed = query.trim();
		if (!index || trimmed.length === 0) {
			return [];
		}
		// pass limit to Fuse to reduce work and results
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const opts: any = limit ? { limit } : undefined;
		const t0 = Date.now();
		console.log(`[FuseEngine] Starting search: query="${trimmed}", limit=${limit}, hasIndex=${!!index}`);
		const results = (index.search as unknown as (q: string, o?: unknown) => Array<{ item: T; score?: number }>)(trimmed, opts);
		const ms = Date.now() - t0;
		console.log(`[FuseEngine] Search completed: ${ms}ms, rawResults=${results.length}`);
		return results.map((result) => ({
			id: result.item.id,
			score: this.normalizeScore(result.score),
		}));
	}

	private normalizeScore(rawScore: number | undefined): number {
		if (typeof rawScore !== "number") {
			return 0;
		}
		const clamped = Math.min(Math.max(rawScore, 0), 1);
		return 1 - clamped;
	}

    private fileOptions(): IFuseOptions<EngineFileDoc> {
        return {
            includeScore: true,
            ignoreLocation: true,
            shouldSort: true,
            useExtendedSearch: true,
            threshold: 0.4,
            minMatchCharLength: 1,
            keys: [
                { name: "name", weight: 1 },  // only search by name (no extension, no path)
            ],
        };
    }

    private headingOptions(): IFuseOptions<EngineHeadingDoc> {
        return {
            includeScore: true,
            ignoreLocation: true,
            shouldSort: true,
            includeMatches: false,
            useExtendedSearch: true,
            threshold: 0.3,
            minMatchCharLength: 1,
            keys: [
                { name: "title", weight: 1 },
            ],
        };
    }

	private commandOptions(): IFuseOptions<CommandDoc> {
		return {
			includeScore: true,
			ignoreLocation: true,
			shouldSort: true,
			threshold: 0.3,
			minMatchCharLength: 1,
			keys: [
				{ name: "name", weight: 1 },
			],
		};
	}
}
