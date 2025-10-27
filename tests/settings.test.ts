import { describe, expect, it } from "vitest";
import {
	formatExcludedPaths,
	parseExcludedPaths,
	migrateSettings,
	DEFAULT_SETTINGS,
} from "../src/settings";

describe("excluded path helpers", () => {
	it("parses newline separated paths", () => {
		const result = parseExcludedPaths("Templates/\nArchive/Old.md\n\n ");
		expect(result).toEqual(["Templates/", "Archive/Old.md"]);
	});

	it("formats array into newline separated string", () => {
		const result = formatExcludedPaths(["Templates/", "Archive/Old.md"]);
		expect(result).toBe("Templates/\nArchive/Old.md");
	});
});

describe("migrateSettings", () => {
	it("returns defaults when input is null", () => {
		expect(migrateSettings(null)).toEqual(DEFAULT_SETTINGS);
	});

	it("migrates excluded paths from legacy structure", () => {
		const result = migrateSettings({ excludedPaths: ["Templates/", 5, "Archive"] });
		expect(result.excludedPaths).toEqual(["Templates/", "Archive"]);
	});

	it("extracts includeHeadings from legacy fileTypes", () => {
		const legacy = {
			excludedPaths: [],
			fileTypes: { includeHeadings: true },
		};
  const result = migrateSettings(legacy);
  expect(result.excludedPaths).toEqual([]);
	});
});
