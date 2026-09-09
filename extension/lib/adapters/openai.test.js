import { beforeEach, describe, expect, it, vi } from "vitest";

import { chunkCache } from "/lib/chunk-cache.js";

vi.mock("/lib/audio-duration.js", () => ({ measureDuration: async () => 2 }));

const settings = {
  directUrl: "http://localhost:8880",
  directApiKey: "",
  directModel: "kokoro",
};

const directSettings = { directUrl: "http://localhost:8880", directModel: "kokoro" };

function captionedResponse(timestamps) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ audio: btoa("audio"), timestamps }),
  };
}

function notFoundResponse() {
  return { ok: false, status: 404, json: async () => ({}) };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function blobResponse(bytes) {
  return { ok: true, status: 200, blob: async () => new Blob([bytes], { type: "audio/mpeg" }) };
}

function errorResponse(body, status, headers = {}) {
  return {
    ok: false,
    status,
    headers: { get: (name) => headers[name] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** Routes `/dev/captioned_speech` to a 404 so tests can focus on the `/v1/audio/speech` path. */
function speechOnlyFetch(handler) {
  return vi.fn(async (url, options) => {
    if (url.includes("/dev/captioned_speech")) return notFoundResponse();
    return handler(url, options);
  });
}

async function collect(generator) {
  const out = [];
  for await (const item of generator) out.push(item);
  return out;
}

function synth(openaiAdapter, overrides = {}) {
  return openaiAdapter.synthesize({
    text: "Hello.",
    voice: "af_heart",
    settings,
    signal: new AbortController().signal,
    onProgress: () => {},
    ...overrides,
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  chunkCache.clear();
});

describe("listVoices", () => {
  it("reads Kokoro's {voices: [{id}]} shape", async () => {
    const { openaiAdapter } = await import("./openai.js");
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ voices: [{ id: "af_heart", name: "Heart" }, { id: "am_adam" }] }),
    );
    await expect(openaiAdapter.listVoices(settings)).resolves.toEqual([
      { id: "af_heart", name: "Heart" },
      { id: "am_adam", name: "am_adam" },
    ]);
  });

  it("reads a bare array of voice id strings", async () => {
    const { openaiAdapter } = await import("./openai.js");
    globalThis.fetch = vi.fn(async () => jsonResponse(["af_heart", "am_adam"]));
    await expect(openaiAdapter.listVoices(settings)).resolves.toEqual([
      { id: "af_heart", name: "af_heart" },
      { id: "am_adam", name: "am_adam" },
    ]);
  });

  it("falls back to the built-in OpenAI voices when the endpoint 404s", async () => {
    const { openaiAdapter } = await import("./openai.js");
    globalThis.fetch = vi.fn(async () => jsonResponse({ detail: "Not Found" }, 404));
    const voices = await openaiAdapter.listVoices(settings);
    expect(voices.map((v) => v.id)).toContain("alloy");
    expect(voices.map((v) => v.id)).toContain("nova");
  });

  it("falls back when the network throws", async () => {
    const { openaiAdapter } = await import("./openai.js");
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("NetworkError");
    });
    await expect(openaiAdapter.listVoices(settings)).resolves.not.toHaveLength(0);
  });
});

