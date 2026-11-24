import { beforeEach, describe, expect, it, vi } from "vitest";

import { chunkCache } from "/lib/chunk-cache.js";

function fakeBrowser() {
  return {
    runtime: { sendMessage: vi.fn(async () => {}), onMessage: { addListener: vi.fn() } },
    contextMenus: { create: vi.fn(), onClicked: { addListener: vi.fn() } },
    browserAction: {
      setBadgeText: vi.fn(async () => {}),
      setBadgeBackgroundColor: vi.fn(async () => {}),
    },
    tabs: {
      query: vi.fn(async () => [{ id: 7, url: "https://example.com" }]),
      executeScript: vi.fn(),
      sendMessage: vi.fn(async () => {}),
      update: vi.fn(async () => {}),
      onRemoved: { addListener: vi.fn() },
    },
    windows: { update: vi.fn(async () => {}) },
    webNavigation: { onCommitted: { addListener: vi.fn() } },
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
  };
}

let audioElements;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  chunkCache.clear();
  globalThis.browser = fakeBrowser();
  audioElements = [];
  globalThis.Audio = class {
    constructor() {
      this.currentTime = 0;
      this.playbackRate = 1;
      this.paused = true;
      audioElements.push(this);
    }
    play() {
      this.paused = false;
      return Promise.resolve();
    }
    pause() {
      this.paused = true;
    }
  };
});

