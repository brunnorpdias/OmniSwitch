export interface OmniSwitchSettings {
	excludedPaths: string[];
}

export const DEFAULT_SETTINGS: OmniSwitchSettings = {
	excludedPaths: [],
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
	};

	if (!data || typeof data !== "object") {
		return settings;
	}

	const record = data as Record<string, unknown>;

	if (Array.isArray(record.excludedPaths)) {
		settings.excludedPaths = record.excludedPaths.filter((entry): entry is string => typeof entry === "string");
	}

	return settings;
}
