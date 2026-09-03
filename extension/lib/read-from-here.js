function normalizeWhitespace(text) {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Finds `selectionText` inside `articleText` and returns the article from
 * that point onward, or `null` if the snippet cannot be found. Both strings
 * are whitespace-normalized before matching, since the browser's DOM
 * selection and Readability's extracted text can collapse whitespace
 * differently. If the snippet occurs more than once, the first occurrence
 * is used.
 */
export function sliceFromArticle(articleText, selectionText) {
  const normalizedArticle = normalizeWhitespace(articleText);
  const normalizedSelection = normalizeWhitespace(selectionText);
  const index = normalizedArticle.indexOf(normalizedSelection);
  if (index === -1) return null;
  return normalizedArticle.slice(index);
}
