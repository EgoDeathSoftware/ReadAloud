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
  return file ? decodeURIComponent(file) : url;
}
