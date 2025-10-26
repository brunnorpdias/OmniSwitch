export type SearchEngine = "fuse" | "mini" | "hybrid";

export interface OmniSwitchSettings {
	excludedPaths: string[];
	searchEngine: SearchEngine;
	prebuildBothEngines?: boolean;
	verboseLogging?: boolean;
	maxResults?: number; // 5..50 (default 20)
	forceRebuild?: boolean;
}

export const DEFAULT_SETTINGS: OmniSwitchSettings = {
	excludedPaths: [],
	searchEngine: "fuse",
	prebuildBothEngines: true,
	verboseLogging: false,
	maxResults: 20,
	forceRebuild: true, // Force rebuild by default to avoid loading incompatible cached data
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
    const settings: OmniSwitchSettings = {
        excludedPaths: [...DEFAULT_SETTINGS.excludedPaths],
        searchEngine: DEFAULT_SETTINGS.searchEngine,
        prebuildBothEngines: DEFAULT_SETTINGS.prebuildBothEngines,
        verboseLogging: DEFAULT_SETTINGS.verboseLogging,
        maxResults: DEFAULT_SETTINGS.maxResults,
        forceRebuild: DEFAULT_SETTINGS.forceRebuild,
    };

	if (!data || typeof data !== "object") {
		return settings;
	}

	const record = data as Record<string, unknown>;

	if (Array.isArray(record.excludedPaths)) {
		settings.excludedPaths = record.excludedPaths.filter((entry): entry is string => typeof entry === "string");
	}

	if (typeof record.searchEngine === "string") {
		const engine = record.searchEngine.toLowerCase();
		if (engine === "fuse" || engine === "mini" || engine === "hybrid") {
			settings.searchEngine = engine;
		}
	}

	if (typeof record.prebuildBothEngines === "boolean") {
		settings.prebuildBothEngines = record.prebuildBothEngines;
	}

	if (typeof record.verboseLogging === "boolean") {
		settings.verboseLogging = record.verboseLogging;
	}

	if (typeof record.maxResults === "number") {
		const n = Math.round(record.maxResults);
		settings.maxResults = Math.min(50, Math.max(5, Number.isFinite(n) ? n : DEFAULT_SETTINGS.maxResults!));
	}

	if (typeof record.forceRebuild === "boolean") {
		settings.forceRebuild = record.forceRebuild;
	}

	return settings;
}
