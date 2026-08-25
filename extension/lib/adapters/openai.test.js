import { beforeEach, describe, expect, it, vi } from "vitest";

import { openaiAdapter } from "./openai.js";

const settings = {
  directUrl: "http://localhost:8880",
  directApiKey: "",
  directModel: "kokoro",
};

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

async function collect(generator) {
  const out = [];
  for await (const item of generator) out.push(item);
  return out;
}

function synth(overrides = {}) {
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
});

describe("listVoices", () => {
  it("reads Kokoro's {voices: [{id}]} shape", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ voices: [{ id: "af_heart", name: "Heart" }, { id: "am_adam" }] }),
    );
    await expect(openaiAdapter.listVoices(settings)).resolves.toEqual([
      { id: "af_heart", name: "Heart" },
      { id: "am_adam", name: "am_adam" },
    ]);
  });

  it("reads a bare array of voice id strings", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse(["af_heart", "am_adam"]));
    await expect(openaiAdapter.listVoices(settings)).resolves.toEqual([
      { id: "af_heart", name: "af_heart" },
      { id: "am_adam", name: "am_adam" },
    ]);
  });

  it("falls back to the built-in OpenAI voices when the endpoint 404s", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ detail: "Not Found" }, 404));
    const voices = await openaiAdapter.listVoices(settings);
    expect(voices.map((v) => v.id)).toContain("alloy");
    expect(voices.map((v) => v.id)).toContain("nova");
  });

  it("falls back when the network throws", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("NetworkError");
    });
    await expect(openaiAdapter.listVoices(settings)).resolves.not.toHaveLength(0);
  });
});

describe("synthesize", () => {
  it("posts one request per chunk and yields a blob each", async () => {
    const calls = [];
    globalThis.fetch = vi.fn(async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return blobResponse("audio");
    });

    const progress = [];
    const results = await collect(
      synth({
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
    let seen = null;
    globalThis.fetch = vi.fn(async (_url, options) => {
      seen = options.headers;
      return blobResponse("audio");
    });
    await collect(synth());
    expect(seen.Authorization).toBeUndefined();
  });

  it("sends a bearer token when a key is set", async () => {
    let seen = null;
    globalThis.fetch = vi.fn(async (_url, options) => {
      seen = options.headers;
      return blobResponse("audio");
    });
    await collect(synth({ settings: { ...settings, directApiKey: "sk-abc" }, voice: "alloy" }));
    expect(seen.Authorization).toBe("Bearer sk-abc");
  });

  it("retries a failed chunk then succeeds", async () => {
    let attempts = 0;
    globalThis.fetch = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("NetworkError");
      return blobResponse("audio");
    });
    const results = await collect(synth());
    expect(attempts).toBe(2);
    expect(results).toHaveLength(1);
  });

  it("surfaces the OpenAI error message after exhausting retries", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ error: { message: "Invalid voice: bogus" } }, 400),
    );
    await expect(collect(synth({ voice: "bogus" }))).rejects.toThrow(/Invalid voice: bogus/);
  });

  it("aborts without retrying when the signal fires", async () => {
    const controller = new AbortController();
    globalThis.fetch = vi.fn(async () => {
      controller.abort();
      throw new DOMException("Aborted", "AbortError");
    });
    await expect(collect(synth({ signal: controller.signal }))).rejects.toThrow(/Aborted/);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});
