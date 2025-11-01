export interface OmniSwitchSettings {
    excludedPaths: string[];
    /** Map of path → open count for frequency-based ranking */
    openCounts?: Record<string, number>;
    /** When true, logs live progress and timings to console */
    debug?: boolean;
    /** Max suggestions to show (also used for re-rank K) */
    maxSuggestions?: number;
    /** Percent weight for frequency in tie-break (0..100). Remainder goes to modified-time */
    tieBreakFreqPercent?: number;
    /** Percent of top scoring results to return (10..50) */
    engineTopPercent?: number;
    /** Enable Meilisearch integration */
    meilisearchEnabled?: boolean;
    /** Host (protocol + domain) for Meilisearch REST API */
    meilisearchHost?: string;
    /** API key used to authenticate with Meilisearch */
    meilisearchApiKey?: string | null;
    /** Index used for full note content */
    meilisearchNotesIndex?: string;
    /** Index used for headings */
    meilisearchHeadingsIndex?: string;
}

export const DEFAULT_SETTINGS: OmniSwitchSettings = {
    excludedPaths: [],
    debug: false,
    maxSuggestions: 20,
    tieBreakFreqPercent: 70,
    engineTopPercent: 20,
    meilisearchEnabled: false,
    meilisearchHost: "http://127.0.0.1:7700",
    meilisearchApiKey: null,
    meilisearchNotesIndex: "omniswitch-notes",
    meilisearchHeadingsIndex: "omniswitch-headings",
};

export function parseExcludedPaths(input: string): string[] {
	return input
		.split(/\r?\n/)
		.map(path => path.trim())
		.filter(Boolean);
}

export function formatExcludedPaths(paths: string[]): string {
	return paths.join("\n");
}

export function migrateSettings(data: unknown): OmniSwitchSettings {
    if (!data || typeof data !== "object") {
        return { ...DEFAULT_SETTINGS };
    }
    const settings: OmniSwitchSettings = {
        excludedPaths: [...DEFAULT_SETTINGS.excludedPaths],
        debug: DEFAULT_SETTINGS.debug,
        maxSuggestions: DEFAULT_SETTINGS.maxSuggestions,
        tieBreakFreqPercent: DEFAULT_SETTINGS.tieBreakFreqPercent,
        engineTopPercent: DEFAULT_SETTINGS.engineTopPercent,
        meilisearchEnabled: DEFAULT_SETTINGS.meilisearchEnabled,
        meilisearchHost: DEFAULT_SETTINGS.meilisearchHost,
        meilisearchApiKey: DEFAULT_SETTINGS.meilisearchApiKey,
        meilisearchNotesIndex: DEFAULT_SETTINGS.meilisearchNotesIndex,
        meilisearchHeadingsIndex: DEFAULT_SETTINGS.meilisearchHeadingsIndex,
    } as OmniSwitchSettings;

	const record = data as Record<string, unknown>;

    if (Array.isArray(record.excludedPaths)) {
        settings.excludedPaths = record.excludedPaths.filter((entry): entry is string => typeof entry === "string");
    }

    if (record.openCounts && typeof record.openCounts === "object") {
        const oc = record.openCounts as Record<string, unknown>;
        settings.openCounts = Object.fromEntries(
            Object.entries(oc)
                .filter(([k, v]) => typeof k === "string" && typeof v === "number")
                .map(([k, v]) => [k, v as number])
        );
    }

    if (typeof record.debug === "boolean") {
        settings.debug = record.debug;
    }

    if (typeof record.maxSuggestions === "number") {
        const v = Math.max(5, Math.min(50, Math.round((record.maxSuggestions as number) / 5) * 5));
        settings.maxSuggestions = v;
    }

    if (typeof record.tieBreakFreqPercent === "number") {
        const raw = record.tieBreakFreqPercent as number;
        // Clamp to 0..100 in steps of 10
        const v = Math.max(0, Math.min(100, Math.round(raw / 10) * 10));
        settings.tieBreakFreqPercent = v;
    }

    if (typeof record.engineTopPercent === "number") {
        const raw = record.engineTopPercent as number;
        // Clamp 10..50 in steps of 5
        const v = Math.max(10, Math.min(50, Math.round(raw / 5) * 5));
        settings.engineTopPercent = v;
    }

    if (typeof record.meilisearchEnabled === "boolean") {
        settings.meilisearchEnabled = record.meilisearchEnabled;
    }

    if (typeof record.meilisearchHost === "string" && record.meilisearchHost.trim().length > 0) {
        settings.meilisearchHost = record.meilisearchHost.trim();
    }

    if (typeof record.meilisearchApiKey === "string") {
        settings.meilisearchApiKey = record.meilisearchApiKey.trim();
    } else if (record.meilisearchApiKey === null) {
        settings.meilisearchApiKey = null;
    }

    if (typeof record.meilisearchNotesIndex === "string" && record.meilisearchNotesIndex.trim().length > 0) {
        settings.meilisearchNotesIndex = record.meilisearchNotesIndex.trim();
    }

    if (typeof record.meilisearchHeadingsIndex === "string" && record.meilisearchHeadingsIndex.trim().length > 0) {
        settings.meilisearchHeadingsIndex = record.meilisearchHeadingsIndex.trim();
    }

    return settings;
}
