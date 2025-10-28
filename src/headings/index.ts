import { App, CachedMetadata, FileSystemAdapter, Platform, TFile } from "obsidian";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createRequire } from "module";
import type { Database as BetterSqliteDatabase, Statement, DatabaseConstructor } from "better-sqlite3";
import { buildExclusionMatchers, ExclusionMatcher, isExcluded, normalizePath, isNoteExtension } from "../search/utils";
import type { HeadingSearchItem } from "../search/types";

type FileRow = { id: number; mtime: number };

type NormalizedHeading = {
    heading: string;
    slug: string;
    line: number;
    level: number;
    sortKey: string;
};

export interface HeadingSearchStatus {
    supported: boolean;
    ready: boolean;
    indexed: boolean;
    refreshing: boolean;
    error?: Error;
}

export interface HeadingSearchQueryOptions {
    limit?: number;
}

function safeLastRowId(result: { lastInsertRowid: number | bigint }): number {
    const value = result.lastInsertRowid;
    if (typeof value === "bigint") {
        return Number(value);
    }
    return value as number;
}

export class HeadingSearchIndex {
    private db: BetterSqliteDatabase | null = null;
    private readonly pluginId: string;
    private readonly app: App;
    private cacheDir: string | null = null;
    private excludedMatchers: ExclusionMatcher[] = [];
    private debug = false;
    private supported = true;
    private ready = false;
    private hasSnapshot = false;
    private refreshPromise: Promise<void> | null = null;
    private initError: Error | null = null;
    private searchStmt: Statement | null = null;
    private getFileStmt: Statement<FileRow | undefined> | null = null;
    private listFilesStmt: Statement<{ id: number; path: string; mtime: number }> | null = null;
    private insertFileStmt: Statement | null = null;
    private updateFileStmt: Statement | null = null;
    private deleteFileStmt: Statement | null = null;
    private deleteHeadingsStmt: Statement | null = null;
    private insertHeadingStmt: Statement | null = null;

    constructor(app: App, pluginId: string) {
        this.app = app;
        this.pluginId = pluginId;
    }

    setDebugMode(enabled: boolean): void {
        this.debug = enabled;
    }

    requestRefresh(): void {
        if (!this.ready) {
            return;
        }
        void this.refresh();
    }

    get status(): HeadingSearchStatus {
        return {
            supported: this.supported,
            ready: this.ready,
            indexed: this.hasSnapshot,
            refreshing: this.refreshPromise !== null,
            error: this.initError ?? undefined,
        };
    }