describe("highlight orchestration", () => {
  it("sends the global word index for the active cue", async () => {
    const { __testing } = await import("/background.js");
    __testing.startHighlighting({ tabId: 7, wordOffset: 0, wordCount: 4 });
    __testing.recordChunkCues({ index: 0, cues: [
      { text: "one", start: 0, end: 1 },
      { text: "two", start: 1, end: 2 },
    ] });
    __testing.recordChunkCues({ index: 1, cues: [
      { text: "three", start: 0, end: 1 },
      { text: "four", start: 1, end: 2 },
    ] });

    __testing.setPosition(1, 1.5);
    __testing.highlightTick();

    expect(browser.tabs.sendMessage).toHaveBeenCalledWith(7, {
      type: "readaloudHighlight",
      index: 3,
    });
  });

  it("sends nothing when the active word has not changed", async () => {
    const { __testing } = await import("/background.js");
    __testing.startHighlighting({ tabId: 7, wordOffset: 0, wordCount: 2 });
    __testing.recordChunkCues({ index: 0, cues: [{ text: "one", start: 0, end: 1 }] });

    __testing.setPosition(0, 0.5);
    __testing.highlightTick();
    __testing.highlightTick();

    expect(browser.tabs.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("offsets by the read-from-here start word", async () => {
    const { __testing } = await import("/background.js");
    __testing.startHighlighting({ tabId: 7, wordOffset: 10, wordCount: 1 });
    __testing.recordChunkCues({ index: 0, cues: [{ text: "one", start: 0, end: 1 }] });

    __testing.setPosition(0, 0.5);
    __testing.highlightTick();

    expect(browser.tabs.sendMessage).toHaveBeenCalledWith(7, {
      type: "readaloudHighlight",
      index: 10,
    });
  });

  it("disables highlighting when a chunk yields no cues", async () => {
    const { __testing } = await import("/background.js");
    __testing.startHighlighting({ tabId: 7, wordOffset: 0, wordCount: 2 });
    __testing.recordChunkCues({ index: 0, cues: [] });

    __testing.setPosition(0, 0.5);
    __testing.highlightTick();

    expect(browser.tabs.sendMessage).not.toHaveBeenCalledWith(
      7,
      expect.objectContaining({ type: "readaloudHighlight" }),
    );
  });

  it("disables highlighting when the cue count overruns the word count", async () => {
    const { __testing } = await import("/background.js");
    __testing.startHighlighting({ tabId: 7, wordOffset: 0, wordCount: 1 });
    __testing.recordChunkCues({ index: 0, cues: [
      { text: "one", start: 0, end: 1 },
      { text: "two", start: 1, end: 2 },
    ] });

    __testing.setPosition(0, 0.5);
    __testing.highlightTick();

    expect(browser.tabs.sendMessage).not.toHaveBeenCalledWith(
      7,
      expect.objectContaining({ type: "readaloudHighlight" }),
    );
  });

  it("clears the highlight when stopping", async () => {
    const { __testing } = await import("/background.js");
    __testing.startHighlighting({ tabId: 7, wordOffset: 0, wordCount: 1 });

    __testing.stopHighlighting();

    expect(browser.tabs.sendMessage).toHaveBeenCalledWith(7, { type: "readaloudClear" });
  });

  it("disables highlighting when the final chunk's cues undercount the word count", async () => {
    const { __testing } = await import("/background.js");
    __testing.startHighlighting({ tabId: 7, wordOffset: 0, wordCount: 3 });
    __testing.recordChunkCues({
      index: 0,
      total: 1,
      cues: [
        { text: "one", start: 0, end: 1 },
        { text: "two", start: 1, end: 2 },
      ],
    });

    __testing.setPosition(0, 0.5);
    __testing.highlightTick();

    expect(browser.tabs.sendMessage).not.toHaveBeenCalledWith(
      7,
      expect.objectContaining({ type: "readaloudHighlight" }),
    );
  });

  it("passes chunks through captureCues unchanged while recording their cues", async () => {
    const { __testing } = await import("/background.js");
    __testing.startHighlighting({ tabId: 7, wordOffset: 0, wordCount: 2 });

    async function* fakeGenerator() {
      yield { audio: "blob0", index: 0, total: 2, cues: [{ text: "one", start: 0, end: 1 }] };
      yield { audio: "blob1", index: 1, total: 2, cues: [{ text: "two", start: 0, end: 1 }] };
    }

    const items = [];
    for await (const item of __testing.captureCues(fakeGenerator())) {
      items.push(item);
    }

    expect(items).toEqual([
      { audio: "blob0", index: 0, total: 2, cues: [{ text: "one", start: 0, end: 1 }] },
      { audio: "blob1", index: 1, total: 2, cues: [{ text: "two", start: 0, end: 1 }] },
    ]);

    __testing.setPosition(1, 0.5);
    __testing.highlightTick();
    expect(browser.tabs.sendMessage).toHaveBeenCalledWith(7, {
      type: "readaloudHighlight",
      index: 1,
    });
  });

  it("sends the highlight via the running interval, not just a manual tick", async () => {
    const { __testing } = await import("/background.js");
    __testing.startHighlighting({ tabId: 7, wordOffset: 0, wordCount: 1 });
    __testing.recordChunkCues({ index: 0, total: 1, cues: [{ text: "one", start: 0, end: 1 }] });
    __testing.setPosition(0, 0.5);

    vi.advanceTimersByTime(100);

    expect(browser.tabs.sendMessage).toHaveBeenCalledWith(7, {
      type: "readaloudHighlight",
      index: 0,
    });
  });
});

describe("buildPageIndex", () => {
  it("injects content-reader.js (regression check for the removed content.js reference)", async () => {
    const { __testing } = await import("/background.js");

    await __testing.buildPageIndex({ id: 7 });

    expect(browser.tabs.executeScript).toHaveBeenNthCalledWith(2, 7, {
      file: "content-reader.js",
    });
  });
});

const ARTICLE_TAB = { id: 7, windowId: 3, title: "An Article", url: "https://example.com/a" };
const OTHER_TAB = { id: 8, windowId: 3, title: "Another Article", url: "https://example.com/b" };

const listenerOf = (event) => event.addListener.mock.calls[0][0];
const send = (message) => listenerOf(browser.runtime.onMessage)(message);
const getState = () => send({ type: "getState" });
const okJson = (body) => ({ ok: true, json: async () => body });

/** Article text per tab; a tab mapped to a promise extracts when it settles. */
function serveArticles(byTabId) {
  browser.tabs.executeScript.mockImplementation(async (tabId, details) => {
    if (!details.code?.includes("buildIndex")) return [undefined];
    const text = await byTabId[tabId];
    return [{ text, startWordIndex: 0, wordCount: text.split(" ").length }];
  });
}

/** A ReadAloud backend that answers every read with one complete chunk. */
function fakeBackend() {
  globalThis.fetch = vi.fn(async (url, options = {}) => {
    if (options.method === "HEAD") return { headers: { get: () => "text/html" } };
    if (url.endsWith("/api/settings")) return okJson({ max_chunk_chars: 4000 });
    if (url.endsWith("/api/tts/generate")) return okJson({ status: "complete", job_id: "j", cues: [] });
    if (url.includes("/api/tts/audio/")) return { ok: true, blob: async () => new Blob(["mp3"]) };
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

const synthesizedTexts = () =>
  fetch.mock.calls
    .filter(([url]) => url.endsWith("/api/tts/generate"))
    .map(([, options]) => JSON.parse(options.body).text);

async function readPage(tab) {
  browser.tabs.query.mockResolvedValueOnce([tab]);
  await send({ type: "readPage" });
}

async function waitForPhase(phase) {
  await vi.waitFor(async () => expect((await getState()).phase).toBe(phase));
}

async function startReading(tab = ARTICLE_TAB) {
  await import("/background.js");
  fakeBackend();
  serveArticles({ [tab.id]: "Hello world" });
  await readPage(tab);
  await waitForPhase("playing");
}

describe("read sessions", () => {
  it("reports the tab being read", async () => {
    await startReading();

    expect((await getState()).tab).toEqual({ id: 7, windowId: 3, title: "An Article" });
  });

  it("stops reading when the reading tab is closed", async () => {
    await startReading();

    listenerOf(browser.tabs.onRemoved)(7, {});

    expect((await getState()).phase).toBe("idle");
    expect(audioElements[0].paused).toBe(true);
  });

  it("keeps reading when a different tab is closed", async () => {
    await startReading();

    listenerOf(browser.tabs.onRemoved)(99, {});

    expect((await getState()).phase).toBe("playing");
  });

  it("stops reading when the reading tab loads a new page", async () => {
    await startReading();

    listenerOf(browser.webNavigation.onCommitted)({ tabId: 7, frameId: 0, url: "https://x.org" });

    expect((await getState()).phase).toBe("idle");
  });

  it("keeps reading when a frame inside the reading tab navigates", async () => {
    await startReading();

    listenerOf(browser.webNavigation.onCommitted)({ tabId: 7, frameId: 4, url: "https://ad.example" });

    expect((await getState()).phase).toBe("playing");
  });

  it("badges the reading tab until the read stops", async () => {
    await startReading();
    expect(browser.browserAction.setBadgeText).toHaveBeenCalledWith({ tabId: 7, text: "▶" });

    await send({ type: "stop" });

    expect(browser.browserAction.setBadgeText).toHaveBeenCalledWith({ tabId: 7, text: null });
    expect((await getState()).tab).toBeNull();
  });

  it("switches to the reading tab on request", async () => {
    await startReading();

    await send({ type: "showReadingTab" });

    expect(browser.tabs.update).toHaveBeenCalledWith(7, { active: true });
    expect(browser.windows.update).toHaveBeenCalledWith(3, { focused: true });
  });

  it("does not start a read that was stopped while extracting", async () => {
    await import("/background.js");
    fakeBackend();
    let finishExtraction;
    serveArticles({ 7: new Promise((resolve) => (finishExtraction = resolve)) });

    await readPage(ARTICLE_TAB);
    await waitForPhase("extracting");
    await send({ type: "stop" });
    finishExtraction("Too late");
    await vi.advanceTimersByTimeAsync(100);

    expect(synthesizedTexts()).toEqual([]);
    expect((await getState()).phase).toBe("idle");
  });

  it("does not start a read that was stopped while preparing its chunks", async () => {
    await import("/background.js");
    fakeBackend();
    const backend = fetch.getMockImplementation();
    let answerSettings;
    fetch.mockImplementation((url, options) =>
      url.endsWith("/api/settings")
        ? new Promise((resolve) => (answerSettings = resolve))
        : backend(url, options),
    );
    serveArticles({ 7: "Hello world" });

    await readPage(ARTICLE_TAB);
    await waitForPhase("generating");
    await send({ type: "stop" });
    // Not ok: buildKnownChunks returns at once instead of hashing on real time.
    answerSettings({ ok: false });
    await vi.advanceTimersByTimeAsync(100);

    expect(synthesizedTexts()).toEqual([]);
    expect((await getState()).phase).toBe("idle");
  });

  it("does not let a replaced read take over from the read that replaced it", async () => {
    await import("/background.js");
    fakeBackend();
    let finishFirstExtraction;
    serveArticles({
      7: new Promise((resolve) => (finishFirstExtraction = resolve)),
      8: "Second article",
    });

    await readPage(ARTICLE_TAB);
    await waitForPhase("extracting");
    await readPage(OTHER_TAB);
    await waitForPhase("playing");
    finishFirstExtraction("First article");
    await vi.advanceTimersByTimeAsync(100);

    expect(synthesizedTexts()).toEqual(["Second article"]);
    const state = await getState();
    expect(state.phase).toBe("playing");
    expect(state.tab.id).toBe(8);
  });
});
