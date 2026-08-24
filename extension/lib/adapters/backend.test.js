import { beforeEach, describe, expect, it, vi } from "vitest";

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
      speed: 1,
      settings,
      signal: new AbortController().signal,
      onProgress: () => {},
      ...overrides,
    }),
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
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
});