    async initialize(): Promise<void> {
        if (this.ready || !Platform.isDesktopApp) {
            if (!Platform.isDesktopApp) {
                this.supported = false;
            }
            if (this.debug) {
                console.info("OmniSwitch: heading search initialize bypassed", { ready: this.ready, desktop: Platform.isDesktopApp });
            }
            return;
        }
        if (this.debug) {
            console.info("OmniSwitch: heading search initialize start");
        }

        const adapter = this.app.vault.adapter;
        let pluginDir: string;
        if (adapter instanceof FileSystemAdapter && typeof adapter.getBasePath === "function") {
            const vaultBase = adapter.getBasePath();
            pluginDir = path.join(vaultBase, this.app.vault.configDir, "plugins", this.pluginId);
        } else {
            pluginDir = path.join(os.tmpdir(), `${this.pluginId}-omniswitch`);
        }
        if (this.debug) {
            console.info("OmniSwitch: heading search paths", { pluginDir, cacheDir: path.join(pluginDir, "cache") });
        }
        const cacheDir = path.join(pluginDir, "cache");
        fs.mkdirSync(cacheDir, { recursive: true });
        const dbPath = path.join(cacheDir, "headings.db");

        let SqliteConstructor: DatabaseConstructor | undefined;
        try {
            const requireFromPlugin = createRequire(path.join(pluginDir, "main.js"));
            SqliteConstructor = requireFromPlugin("better-sqlite3") as DatabaseConstructor;
        } catch (pluginRequireError) {
            try {
                SqliteConstructor = require("better-sqlite3") as DatabaseConstructor;
            } catch (fallbackError) {
                this.supported = false;
                this.initError = pluginRequireError instanceof Error ? pluginRequireError : new Error("Unable to load better-sqlite3");
                if (this.debug) {
                    console.warn("OmniSwitch: heading search disabled (better-sqlite3 missing)", pluginRequireError);
                }
                return;
            }
            if (this.debug) {
                console.info("OmniSwitch: heading search loaded better-sqlite3 via fallback require");
            }
        }

        const db = new SqliteConstructor(dbPath);
        this.db = db;
        db.pragma("journal_mode = WAL");
        db.pragma("synchronous = NORMAL");
        db.pragma("foreign_keys = ON");
        if (this.debug) {
            try {
                console.info("OmniSwitch: heading DB initialized", {
                    path: dbPath,
                    journal: db.pragma("journal_mode"),
                    synchronous: db.pragma("synchronous"),
                });
            } catch (_err) {
                // ignore logging issues
            }
        }

        db.exec(`
            DROP TRIGGER IF EXISTS headings_ai;
            DROP TRIGGER IF EXISTS headings_ad;
            DROP TRIGGER IF EXISTS headings_au;

            CREATE TABLE IF NOT EXISTS files (
                id INTEGER PRIMARY KEY,
                path TEXT UNIQUE NOT NULL,
                mtime INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS headings (
                id INTEGER PRIMARY KEY,
                file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
                heading TEXT NOT NULL,
                slug TEXT NOT NULL,
                line INTEGER NOT NULL,
                level INTEGER NOT NULL,
                sort_key TEXT NOT NULL
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS headings_fts USING fts5(
                heading,
                slug,
                path UNINDEXED,
                sort_key UNINDEXED,
                tokenize = 'trigram',
                content = ''
            );

            CREATE TRIGGER IF NOT EXISTS headings_ai AFTER INSERT ON headings BEGIN
                INSERT INTO headings_fts(rowid, heading, slug, path, sort_key)
                VALUES (new.id, new.heading, new.slug, (SELECT path FROM files WHERE id = new.file_id), new.sort_key);
            END;

            CREATE TRIGGER IF NOT EXISTS headings_ad AFTER DELETE ON headings BEGIN
                INSERT INTO headings_fts(headings_fts, rowid)
                VALUES ('delete', old.id);
            END;

            CREATE TRIGGER IF NOT EXISTS headings_au AFTER UPDATE ON headings BEGIN
                INSERT INTO headings_fts(headings_fts, rowid)
                VALUES ('delete', old.id);
                INSERT INTO headings_fts(rowid, heading, slug, path, sort_key)
                VALUES (new.id, new.heading, new.slug, (SELECT path FROM files WHERE id = new.file_id), new.sort_key);
            END;
        `);

        this.cacheDir = cacheDir;
        this.prepareStatements();
        if (this.listFilesStmt) {
            const existing = this.listFilesStmt.get() as { id: number; path: string; mtime: number } | undefined;
            if (existing) {
                this.hasSnapshot = true;
            }
        }
        this.ready = true;
    }

    private prepareStatements(): void {
        if (!this.db) return;
        this.getFileStmt = this.db.prepare<FileRow | undefined>("SELECT id, mtime FROM files WHERE path = ?");
        this.listFilesStmt = this.db.prepare("SELECT id, path, mtime FROM files");
        this.insertFileStmt = this.db.prepare("INSERT INTO files(path, mtime) VALUES (?, ?)");
        this.updateFileStmt = this.db.prepare("UPDATE files SET mtime = ? WHERE id = ?");
        this.deleteFileStmt = this.db.prepare("DELETE FROM files WHERE path = ?");
        this.deleteHeadingsStmt = this.db.prepare("DELETE FROM headings WHERE file_id = ?");
        this.insertHeadingStmt = this.db.prepare(
            "INSERT INTO headings(file_id, heading, slug, line, level, sort_key) VALUES (?, ?, ?, ?, ?, ?)"
        );
        this.searchStmt = this.db.prepare(
            `SELECT h.id as id,
                    h.heading as heading,
                    h.slug as slug,
                    h.line as line,
                    h.level as level,
                    f.path as path,
                    bm25(headings_fts, 1.2, 0.75) AS score
             FROM headings_fts
             JOIN headings h ON h.id = headings_fts.rowid
             JOIN files f ON f.id = h.file_id
             WHERE headings_fts MATCH ?
             ORDER BY score ASC, h.sort_key ASC
             LIMIT ?`
        );
    }

    setExcludedPaths(paths: string[]): void {
        this.excludedMatchers = buildExclusionMatchers(paths);
        if (this.ready) {
            void this.refresh();
        }
    }

    markDirty(path?: string): void {
        if (!this.ready) {
            return;
        }
        if (path) {
            const normalized = normalizePath(path);
            if (!this.isNotePath(normalized)) {
                return;
            }
            if (this.debug) {
                console.info("OmniSwitch: heading markDirty", { path: normalized });
            }
        }
        void this.refresh();
    }

    removePathImmediately(path: string): void {
        if (!this.db) return;
        const normalized = normalizePath(path);
        if (!this.isNotePath(normalized)) {
            return;
        }
        try {
            this.deleteFileStmt?.run(path);
            if (this.debug) {
                console.info("OmniSwitch: heading index removed path", { path });
            }
        } catch (error) {
            if (this.debug) console.warn("OmniSwitch: failed to remove file from heading index", path, error);
        }
    }

