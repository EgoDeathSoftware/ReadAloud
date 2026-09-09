import { beforeEach, describe, expect, it, vi } from "vitest";

import { chunkCache } from "/lib/chunk-cache.js";
import { backendAdapter } from "./backend.js";
import { pickAdapter } from "./index.js";
import { openaiAdapter } from "./openai.js";

const settings = { backendUrl: "http://localhost:8000" };

function jsonResponse(body, status = 200) {
  return { ok: status < 400, status, json: async () => body, text: async () => "" };
}

function blobResponse() {
  return { ok: true, status: 200, blob: async () => new Blob(["audio"], { type: "audio/mpeg" }) };
}

async function collect(generator) {
  const out = [];
  for await (const item of generator) out.push(item);
  return out;
}

function run(overrides = {}) {
  return collect(
    backendAdapter.synthesize({
      text: "Hello.",
      voice: "af_heart",
      settings,
      signal: new AbortController().signal,
      onProgress: () => {},
      ...overrides,
    }),
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  chunkCache.clear();
});

describe("pickAdapter", () => {
  it("returns the backend adapter for the backend target", () => {
    expect(pickAdapter({ ttsTarget: "backend" })).toBe(backendAdapter);
  });

  it("returns the direct adapter for the direct target", () => {
    expect(pickAdapter({ ttsTarget: "direct" })).toBe(openaiAdapter);
  });

  it("defaults to the backend adapter for an unknown target", () => {
    expect(pickAdapter({ ttsTarget: "nonsense" })).toBe(backendAdapter);
  });
});

