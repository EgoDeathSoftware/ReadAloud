/** True if `url`'s path ends in `.pdf`, ignoring query string and case. */
export function isPdfUrl(url) {
  try {
    const { pathname } = new URL(url);
    return /\.pdf$/i.test(pathname);
  } catch {
    return false;
  }
}

/**
 * Firefox's built-in PDF viewer runs at a `resource://pdf.js/web/viewer.html`
 * URL carrying the real document URL in its `file` query param. Resolve that
 * back to the real URL; pass anything else through unchanged.
 */
export function resolvePdfSourceUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const isViewer =
    parsed.protocol === "resource:" && parsed.pathname.endsWith("/web/viewer.html");
  if (!isViewer) return url;
  const file = parsed.searchParams.get("file");
  return file || url;
}

/**
 * True if the tab is showing a PDF. Many real-world PDFs are served from
 * extensionless URLs (e.g. arXiv's `/pdf/<id>`), and Firefox keeps `tab.url`
 * as that original address even when rendering via its internal viewer — so
 * a `.pdf` suffix is checked first as a fast path, then a HEAD request's
 * Content-Type is used as the authoritative fallback.
 */
export async function isPdfTab(url, fetchImpl = fetch) {
  const resolved = resolvePdfSourceUrl(url);
  if (isPdfUrl(resolved)) return true;
  try {
    const response = await fetchImpl(resolved, { method: "HEAD" });
    const contentType = response.headers.get("content-type") || "";
    return contentType.toLowerCase().includes("application/pdf");
  } catch {
    return false;
  }
}