describe("synthesize", () => {
  it("does not re-request a chunk already in the cache", async () => {
    const { openaiAdapter } = await import("./openai.js");
    let calls = 0;
    globalThis.fetch = speechOnlyFetch(async () => {
      calls += 1;
      return blobResponse("audio");
    });

    await collect(synth(openaiAdapter));
    expect(calls).toBe(1);

    await collect(synth(openaiAdapter));
    expect(calls).toBe(1);
  });

  it("caches per voice, so a different voice still requests", async () => {
    const { openaiAdapter } = await import("./openai.js");
    let calls = 0;
    globalThis.fetch = speechOnlyFetch(async () => {
      calls += 1;
      return blobResponse("audio");
    });

    await collect(synth(openaiAdapter, { voice: "af_heart" }));
    await collect(synth(openaiAdapter, { voice: "am_adam" }));
    expect(calls).toBe(2);
  });

  it("posts one request per chunk and yields a blob each", async () => {
    const { openaiAdapter } = await import("./openai.js");
    const calls = [];
    globalThis.fetch = speechOnlyFetch(async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return blobResponse("audio");
    });

    const progress = [];
    const results = await collect(
      synth(openaiAdapter, {
        text: "A".repeat(5000) + "\n\n" + "B".repeat(100),
        onProgress: (p) => progress.push(p),
      }),
    );

    expect(results.length).toBeGreaterThan(1);
    expect(results[0].audio).toBeInstanceOf(Blob);
    expect(results[0].total).toBe(results.length);
    expect(calls[0].url).toBe("http://localhost:8880/v1/audio/speech");
    expect(calls[0].body).toMatchObject({
      model: "kokoro",
      voice: "af_heart",
      response_format: "mp3",
    });
    expect(progress.at(-1)).toMatchObject({ progress: 1 });
  });

  it("omits the Authorization header when no key is set", async () => {
    const { openaiAdapter } = await import("./openai.js");
    let seen = null;
    globalThis.fetch = speechOnlyFetch(async (_url, options) => {
      seen = options.headers;
      return blobResponse("audio");
    });
    await collect(synth(openaiAdapter));
    expect(seen.Authorization).toBeUndefined();
  });

  it("sends a bearer token when a key is set", async () => {
    const { openaiAdapter } = await import("./openai.js");
    let seen = null;
    globalThis.fetch = speechOnlyFetch(async (_url, options) => {
      seen = options.headers;
      return blobResponse("audio");
    });
    await collect(
      synth(openaiAdapter, { settings: { ...settings, directApiKey: "sk-abc" }, voice: "alloy" }),
    );
    expect(seen.Authorization).toBe("Bearer sk-abc");
  });

  it("retries a failed chunk then succeeds", async () => {
    const { openaiAdapter } = await import("./openai.js");
    let attempts = 0;
    globalThis.fetch = speechOnlyFetch(async () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("NetworkError");
      return blobResponse("audio");
    });
    const results = await collect(synth(openaiAdapter));
    expect(attempts).toBe(2);
    expect(results).toHaveLength(1);
  });

  it("surfaces the OpenAI error message after exhausting retries", async () => {
    const { openaiAdapter } = await import("./openai.js");
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ error: { message: "Invalid voice: bogus" } }, 400),
    );
    await expect(collect(synth(openaiAdapter, { voice: "bogus" }))).rejects.toThrow(
      /Invalid voice: bogus/,
    );
  });

  it("does not retry a 400 (permanent failure)", async () => {
    const { openaiAdapter } = await import("./openai.js");
    let attempts = 0;
    globalThis.fetch = vi.fn(async () => {
      attempts += 1;
      return errorResponse({ error: { message: "Invalid voice: bogus" } }, 400);
    });
    await expect(collect(synth(openaiAdapter, { voice: "bogus" }))).rejects.toThrow(
      /Invalid voice: bogus/,
    );
    expect(attempts).toBe(1);
  });

  it("retries a 429 honoring the Retry-After header", async () => {
    const { openaiAdapter } = await import("./openai.js");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let attempts = 0;
      globalThis.fetch = speechOnlyFetch(async () => {
        attempts += 1;
        if (attempts === 1) {
          return errorResponse(
            { error: { message: "rate limited" } },
            429,
            { "Retry-After": "7" },
          );
        }
        return blobResponse("audio");
      });
      const sleepSpy = vi.spyOn(globalThis, "setTimeout");
      const resultsPromise = collect(synth(openaiAdapter));
      // synthesize() now hashes the chunk (a real, setImmediate-backed async
      // op) before its first fetch attempt. Let that settle on the real event
      // loop before advancing fake time, or the retry's setTimeout call never
      // gets scheduled in time for advanceTimersByTimeAsync to see it.
      await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(7000);
      const results = await resultsPromise;
      expect(attempts).toBe(2);
      expect(results).toHaveLength(1);
      expect(sleepSpy).toHaveBeenCalledWith(expect.any(Function), 7000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts without retrying when the signal fires", async () => {
    const { openaiAdapter } = await import("./openai.js");
    const controller = new AbortController();
    globalThis.fetch = vi.fn(async () => {
      controller.abort();
      throw new DOMException("Aborted", "AbortError");
    });
    await expect(collect(synth(openaiAdapter, { signal: controller.signal }))).rejects.toThrow(
      /Aborted/,
    );
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("uses captioned speech timestamps for cues", async () => {
    const { openaiAdapter } = await import("./openai.js");
    globalThis.fetch = vi.fn(async (url) => {
      expect(url).toContain("/dev/captioned_speech");
      return captionedResponse([
        { word: "Hello", start_time: 0, end_time: 0.5 },
        { word: "there", start_time: 0.5, end_time: 1 },
      ]);
    });

    const items = await collect(
      openaiAdapter.synthesize({
        text: "Hello there",
        voice: "af_heart",
        settings: directSettings,
        signal: new AbortController().signal,
        onProgress: () => {},
      }),
    );

    expect(items[0].cues.map((c) => c.text)).toEqual(["Hello", "there"]);
    expect(items[0].cues[0].start).toBe(0);
  });

  it("falls back to /v1/audio/speech when captioned speech is not implemented", async () => {
    const { openaiAdapter } = await import("./openai.js");
    const seen = [];
    globalThis.fetch = vi.fn(async (url) => {
      seen.push(url);
      if (url.includes("/dev/captioned_speech")) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, blob: async () => new Blob(["audio"], { type: "audio/mpeg" }) };
    });

    const items = await collect(
      openaiAdapter.synthesize({
        text: "Hello there",
        voice: "af_heart",
        settings: directSettings,
        signal: new AbortController().signal,
        onProgress: () => {},
      }),
    );

    expect(seen.some((url) => url.includes("/dev/captioned_speech"))).toBe(true);
    expect(seen.some((url) => url.includes("/v1/audio/speech"))).toBe(true);
    expect(items[0].cues.map((c) => c.text)).toEqual(["Hello", "there"]);
  });
});
