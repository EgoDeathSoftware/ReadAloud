import { beforeEach, describe, expect, it, vi } from "vitest";

import { chunkCache } from "/lib/chunk-cache.js";

function fakeBrowser() {
  return {
    runtime: { sendMessage: vi.fn(async () => {}), onMessage: { addListener: vi.fn() } },
    contextMenus: { create: vi.fn(), onClicked: { addListener: vi.fn() } },
    tabs: {
      query: vi.fn(async () => [{ id: 7, url: "https://example.com" }]),
      executeScript: vi.fn(),
      sendMessage: vi.fn(async () => {}),
    },
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  chunkCache.clear();
  globalThis.browser = fakeBrowser();
  globalThis.Audio = class {
    constructor() {
      this.currentTime = 0;
      this.playbackRate = 1;
    }
    play() {
      return Promise.resolve();
    }
    pause() {}
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
