import type { App, TFile } from "obsidian";
import { normalizePath, type PersistedFileEntry } from "./model";

export type JournalOp = "upsert" | "delete" | "rename";

export interface JournalEventBase {
    v: number;
    ts: number;
    op: JournalOp;
}

export interface JournalUpsert extends JournalEventBase {
    op: "upsert";
    path: string;
    ext: string;
    mtime: number;
    size: number;
    headings: Array<{ text: string; level: number; ord: number }>;
}

export interface JournalDelete extends JournalEventBase {
    op: "delete";
    path: string;
}

export interface JournalRename extends JournalEventBase {
    op: "rename";
    oldPath: string;
    newPath: string;
}

export type JournalEvent = JournalUpsert | JournalDelete | JournalRename;

interface JournalPaths {
    baseDir: string;
    chunkPath: string;
}

export class JournalStore {
    private readonly app: App;
    private readonly pluginId: string;
    private buffer: string[] = [];
    private chunkBytes = 0;
    private chunkContent = "";
    private flushTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly flushDebounceMs = 500;
    private readonly maxChunkBytes = 512 * 1024; // 512 KB per chunk
    private readonly maxChunkLines = 20000; // rotate after many events regardless of size
    private paths: JournalPaths | null = null;

    constructor(app: App, pluginId: string) {
        this.app = app;
        this.pluginId = pluginId;
    }

    async initialize(): Promise<void> {
        this.paths = await this.createPaths();
    }

    private async createPaths(): Promise<JournalPaths> {
        const adapter = this.app.vault.adapter;
        const baseDir = `.obsidian/plugins/${this.pluginId}/journal`;
        try {
            if (!(await adapter.exists(baseDir))) {
                await adapter.mkdir(baseDir);
            }
        } catch {
            // ignore
        }
        const now = Date.now();
        const chunkPath = `${baseDir}/files-${now}.ndjson`;
        // start fresh chunk per session
        await adapter.write(chunkPath, "");
        this.chunkContent = "";
        return { baseDir, chunkPath };
    }

    private enqueue(line: string): void {
        this.buffer.push(line);
        this.chunkBytes += line.length + 1;
        if (this.buffer.length >= this.maxChunkLines || this.chunkBytes >= this.maxChunkBytes) {
            // rotate immediately on overflow
            void this.rotateChunk();
            return;
        }
        if (!this.flushTimer) {
            const scheduler = typeof window !== "undefined" ? window.setTimeout.bind(window) : setTimeout;
            this.flushTimer = scheduler(() => {
                this.flushTimer = null;
                void this.flush();
            }, this.flushDebounceMs);
        }
    }

    private async rotateChunk(): Promise<void> {
        await this.flush();
        // start a new chunk file
        this.chunkBytes = 0;
        this.chunkContent = "";
        const paths = this.paths ?? (await this.createPaths());
        const adapter = this.app.vault.adapter;
        const chunkPath = `${paths.baseDir}/files-${Date.now()}.ndjson`;
        try { await adapter.write(chunkPath, ""); } catch {}
        this.paths = { baseDir: paths.baseDir, chunkPath };
    }

    private async flush(): Promise<void> {
        if (!this.paths) {
            this.paths = await this.createPaths();
        }
        if (this.buffer.length === 0) return;
        const lines = this.buffer.join("\n") + "\n";
        this.buffer = [];
        const adapter = this.app.vault.adapter;
        // No append; rewrite full chunk content accumulated this session
        this.chunkContent += lines;
        await adapter.write(this.paths.chunkPath, this.chunkContent);
    }

    async close(): Promise<void> {
        if (this.flushTimer) {
            const clearer = typeof window !== "undefined" ? window.clearTimeout.bind(window) : clearTimeout;
            clearer(this.flushTimer as unknown as number);
            this.flushTimer = null;
        }
        await this.flush();
    }

    appendUpsert(entry: PersistedFileEntry): void {
        const event: JournalUpsert = {
            v: 1,
            ts: Date.now(),
            op: "upsert",
            path: normalizePath(entry.path),
            ext: entry.extension,
            mtime: Math.trunc(entry.modified),
            size: typeof entry.size === "number" ? entry.size : -1,
            headings: (entry.headings ?? []).map((h, i) => ({ text: h.text, level: h.level, ord: i + 1 })),
        };
        this.enqueue(JSON.stringify(event));
    }

    appendDelete(path: string): void {
        const event: JournalDelete = { v: 1, ts: Date.now(), op: "delete", path: normalizePath(path) };
        this.enqueue(JSON.stringify(event));
    }

    appendRename(oldPath: string, newPath: string): void {
        const event: JournalRename = { v: 1, ts: Date.now(), op: "rename", oldPath: normalizePath(oldPath), newPath: normalizePath(newPath) };
        this.enqueue(JSON.stringify(event));
    }

    async loadAllEvents(): Promise<JournalEvent[]> {
        const t0 = Date.now();
        const paths = this.paths ?? (await this.createPaths());
        const adapter = this.app.vault.adapter;
        let files: string[] = [];
        try {
            // list directory
            const listing = await (adapter as unknown as { list: (path: string) => Promise<{ files: string[]; folders: string[] }> }).list(paths.baseDir);
            files = listing.files.filter((p) => p.endsWith(".ndjson"));
        } catch {
            return [];
        }
        const events: JournalEvent[] = [];
        for (const file of files) {
            try {
                const raw = await adapter.read(file);
                const lines = raw.split(/\r?\n/);
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;
                    try {
                        const parsed = JSON.parse(trimmed) as JournalEvent;
                        if (parsed && typeof parsed === "object" && typeof (parsed as { op?: unknown }).op === "string") {
                            events.push(parsed);
                        }
                    } catch {
                        // ignore bad lines
                    }
                }
            } catch {
                // ignore
            }
        }
        // sort by timestamp just in case
        events.sort((a, b) => (a.ts || 0) - (b.ts || 0));
        const ms = Date.now() - t0;
        console.info(`[OmniSwitch] Journal: loaded ${events.length} events in ${ms} ms`);
        return events;
    }
}