    private isNotePath(normalizedPath: string): boolean {
        const lastDot = normalizedPath.lastIndexOf(".");
        if (lastDot === -1) {
            return false;
        }
        const ext = normalizedPath.slice(lastDot + 1).toLowerCase();
        return isNoteExtension(ext);
    }

    async refresh(): Promise<void> {
        if (!this.ready || !this.db) {
            return;
        }
        if (this.refreshPromise) {
            return this.refreshPromise;
        }

        const job = (async () => {
            const timed = this.debug === true;
            if (timed) {
                console.time("omniswitch-heading-refresh");
            }
            await this.yieldControl();
            try {
                await this.performRefresh();
            } finally {
                if (timed) {
                    console.timeEnd("omniswitch-heading-refresh");
                }
            }
        })().finally(() => {
            this.refreshPromise = null;
        });

        this.refreshPromise = job;
        return job;
    }





    private async performRefresh(): Promise<void> {
        if (!this.db || !this.listFilesStmt) {
            return;
        }

        const vaultFiles = this.app.vault.getMarkdownFiles();
        const snapshot: Array<{ file: TFile; normalized: string; mtime: number }> = [];
        for (let i = 0; i < vaultFiles.length; i++) {
            const file = vaultFiles[i];
            if (this.isExcluded(file.path)) {
                continue;
            }
            const normalized = normalizePath(file.path);
            if (!this.isNotePath(normalized)) {
                continue;
            }
            const stat = (file as unknown as { stat?: { mtime?: number } }).stat ?? {};
            const mtime = typeof stat.mtime === "number" ? stat.mtime : 0;
            snapshot.push({ file, normalized, mtime });
            if (i % 400 === 0) {
                await this.yieldControl();
            }
        }

        const dbRows = this.listFilesStmt.all() as Array<{ id: number; path: string; mtime: number }>;
        const dbMap = new Map<string, { id: number; path: string; mtime: number }>();
        for (const row of dbRows) {
            dbMap.set(normalizePath(row.path), row);
        }

        const toIndex: Array<{ file: TFile; rowId: number | null; headings: NormalizedHeading[]; mtime: number }> = [];
        for (let i = 0; i < snapshot.length; i++) {
            const entry = snapshot[i];
            const row = dbMap.get(entry.normalized);
            if (!row) {
                toIndex.push({ file: entry.file, rowId: null, headings: [], mtime: entry.mtime });
            } else if (row.mtime !== entry.mtime || !this.hasSnapshot) {
                toIndex.push({ file: entry.file, rowId: row.id, headings: [], mtime: entry.mtime });
                dbMap.delete(entry.normalized);
            } else {
                dbMap.delete(entry.normalized);
            }
            if (i % 200 === 0) {
                await this.yieldControl();
            }
        }

        const removedRows = Array.from(dbMap.values());

        if (this.debug) {
            console.info("OmniSwitch: heading diff", {
                vaultFiles: snapshot.length,
                reindex: toIndex.length,
                removed: removedRows.length,
            });
        }

        if (toIndex.length === 0 && removedRows.length === 0) {
            this.hasSnapshot = true;
            return;
        }

        for (let i = 0; i < toIndex.length; i++) {
            const target = toIndex[i];
            target.headings = this.extractHeadings(target.file);
            if (this.debug && target.headings.length > 0 && i % 100 === 0) {
                console.debug("OmniSwitch: heading headings prepared", { path: target.file.path, headings: target.headings.length });
            }
            if (i % 100 === 0) {
                await this.yieldControl();
            }
        }

        const transaction = this.db.transaction((payload: {
            toIndex: Array<{ file: TFile; rowId: number | null; headings: NormalizedHeading[]; mtime: number }>;
            removed: Array<{ id: number; path: string }>;
        }) => {
            for (const removed of payload.removed) {
                this.deleteHeadingsStmt!.run(removed.id);
                this.deleteFileStmt!.run(removed.path);
                if (this.debug) {
                    console.info("OmniSwitch: heading removed", { path: removed.path });
                }
            }

            for (const entry of payload.toIndex) {
                let fileId = entry.rowId;
                if (fileId == null) {
                    const result = this.insertFileStmt!.run(entry.file.path, entry.mtime);
                    fileId = safeLastRowId(result);
                    if (this.debug) {
                        console.info("OmniSwitch: heading added", { path: entry.file.path, headings: entry.headings.length });
                    }
                } else {
                    this.updateFileStmt!.run(entry.mtime, fileId);
                    this.deleteHeadingsStmt!.run(fileId);
                    if (this.debug) {
                        console.info("OmniSwitch: heading updated", { path: entry.file.path, headings: entry.headings.length });
                    }
                }

                for (const heading of entry.headings) {
                    this.insertHeadingStmt!.run(fileId, heading.heading, heading.slug, heading.line, heading.level, heading.sortKey);
                }
            }
        });

        transaction({ toIndex, removed: removedRows });

        this.hasSnapshot = true;
    }
    search(query: string, options: HeadingSearchQueryOptions = {}): HeadingSearchItem[] {
        if (!this.ready || !this.db || !this.searchStmt || !this.hasSnapshot) {
            if (this.debug) {
                console.info("OmniSwitch: heading search skipped", { ready: this.ready, hasStmt: Boolean(this.searchStmt), snapshot: this.hasSnapshot, query });
            }
            return [];
        }
        const trimmed = query.trim();
        if (this.debug) {
            console.info("OmniSwitch: heading search query", { query: trimmed });
        }
        if (trimmed.length < 2) {
            return [];
        }
        const normalized = this.normalizeQuery(trimmed);
        const tokens = normalized.split(/\s+/).filter(Boolean);
        if (tokens.length === 0) {
            return [];
        }
        const matchQuery = this.buildMatchQuery(tokens);
        let rows: Array<{ heading: string; slug: string; line: number; level: number; path: string; score: number }> = [];
        try {
            rows = this.searchStmt.all(matchQuery, options.limit ?? 20) as typeof rows;
        } catch (error) {
            if (this.debug) console.warn("OmniSwitch: heading search query failed", error, matchQuery);
            return [];
        }
        const results: HeadingSearchItem[] = [];
        for (const row of rows) {
            const file = this.app.vault.getAbstractFileByPath(row.path);
            if (!(file instanceof TFile)) {
                continue;
            }
            const line = typeof row.line === "number" ? row.line : Number(row.line) || 0;
            const level = typeof row.level === "number" ? row.level : Number(row.level) || 0;
            results.push({
                type: "heading",
                file,
                heading: row.heading,
                slug: row.slug,
                line,
                level,
                score: this.normalizeRank(row.score),
            });
        }
        return results;
    }

