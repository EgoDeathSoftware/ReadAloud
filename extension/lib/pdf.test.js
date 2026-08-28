import { describe, expect, it } from "vitest";

import { isPdfUrl, resolvePdfSourceUrl } from "./pdf.js";

describe("isPdfUrl", () => {
  it("matches a plain .pdf URL", () => {
    expect(isPdfUrl("https://example.com/paper.pdf")).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(isPdfUrl("https://example.com/PAPER.PDF")).toBe(true);
  });

  it("ignores a query string after .pdf", () => {
    expect(isPdfUrl("https://example.com/paper.pdf?download=1")).toBe(true);
  });

  it("matches a local file URL", () => {
    expect(isPdfUrl("file:///home/user/paper.pdf")).toBe(true);
  });

  it("rejects a non-PDF URL", () => {
    expect(isPdfUrl("https://example.com/article")).toBe(false);
  });

  it("rejects an unparseable URL", () => {
    expect(isPdfUrl("not a url")).toBe(false);
  });
});

describe("resolvePdfSourceUrl", () => {
  it("extracts the real URL from Firefox's internal pdf.js viewer", () => {
    const original = "https://example.com/paper.pdf";
    const viewerUrl = `resource://pdf.js/web/viewer.html?file=${encodeURIComponent(original)}`;
    expect(resolvePdfSourceUrl(viewerUrl)).toBe(original);
  });

  it("passes through a plain PDF URL unchanged", () => {
    const url = "https://example.com/paper.pdf";
    expect(resolvePdfSourceUrl(url)).toBe(url);
  });

  it("passes through a non-viewer resource:// URL unchanged", () => {
    const url = "resource://gre/some-other-page.html";
    expect(resolvePdfSourceUrl(url)).toBe(url);
  });

  it("passes through an unparseable URL unchanged", () => {
    expect(resolvePdfSourceUrl("not a url")).toBe("not a url");
  });
});
