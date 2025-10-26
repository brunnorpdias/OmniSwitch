import { describe, it, expect } from "vitest";
import Fuse, { type IFuseOptions } from "fuse.js";
import MiniSearch from "minisearch";

describe("Engine behavior on array fields", () => {
  const docs = [
    { id: "f1", name: "Alpha.md", path: "Notes/Alpha.md", headings: ["Option A: Clone", "Option B: Clone"] },
    { id: "f2", name: "Guide.md", path: "Notes/Guide.md", headings: ["Setup", "Troubleshooting"] },
  ];

  it("Fuse: includeMatches on array fields does not provide element index", () => {
    const optsWithMatches: IFuseOptions<typeof docs[number]> = {
      includeScore: true,
      includeMatches: true,
      useExtendedSearch: true,
      keys: ["headings"],
    };

    const f1 = new Fuse(docs, optsWithMatches);
    const r1 = f1.search("Option B: Clone");
    expect(r1.length).toBeGreaterThan(0);
    // Fuse exposes match ranges, but not a stable array element index
    const m = r1[0]?.matches?.find((mm) => mm.key === "headings");
    expect((m as any)?.arrayIndex).toBeUndefined();

    const optsNoMatches: IFuseOptions<typeof docs[number]> = {
      includeScore: true,
      includeMatches: false,
      useExtendedSearch: true,
      keys: ["headings"],
    };

    const f2 = new Fuse(docs, optsNoMatches);
    const r2 = f2.search("Option B: Clone");
    expect(r2.length).toBeGreaterThan(0);
    // Without includeMatches, there is no arrayIndex to identify the heading
    expect(r2[0]?.matches).toBeUndefined();
  });

  it("MiniSearch: array field matches do not expose which array element matched", () => {
    const mini = new MiniSearch({ fields: ["headings"], storeFields: [] });
    mini.addAll(docs);
    const res = mini.search("Option B: Clone", { prefix: true, combineWith: "AND" });
    expect(res.length).toBeGreaterThan(0);
    // MiniSearch provides id/score and a term→fields map, but not element index
    expect(typeof res[0]?.id).toBe("string");
    const match = (res[0] as any).match;
    expect(match && typeof match).toBe("object");
    // No per-element index information is provided
    expect((match as any).arrayIndex).toBeUndefined();
  });
});