    private normalizeRank(value: unknown): number {
        const numeric = typeof value === "number" ? value : Number(value) || 0;
        if (!Number.isFinite(numeric) || numeric < 0) {
            return 1;
        }
        return 1 / (1 + numeric);
    }

    private async yieldControl(): Promise<void> {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    private extractHeadings(file: TFile): NormalizedHeading[] {
        const cache = this.app.metadataCache.getFileCache(file);
        if (!cache) {
            return [];
        }
        const headings = this.getHeadingsFromCache(cache);
        if (!headings || headings.length === 0) {
            return [];
        }
        const dedupe = new Set<string>();
        const results: NormalizedHeading[] = [];
        for (const h of headings) {
            const raw = (h as { heading?: string }).heading ?? "";
            const clean = raw.trim();
            if (!clean) continue;
            const line = (h as { position?: { start?: { line?: number } } }).position?.start?.line ?? 0;
            const level = typeof (h as { level?: number }).level === "number" ? (h as { level?: number }).level! : 0;
            const key = `${line}:${clean}`;
            if (dedupe.has(key)) {
                continue;
            }
            dedupe.add(key);
            const slug = this.slugify(clean);
            results.push({
                heading: clean,
                slug,
                line,
                level,
                sortKey: this.buildSortKey(level, line, slug),
            });
        }
        return results;
    }

    private getHeadingsFromCache(cache: CachedMetadata): Array<{ heading: string; level: number; position?: { start?: { line?: number } } }> | null {
        const headings = (cache as { headings?: Array<{ heading: string; level: number; position?: { start?: { line?: number } } }> }).headings;
        if (!headings || headings.length === 0) {
            return null;
        }
        return headings;
    }

    private buildSortKey(level: number, line: number, slug: string): string {
        return `${level.toString().padStart(2, "0")}:${line.toString().padStart(6, "0")}:${slug}`;
    }

    private slugify(input: string): string {
        const normalized = input.normalize("NFKD").toLowerCase();
        const collapsed = normalized.replace(/[^\p{Letter}\p{Number}]+/gu, "-");
        return collapsed.replace(/^-+|-+$/g, "");
    }

    private normalizeQuery(input: string): string {
        return input.normalize("NFKD").toLowerCase().replace(/[^\p{Letter}\p{Number}\s]+/gu, " ").replace(/\s+/g, " ").trim();
    }

    private buildMatchQuery(tokens: string[]): string {
        return tokens.map((token) => `"${token.replace(/"/g, "")}"`).join(" AND ");
    }

    private isExcluded(path: string): boolean {
        return isExcluded(path, this.excludedMatchers);
    }
}
