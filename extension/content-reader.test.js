// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadScript } from "/tests/load-script.js";

// Readability needs ~500 characters of article text before it will parse.
const PARAGRAPH =
  "Local text to speech has become practical on ordinary hardware in the last " +
  "year, and the models are now small enough to run beside a browser without " +
  "a dedicated graphics card or a paid API subscription of any kind at all.";

function pageWith(bodyHtml) {
  document.body.innerHTML = bodyHtml;
}

function article(extra = "") {
  return `
    <nav><a href="/">Home</a><a href="/about">About</a></nav>
    <article>
      <p id="p1">${PARAGRAPH}</p>
      <p id="p2">${PARAGRAPH}</p>
      ${extra}
    </article>
    <footer><p>Copyright notice that is not part of the article body.</p></footer>
  `;
}

beforeEach(() => {
  globalThis.browser = { runtime: { onMessage: { addListener: vi.fn() } } };
  delete window.__readaloud;
  loadScript("Readability.js", ["Readability"]);
  loadScript("content-reader.js");
});

describe("buildIndex", () => {
  it("returns the article text and a word per index entry", () => {
    pageWith(article());

    const result = window.__readaloud.buildIndex();

    expect(result.text).toContain("Local text to speech");
    expect(result.wordCount).toBe(result.text.split(/\s+/).filter(Boolean).length);
  });

  it("separates paragraphs with a blank line", () => {
    pageWith(article());

    const { text } = window.__readaloud.buildIndex();

    expect(text).toContain("at all.\n\nLocal text");
  });

  it("excludes navigation and footer text Readability dropped", () => {
    pageWith(article());

    const { text } = window.__readaloud.buildIndex();

    expect(text).not.toContain("Copyright notice");
    expect(text).not.toContain("Home");
  });

  it("leaves no stamp attributes on the page", () => {
    pageWith(article());

    window.__readaloud.buildIndex();

    expect(document.querySelectorAll("[data-ra-id]")).toHaveLength(0);
  });

  it("maps each word to a range over the live text node", () => {
    pageWith(article());

    window.__readaloud.buildIndex();
    const first = window.__readaloud.words[0];

    expect(first.text).toBe("Local");
    expect(first.node.parentElement.id).toBe("p1");
    expect(first.node.data.slice(first.start, first.end)).toBe("Local");
  });

  it("is idempotent under repeated injection", () => {
    pageWith(article());
    window.__readaloud.buildIndex();
    const before = window.__readaloud.words.length;

    loadScript("content-reader.js");

    expect(window.__readaloud.words.length).toBe(before);
  });

  it("returns null when nothing can be extracted", () => {
    // A short paragraph still yields content (Readability only returns null
    // when extraction finds no text at all, not merely under its char
    // threshold), so this fixture must have no extractable text.
    pageWith("");

    expect(window.__readaloud.buildIndex()).toBeNull();
  });

  it("truncates at a word boundary when the article exceeds 50,000 characters", () => {
    const word = "abcdefghij";
    const bigParagraph = Array.from({ length: 6000 }, () => word).join(" ");
    pageWith(article(`<p id="p3">${bigParagraph}</p>`));

    const { text } = window.__readaloud.buildIndex();

    expect(text.length).toBeLessThanOrEqual(50_000);
    const lastToken = text.trim().split(/\s+/).pop();
    expect(lastToken).toBe(word);
  });
});

describe("buildIndex from a selection", () => {
  it("starts at the first word the selection touches", () => {
    pageWith(article());
    window.__readaloud.buildIndex();
    const target = window.__readaloud.words.find((word) => word.node.parentElement.id === "p2");

    const range = document.createRange();
    range.setStart(target.node, target.start);
    range.setEnd(target.node, target.end);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);

    const result = window.__readaloud.buildIndex({ fromSelection: true });

    expect(result.text.startsWith("Local text to speech")).toBe(true);
    expect(result.startWordIndex).toBeGreaterThan(0);
    expect(result.wordCount).toBe(window.__readaloud.words.length - result.startWordIndex);
  });
});
