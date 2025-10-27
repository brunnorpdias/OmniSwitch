import { describe, it, expect } from "vitest";
import { detectPrefix, matchesAttachmentExtension } from "../src/search/utils";

describe("detectPrefix (dot attachments)", () => {
  it("switches to attachments with '. ' (no filter)", () => {
    const r = detectPrefix(". query", "files", null);
    expect(r.mode).toBe("attachments");
    expect(r.extensionFilter).toBe(null);
    expect(r.search).toBe("query");
    expect(r.prefixApplied).toBe(true);
  });

  it("switches to attachments with '.pdf ' filter", () => {
    const r = detectPrefix(".pdf invoices", "files", null);
    expect(r.mode).toBe("attachments");
    expect(r.extensionFilter).toBe("pdf");
    expect(r.search).toBe("invoices");
    expect(r.prefixApplied).toBe(true);
  });

  it("does not apply until a space appears after token", () => {
    const r = detectPrefix(".pdf", "files", null);
    expect(r.prefixApplied).toBe(false);
    expect(r.mode).toBe("files");
  });
});

describe("matchesAttachmentExtension", () => {
  it("matches by exact extension", () => {
    expect(matchesAttachmentExtension("pdf", "pdf")).toBe(true);
    expect(matchesAttachmentExtension("PDF", "pdf")).toBe(true);
  });

  it("accepts a leading dot in filter", () => {
    expect(matchesAttachmentExtension("png", ".png")).toBe(true);
  });
});
