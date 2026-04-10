"use strict";

// Readability.js is injected before this script runs.
// Returns { title, text } or null if extraction fails.
(function () {
  const docClone = document.cloneNode(true);
  const article = new Readability(docClone).parse(); // eslint-disable-line no-undef
  if (!article) return null;
  const MAX_CHARS = 50_000;
  const text = article.textContent.trim().slice(0, MAX_CHARS);
  return { title: article.title, text };
})();
