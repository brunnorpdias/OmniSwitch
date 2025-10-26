import MiniSearch, { type AsPlainObject, type Options as MiniSearchOptions, type SearchResult as MiniSearchResult } from "minisearch";
import type { EngineResult } from "./types";
import type { EngineFileDoc, EngineHeadingDoc, CommandDoc } from "./fuse-engine";
// no custom normalization; rely on engine defaults

export class MiniSearchEngine {
    private files: MiniSearch<EngineFileDoc> | null = null;
    private headings: MiniSearch<EngineHeadingDoc> | null = null;
    private commands: MiniSearch<CommandDoc> | null = null;

    setFiles(docs: EngineFileDoc[]): void {
        const t0 = Date.now();
        this.files = this.buildIndex(docs, this.fileOptions());
        const ms = Date.now() - t0;
        console.info(`[OmniSwitch] Mini: files index in ${ms} ms (files=${docs.length})`);
    }

    async setFilesAsync(docs: EngineFileDoc[]): Promise<void> {
        const t0 = Date.now();
        this.files = await this.buildIndexAsync(docs, this.fileOptions());
        const ms = Date.now() - t0;
        console.info(`[OmniSwitch] Mini: files index in ${ms} ms (files=${docs.length})`);
    }

    addFiles(docs: EngineFileDoc[]): void {
        if (!this.files || docs.length === 0) return;
        this.files.addAll(docs);
    }

    removeFiles(docs: EngineFileDoc[]): void {
        if (!this.files || docs.length === 0) return;
        for (const d of docs) {
            this.files.discard(d.id);
        }
    }

    setHeadings(docs: EngineHeadingDoc[]): void {
        const t0 = Date.now();
        this.headings = this.buildIndex(docs, this.headingOptions());
        const ms = Date.now() - t0;
        console.info(`[OmniSwitch] Mini: headings index in ${ms} ms (headings=${docs.length})`);
    }

    async setHeadingsAsync(docs: EngineHeadingDoc[]): Promise<void> {
        const t0 = Date.now();
        console.info(`[OmniSwitch] Mini: Building headings index for ${docs.length} headings...`);
        this.headings = await this.buildIndexAsync(docs, this.headingOptions());
        const ms = Date.now() - t0;
        console.info(`[OmniSwitch] Mini: headings index COMPLETE in ${ms} ms (headings=${docs.length}, rate=${Math.round(docs.length / (ms / 1000))} headings/sec)`);
    }


    addHeadings(docs: EngineHeadingDoc[]): void {
        if (!this.headings || docs.length === 0) return;
        this.headings.addAll(docs);
    }

    removeHeadings(docs: EngineHeadingDoc[]): void {
        if (!this.headings || docs.length === 0) return;
        for (const d of docs) {
            this.headings.discard(d.id);
        }
    }

    setCommands(docs: CommandDoc[]): void {
        const t0 = Date.now();
        this.commands = this.buildIndex(docs, this.commandOptions());
        const ms = Date.now() - t0;
        console.info(`[OmniSwitch] Mini: commands index in ${ms} ms (commands=${docs.length})`);
    }

    // Persistence
    filesToJSON(): unknown | null {
        return this.files ? this.files.toJSON() : null;
    }
    headingsToJSON(): unknown | null {
        return this.headings ? this.headings.toJSON() : null;
    }

    hasFilesIndex(): boolean {
        return !!this.files;
    }
    hasHeadingsIndex(): boolean {
        return !!this.headings;
    }

    loadFilesFromJS(docs: EngineFileDoc[], indexObj: AsPlainObject): void {
        const t0 = Date.now();
        this.files = MiniSearch.loadJS(indexObj, {
            ...this.fileOptions(),
            idField: "id",
        } as MiniSearchOptions<EngineFileDoc>);
        const ms = Date.now() - t0;
        console.info(`[OmniSwitch] Mini: files loaded from JS in ${ms} ms (files=${docs.length})`);
    }

    loadHeadingsFromJS(docs: EngineHeadingDoc[], indexObj: AsPlainObject): void {
        const t0 = Date.now();
        console.info(`[OmniSwitch] Mini: Loading headings from JS object (${docs.length} docs)...`);

        this.headings = MiniSearch.loadJS(indexObj, {
            ...this.headingOptions(),
            idField: "id",
        } as MiniSearchOptions<EngineHeadingDoc>);

        const ms = Date.now();
        console.info(`[OmniSwitch] Mini: headings loaded from JS in ${ms} ms (headings=${docs.length}, rate=${Math.round(docs.length / (ms / 1000))} docs/sec)`);
    }

    loadHeadingsFromJSON(jsonString: string): void {
        const t0 = Date.now();
        console.info(`[OmniSwitch] Mini: Loading headings from JSON string (${(jsonString.length / 1024 / 1024).toFixed(1)}MB)...`);

        this.headings = MiniSearch.loadJSON(jsonString, {
            ...this.headingOptions(),
            idField: "id",
        } as MiniSearchOptions<EngineHeadingDoc>);

        const ms = Date.now() - t0;
        console.info(`[OmniSwitch] Mini: headings loaded from JSON in ${ms} ms`);
    }

