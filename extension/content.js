"use strict";

// Readability.js is injected before this script runs.
// Returns { title, text } or null if extraction fails.
(function () {
  const docClone = document.cloneNode(true);
  const article = new Readability(docClone).parse(); // eslint-disable-line no-undef
  if (!article) return null;
  return { title: article.title, text: article.textContent.trim() };
})();
