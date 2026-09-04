import { describe, expect, it } from "vitest";

import { isPdfTab, isPdfUrl, resolvePdfSourceUrl } from "./pdf.js";

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

  it("does not double-decode a URL containing percent-encoded characters", () => {
    const original = "https://example.com/my%20paper.pdf";
    const viewerUrl = `resource://pdf.js/web/viewer.html?file=${encodeURIComponent(original)}`;
    expect(resolvePdfSourceUrl(viewerUrl)).toBe(original);
  });
});

describe("isPdfTab", () => {
  function fetchImplFor(contentType) {
    return async () => ({ headers: { get: () => contentType } });
  }

  it("is true for a plain .pdf URL without making a network request", async () => {
    const fetchImpl = () => {
      throw new Error("should not be called");
    };
    await expect(isPdfTab("https://example.com/paper.pdf", fetchImpl)).resolves.toBe(true);
  });

  it("is true for an extensionless URL when the server reports a PDF content-type", async () => {
    const fetchImpl = fetchImplFor("application/pdf");
    await expect(isPdfTab("https://arxiv.org/pdf/2508.13421v2", fetchImpl)).resolves.toBe(true);
  });

  it("is false for an extensionless URL with a non-PDF content-type", async () => {
    const fetchImpl = fetchImplFor("text/html; charset=utf-8");
    await expect(isPdfTab("https://example.com/article", fetchImpl)).resolves.toBe(false);
  });

  it("is false when the HEAD request fails", async () => {
    const fetchImpl = async () => {
      throw new Error("network error");
    };
    await expect(isPdfTab("https://example.com/article", fetchImpl)).resolves.toBe(false);
  });
});
