import { describe, expect, it } from "vitest";
import {
	detectPrefix,
	isNoteExtension,
	matchesAttachmentExtension,
	type OmniSwitchMode,
} from "../src/search/utils";

describe("detectPrefix", () => {
	const defaultMode: OmniSwitchMode = "files";

	it("returns command mode when query starts with '> '", () => {
		const result = detectPrefix("> reload", defaultMode, null);
		expect(result).toEqual({
			mode: "commands",
			extensionFilter: null,
			search: "reload",
			prefixApplied: true,
		});
	});

	it("returns heading mode when query starts with '# '", () => {
		const result = detectPrefix("# heading", defaultMode, null);
		expect(result).toEqual({
			mode: "headings",
			extensionFilter: null,
			search: "heading",
			prefixApplied: true,
		});
	});

	it("returns directory mode when query starts with '/ '", () => {
		const result = detectPrefix("/ projects", defaultMode, null);
		expect(result).toEqual({
			mode: "directories",
			extensionFilter: null,
			search: "projects",
			prefixApplied: true,
		});
	});

	it("does not activate directory mode without trailing space", () => {
		const result = detectPrefix("/projects", defaultMode, null);
		expect(result).toEqual({
			mode: "files",
			extensionFilter: null,
			search: "/projects",
			prefixApplied: false,
		});
	});

	it("extracts attachment extension when query starts with '!ext '", () => {
		const result = detectPrefix("!pdf invoices", defaultMode, null);
		expect(result).toEqual({
			mode: "attachments",
			extensionFilter: "pdf",
			search: "invoices",
			prefixApplied: true,
		});
	});

	it("does not activate attachments without trailing space", () => {
		const result = detectPrefix("!pdf", defaultMode, null);
		expect(result).toEqual({
			mode: "files",
			extensionFilter: null,
			search: "!pdf",
			prefixApplied: false,
		});
	});

	it("activates attachments after space following extension", () => {
		const result = detectPrefix("!pdf ", defaultMode, null);
		expect(result).toEqual({
			mode: "attachments",
			extensionFilter: "pdf",
			search: "",
			prefixApplied: true,
		});
	});

	it("activates attachment category after space", () => {
		const result = detectPrefix("!image screenshots", defaultMode, null);
		expect(result).toEqual({
			mode: "attachments",
			extensionFilter: "image",
			search: "screenshots",
			prefixApplied: true,
		});
	});

	it("ignores attachment prefixes when already in another mode", () => {
		const result = detectPrefix("!pdf invoices", "commands", null);
		expect(result).toEqual({
			mode: "commands",
			extensionFilter: null,
			search: "!pdf invoices",
			prefixApplied: false,
		});
	});

	it("returns current mode when no prefix present", () => {
		const result = detectPrefix("weekly", defaultMode, null);
		expect(result).toEqual({
			mode: "files",
			extensionFilter: null,
			search: "weekly",
			prefixApplied: false,
		});
	});

	it("preserves existing attachment filter when no prefix present", () => {
		const result = detectPrefix("notes", "attachments", "pdf");
		expect(result).toEqual({
			mode: "attachments",
			extensionFilter: "pdf",
			search: "notes",
			prefixApplied: false,
		});
	});
});

describe("matchesAttachmentExtension", () => {
	it("allows all non-note extensions when filter is null", () => {
		expect(matchesAttachmentExtension("png", null)).toBe(true);
		expect(matchesAttachmentExtension("mp3", null)).toBe(true);
	});

	it("blocks note extensions when filter is null", () => {
		expect(matchesAttachmentExtension("md", null)).toBe(false);
		expect(matchesAttachmentExtension("canvas", null)).toBe(false);
		expect(matchesAttachmentExtension("base", null)).toBe(false);
	});

	it("allows specific extension matches", () => {
		expect(matchesAttachmentExtension("md", "md")).toBe(true);
		expect(matchesAttachmentExtension("pdf", "pdf")).toBe(true);
		expect(matchesAttachmentExtension("png", "pdf")).toBe(false);
	});
});

describe("isNoteExtension", () => {
	it("returns true for note-like extensions", () => {
		expect(isNoteExtension("md")).toBe(true);
		expect(isNoteExtension("MD")).toBe(true);
		expect(isNoteExtension("canvas")).toBe(true);
		expect(isNoteExtension("base")).toBe(true);
	});

	it("returns false for other extensions", () => {
		expect(isNoteExtension("pdf")).toBe(false);
		expect(isNoteExtension("png")).toBe(false);
	});
});
