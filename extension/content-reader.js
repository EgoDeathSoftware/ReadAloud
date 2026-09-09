"use strict";

// Injected by background.js via tabs.executeScript, after Readability.js.
//
// Extraction and DOM mapping happen in one pass so cue N maps to word N by
// construction: every element is stamped, Readability runs on a clone (which
// keeps data-* attributes), and the live document is then walked keeping only
// text under elements that survived. The text sent for synthesis is built from
// that same walk, so the backend's word splitting reproduces this sequence.
(function () {
  if (window.__readaloud) return;

  const STAMP = "data-ra-id";
  const MAX_CHARS = 50_000;
  const HIGHLIGHT_NAME = "readaloud-word";
  const STYLE_ID = "readaloud-highlight-style";
  const BLOCK_TAGS = new Set([
    "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DIV", "DT", "FIGCAPTION", "H1",
    "H2", "H3", "H4", "H5", "H6", "LI", "MAIN", "P", "PRE", "SECTION", "TD",
    "TH", "TR",
  ]);

  const state = { words: [] };

  function stampAll() {
    let next = 0;
    for (const element of document.querySelectorAll("*")) {
      element.setAttribute(STAMP, String(next++));
    }
  }

  function unstampAll() {
    for (const element of document.querySelectorAll(`[${STAMP}]`)) {
      element.removeAttribute(STAMP);
    }
  }

  /**
   * Run Readability on a stamped clone and return the stamps that survived,
   * or null if the page has no extractable article.
   */
  function parseArticle() {
    const clone = document.cloneNode(true);
    const article = new Readability(clone, { serializer: (el) => el }).parse();
    if (!article || !article.content) return null;

    const ids = new Set();
    if (article.content.hasAttribute(STAMP)) ids.add(article.content.getAttribute(STAMP));
    for (const element of article.content.querySelectorAll(`[${STAMP}]`)) {
      ids.add(element.getAttribute(STAMP));
    }
    return { ids, title: article.title };
  }

  /**
   * Readability creates elements of its own (converting <br> runs to
   * paragraphs, for one), and those carry no stamp -- but their ancestors do,
   * so the nearest stamped ancestor is what decides whether text was kept.
   */
  function nearestStamped(node) {
    let element = node.parentElement;
    while (element && !element.hasAttribute(STAMP)) element = element.parentElement;
    return element;
  }

  function nearestBlock(node) {
    let element = node.parentElement;
    while (element && !BLOCK_TAGS.has(element.tagName)) element = element.parentElement;
    return element || document.body;
  }

  function collectWords(ids) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const words = [];
    let lastBlock = null;
    let chars = 0;

    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const stamped = nearestStamped(node);
      if (!stamped || !ids.has(stamped.getAttribute(STAMP))) continue;

      const block = nearestBlock(node);
      for (const match of node.data.matchAll(/\S+/g)) {
        const breakBefore = words.length > 0 && block !== lastBlock;
        const separator = words.length === 0 ? 0 : breakBefore ? 2 : 1;
        // Truncate on a word boundary: a partial last word would shift every
        // cue after it.
        if (chars + separator + match[0].length > MAX_CHARS) return words;
        chars += separator + match[0].length;
        words.push({
          text: match[0],
          node,
          start: match.index,
          end: match.index + match[0].length,
          breakBefore,
        });
        lastBlock = block;
      }
    }
    return words;
  }

  function joinWords(words, from) {
    let text = "";
    for (let index = from; index < words.length; index++) {
      if (index > from) text += words[index].breakBefore ? "\n\n" : " ";
      text += words[index].text;
    }
    return text;
  }

  function rangeFor(word) {
    if (!word || !word.node.isConnected) return null;
    const range = document.createRange();
    range.setStart(word.node, word.start);
    range.setEnd(word.node, word.end);
    return range;
  }

  /**
   * Index of the first word the selection touches. Returns 0 when there is no
   * selection, or -1 when a selection exists but touches no indexed word
   * (e.g. it sits inside content Readability dropped, like a footer or nav).
   */
  function selectionStartIndex(words) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return 0;

    const selected = selection.getRangeAt(0);
    for (let index = 0; index < words.length; index++) {
      const range = rangeFor(words[index]);
      // END_TO_START compares the selection's start against the word's end:
      // negative means this word is still running when the selection begins.
      if (range && selected.compareBoundaryPoints(Range.END_TO_START, range) < 0) {
        return index;
      }
    }
    return -1;
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `::highlight(${HIGHLIGHT_NAME}) { background-color: #ffd54f; color: #000; }`;
    document.head.appendChild(style);
  }

  function removeStyle() {
    document.getElementById(STYLE_ID)?.remove();
  }

  /** Scroll only when the word has left the viewport, matching ReadingText.tsx. */
  function scrollIfNeeded(range) {
    const rect = range.getBoundingClientRect();
    if (rect.top >= 0 && rect.bottom <= window.innerHeight) return;
    range.startContainer.parentElement?.scrollIntoView({ block: "nearest" });
  }

  window.__readaloud = {
    get words() {
      return state.words;
    },

    /**
     * Extract the article and index its words against the live DOM.
     *
     * @param {{fromSelection?: boolean}} options When fromSelection is true,
     *   the returned text starts at the first word the current selection
     *   touches.
     * @returns {{title: string, text: string, wordCount: number,
     *   startWordIndex: number} | null} Null when nothing was extractable.
     */
    buildIndex({ fromSelection = false } = {}) {
      stampAll();
      try {
        const parsed = parseArticle();
        if (!parsed) return null;

        const words = collectWords(parsed.ids);
        if (!words.length) return null;
        state.words = words;

        const startWordIndex = fromSelection ? selectionStartIndex(words) : 0;
        if (startWordIndex === -1) return null;
        return {
          title: parsed.title,
          text: joinWords(words, startWordIndex),
          wordCount: words.length - startWordIndex,
          startWordIndex,
        };
      } finally {
        unstampAll();
      }
    },

    /** Highlight word `index` of the current index, if it is still on the page. */
    highlight(index) {
      const range = rangeFor(state.words[index]);
      if (!range) return;
      ensureStyle();
      CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(range));
      scrollIfNeeded(range);
    },

    /** Remove the highlight and the stylesheet it needed. */
    clear() {
      CSS.highlights.delete(HIGHLIGHT_NAME);
      removeStyle();
    },
  };

  browser.runtime.onMessage.addListener((message) => {
    if (message.type === "readaloudHighlight") window.__readaloud.highlight(message.index);
    else if (message.type === "readaloudClear") window.__readaloud.clear();
  });
})();