	searchFiles(query: string, limit?: number): EngineResult[] {
		return this.run(this.files, query, limit);
	}

	// Search returns individual heading results directly
	searchHeadings(query: string, limit?: number): EngineResult[] {
		return this.run(this.headings, query, limit);
	}

	searchCommands(query: string, limit?: number): EngineResult[] {
		return this.run(this.commands, query, limit);
	}

    private buildIndex<T extends { id: string }>(docs: T[], options: MiniSearchOptions<T>): MiniSearch<T> | null {
        if (docs.length === 0) {
            return null;
        }
        const index = new MiniSearch<T>({ ...options, idField: "id" });
        index.addAll(docs);
        return index;
    }

    private async buildIndexAsync<T extends { id: string }>(docs: T[], options: MiniSearchOptions<T>): Promise<MiniSearch<T> | null> {
        const tTotal = Date.now();

        if (docs.length === 0) {
            return null;
        }

        // Create index
        const tIndex0 = Date.now();
        const index = new MiniSearch<T>({ ...options, idField: "id" });
        const indexCreateMs = Date.now() - tIndex0;
        console.info(`[OmniSwitch] Mini: buildIndex - index created in ${indexCreateMs} ms`);

        // Add documents with optimized chunk size (larger = fewer context switches)
        // Conservative size to avoid blocking UI too long
        const tAdd0 = Date.now();
        await index.addAllAsync(docs, { chunkSize: 4000 });
        const addMs = Date.now() - tAdd0;
        console.info(`[OmniSwitch] Mini: buildIndex - documents added in ${addMs} ms (${docs.length} docs, ${Math.round(docs.length / (addMs / 1000))} docs/sec)`);

        const totalMs = Date.now() - tTotal;
        console.info(`[OmniSwitch] Mini: buildIndex - TOTAL ${totalMs} ms (create=${indexCreateMs}ms, add=${addMs}ms)`);

        return index;
    }

	private run<T extends { id: string }>(index: MiniSearch<T> | null, query: string, limit?: number): EngineResult[] {
		let trimmed = query.trim();
		if (!index || trimmed.length === 0) {
			return [];
		}

        // Filter out very short words (stopwords) that cause massive result sets
        // Words like "a", "i", "to", etc. match hundreds of thousands of documents
        const words = trimmed.split(/\s+/);
        const filteredWords = words.filter(word => word.length >= 2);

        // If all words were filtered out, use original query
        if (filteredWords.length === 0) {
            // Single char query - allow it
            if (words.length === 1) {
                trimmed = words[0];
            } else {
                // Multi-word but all too short - skip search
                return [];
            }
        } else if (filteredWords.length !== words.length) {
            // Some words were filtered - reconstruct query
            trimmed = filteredWords.join(' ');
        }

        // Adaptive fuzzy matching based on query length for optimal performance on large indexes
        // Fuzzy matching is O(n) and extremely expensive with 1M+ documents
        // Strategy: Start with pure prefix (fast), enable fuzzy only for longer queries
        let fuzzyValue: boolean | number = false;
        let maxFuzzy: number | undefined = undefined;

        if (trimmed.length >= 6) {
            // Long queries: enable fuzzy with tight constraints
            fuzzyValue = 0.15;  // Lower threshold = fewer fuzzy matches
            maxFuzzy = 1;       // Max 1 character difference
        } else if (trimmed.length >= 4) {
            // Medium queries: very minimal fuzzy
            fuzzyValue = 0.1;   // Very tight threshold
            maxFuzzy = 1;       // Max 1 character difference
        }
        // Short queries (1-3 chars): fuzzy disabled (false)

        // Use OR for multi-word queries to avoid expensive intersection operations
        // AND requires computing intersection of potentially huge result sets
        const isMultiWord = filteredWords.length > 1;

        const results = index.search(trimmed, {
            prefix: true,
            fuzzy: fuzzyValue,
            maxFuzzy: maxFuzzy,
            combineWith: isMultiWord ? "OR" : "AND",
        }) as MiniSearchResult[];

        const limited = typeof limit === "number" ? results.slice(0, limit) : results;
        return limited.map(result => ({
            id: result.id,
            score: typeof result.score === "number" ? result.score : 0,
        }));
    }

	private fileOptions(): MiniSearchOptions<EngineFileDoc> {
		return {
			fields: ["name"],  // only search by name (no extension, no path)
			storeFields: [],
		};
	}

    private headingOptions(): MiniSearchOptions<EngineHeadingDoc> {
        return {
            fields: ["title"],
            storeFields: [],
        };
    }

    private commandOptions(): MiniSearchOptions<CommandDoc> {
        return {
            fields: ["name"],
            storeFields: [],
        };
    }

    // no custom stopwords; rely on engine defaults
}