describe("synthesize", () => {
  it("yields immediately when the job completes synchronously", async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (url.endsWith("/api/tts/generate")) {
        return jsonResponse({ job_id: "j1", status: "complete" });
      }
      return blobResponse();
    });

    const results = await run();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ index: 0, total: 1 });
    expect(globalThis.fetch.mock.calls.at(-1)[0]).toBe("http://localhost:8000/api/tts/audio/j1");
  });

  it("polls and yields each chunk as it becomes ready", async () => {
    const statuses = [
      { status: "processing", progress: 0.5, chunks_completed: 1, chunks_total: 2 },
      { status: "complete", progress: 1, chunks_completed: 2, chunks_total: 2 },
    ];
    let poll = 0;
    const fetched = [];

    globalThis.fetch = vi.fn(async (url) => {
      fetched.push(url);
      if (url.endsWith("/api/tts/generate")) {
        return jsonResponse({ job_id: "j2", status: "processing" });
      }
      if (url.includes("/api/tts/status/")) {
        return jsonResponse(statuses[Math.min(poll++, statuses.length - 1)]);
      }
      return blobResponse();
    });

    const results = await run();
    expect(results.map((r) => r.index)).toEqual([0, 1]);
    expect(fetched).toContain("http://localhost:8000/api/tts/audio/j2/0");
    expect(fetched).toContain("http://localhost:8000/api/tts/audio/j2/1");
  });

  it("throws with the job error when the job fails", async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (url.endsWith("/api/tts/generate")) {
        return jsonResponse({ job_id: "j3", status: "processing" });
      }
      return jsonResponse({
        status: "failed",
        error: "upstream refused",
        progress: 0,
        chunks_completed: 0,
        chunks_total: 3,
      });
    });

    await expect(run()).rejects.toThrow(/upstream refused/);
  });

  it("reports progress from the poll response", async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (url.endsWith("/api/tts/generate")) {
        return jsonResponse({ job_id: "j4", status: "processing" });
      }
      if (url.includes("/api/tts/status/")) {
        return jsonResponse({
          status: "complete",
          progress: 1,
          chunks_completed: 1,
          chunks_total: 1,
        });
      }
      return blobResponse();
    });

    const progress = [];
    await run({ onProgress: (p) => progress.push(p) });
    expect(progress.at(-1)).toMatchObject({ chunksTotal: 1, progress: 1 });
  });

  it("surfaces a non-ok generate response", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({}, 500));
    await expect(run()).rejects.toThrow(/500/);
  });

  it("sends known_chunks in the generate request body", async () => {
    let sentBody = null;
    globalThis.fetch = vi.fn(async (url, options) => {
      if (url.endsWith("/api/tts/generate")) {
        sentBody = JSON.parse(options.body);
        return jsonResponse({ job_id: "j5", status: "complete" });
      }
      return blobResponse();
    });

    await run({ knownChunks: [{ hash: "abc123", audioB64: "ZmFrZQ==" }] });
    expect(sentBody.known_chunks).toEqual([{ hash: "abc123", audio_b64: "ZmFrZQ==" }]);
  });

  it("omits known_chunks from the body when there are none", async () => {
    let sentBody = null;
    globalThis.fetch = vi.fn(async (url, options) => {
      if (url.endsWith("/api/tts/generate")) {
        sentBody = JSON.parse(options.body);
        return jsonResponse({ job_id: "j6", status: "complete" });
      }
      return blobResponse();
    });

    await run();
    expect(sentBody.known_chunks).toBeUndefined();
  });

  it("plays a client_cache-sourced chunk from the local cache without fetching its audio", async () => {
    const cachedBlob = new Blob(["cached"], { type: "audio/mpeg" });
    chunkCache.set("af_heart", "hash-a", cachedBlob);

    const fetchedAudioUrls = [];
    globalThis.fetch = vi.fn(async (url) => {
      fetchedAudioUrls.push(url);
      if (url.endsWith("/api/tts/generate")) {
        return jsonResponse({ job_id: "j7", status: "processing" });
      }
      if (url.includes("/api/tts/status/")) {
        return jsonResponse({
          status: "complete",
          progress: 1,
          chunks_completed: 1,
          chunks_total: 1,
          chunks: [{ index: 0, hash: "hash-a", source: "client_cache" }],
        });
      }
      return blobResponse();
    });

    const results = await run({ voice: "af_heart" });
    expect(results[0].audio).toBe(cachedBlob);
    expect(fetchedAudioUrls.some((u) => u.includes("/api/tts/audio/"))).toBe(false);
  });

  it("fetches and caches a synthesized chunk under its reported hash", async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (url.endsWith("/api/tts/generate")) {
        return jsonResponse({ job_id: "j8", status: "processing" });
      }
      if (url.includes("/api/tts/status/")) {
        return jsonResponse({
          status: "complete",
          progress: 1,
          chunks_completed: 1,
          chunks_total: 1,
          chunks: [{ index: 0, hash: "hash-b", source: "synthesized" }],
        });
      }
      return blobResponse();
    });

    await run({ voice: "af_heart" });
    expect(chunkCache.get("af_heart", "hash-b")).not.toBeNull();
  });

  it("yields the cues from the generate response on the short-text path", async () => {
    const cues = [{ text: "Hello.", start: 0, end: 1 }];
    globalThis.fetch = vi.fn(async (url) => {
      if (url.endsWith("/api/tts/generate")) {
        return jsonResponse({ job_id: "j1", status: "complete", cues });
      }
      return blobResponse();
    });

    const items = await run();

    expect(items[0].cues).toEqual(cues);
  });

  it("yields each chunk's cues from the status response", async () => {
    const chunkCues = [
      [{ text: "one", start: 0, end: 1 }],
      [{ text: "two", start: 0, end: 1 }],
    ];
    globalThis.fetch = vi.fn(async (url) => {
      if (url.endsWith("/api/tts/generate")) {
        return jsonResponse({ job_id: "j1", status: "processing" });
      }
      if (url.includes("/api/tts/status/")) {
        return jsonResponse({
          status: "complete",
          progress: 1,
          chunks_completed: 2,
          chunks_total: 2,
          chunks: [
            { index: 0, hash: "h0", source: "synthesized", cues: chunkCues[0] },
            { index: 1, hash: "h1", source: "synthesized", cues: chunkCues[1] },
          ],
        });
      }
      return blobResponse();
    });

    const items = await run();

    expect(items.map((item) => item.cues)).toEqual(chunkCues);
  });

  it("restores cues from the chunk cache on a client_cache hit", async () => {
    const cues = [{ text: "cached", start: 0, end: 1 }];
    chunkCache.set("af_heart", "h0", new Blob(["audio"]), cues);
    globalThis.fetch = vi.fn(async (url) => {
      if (url.endsWith("/api/tts/generate")) {
        return jsonResponse({ job_id: "j1", status: "processing" });
      }
      if (url.includes("/api/tts/status/")) {
        return jsonResponse({
          status: "complete",
          progress: 1,
          chunks_completed: 1,
          chunks_total: 1,
          chunks: [{ index: 0, hash: "h0", source: "client_cache", cues: [] }],
        });
      }
      return blobResponse();
    });

    const items = await run();

    expect(items[0].cues).toEqual(cues);
  });
});
