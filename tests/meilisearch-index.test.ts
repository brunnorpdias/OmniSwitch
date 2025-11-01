import { describe, expect, it, vi } from "vitest";
import { createHeadingSlug, MeilisearchIndex, HeadingDocument } from "../src/search/meilisearch-index";

vi.mock("obsidian", () => ({
	Platform: { isDesktopApp: true },
}));

describe("createHeadingSlug", () => {
	it("normalizes basic headings", () => {
		const seen = new Map<string, number>();
		expect(createHeadingSlug("Hello World", seen)).toBe("hello-world");
		expect(createHeadingSlug("Hello World", seen)).toBe("hello-world-1");
		expect(createHeadingSlug("Hello  World!", seen)).toBe("hello-world-2");
	});

	it("handles non latin characters", () => {
		const seen = new Map<string, number>();
		expect(createHeadingSlug("Привет Мир", seen)).toBe("привет-мир");
		expect(createHeadingSlug("你好 世界", seen)).toBe("你好-世界");
	});
});

describe("MeilisearchIndex document conversion", () => {
	it("extracts note and heading documents with aliases and unique slugs", async () => {
		const longContent = "# Title\n" + "Body\n".repeat(120_000);
		const cachedRead = vi.fn().mockResolvedValue(longContent);
		const getFileCache = vi.fn().mockReturnValue({
			headings: [
				{ heading: "Title", level: 1, position: { start: { line: 0 } } },
				{ heading: "Title", level: 2, position: { start: { line: 1 } } },
				{ heading: "Other", level: 3, position: { start: { line: 2 } } },
			],
			frontmatter: { aliases: ["Alias A", "Alias B"] },
		});

		const app = {
			vault: {
				cachedRead,
			},
			metadataCache: {
				getFileCache,
			},
		};

		const index = new MeilisearchIndex(app as any);
		const file = {
			path: "Notes/Test.md",
			basename: "Test",
			extension: "md",
			parent: { path: "Notes" },
			stat: { mtime: 1234, ctime: 345 },
		};

		const result = await (index as any).toDocuments(file as any);
		expect(result.note).toMatchObject({
			path: "Notes/Test.md",
			basename: "Test",
			aliases: ["Alias A", "Alias B"],
			contentLength: longContent.length,
			truncated: true,
		});
		expect(result.note.id).toMatch(/^[A-Za-z0-9_-]+$/);
		expect((result.note as { content: string }).content.length).toBe(200000);
		expect((result.headings as HeadingDocument[]).map((h: HeadingDocument) => h.slug)).toEqual(["title", "title-1", "other"]);
		expect((result.headings as HeadingDocument[])[0].id).toMatch(/^[A-Za-z0-9_-]+$/);
	});
});
