import { beforeEach, describe, expect, it } from "vitest";

import { createChunkCache } from "./chunk-cache.js";

function blob(bytes) {
  return new Blob([new Uint8Array(bytes)], { type: "audio/mpeg" });
}

describe("createChunkCache", () => {
  it("returns null for a miss", () => {
    const cache = createChunkCache();
    expect(cache.get("af_heart", "hash-1")).toBeNull();
  });

  it("returns what was set for the same voice and hash", () => {
    const cache = createChunkCache();
    const b = blob(10);
    cache.set("af_heart", "hash-1", b);
    expect(cache.get("af_heart", "hash-1").blob).toBe(b);
  });

  it("keeps entries separate per voice for the same hash", () => {
    const cache = createChunkCache();
    const a = blob(10);
    const b = blob(10);
    cache.set("af_heart", "hash-1", a);
    cache.set("am_adam", "hash-1", b);
    expect(cache.get("af_heart", "hash-1").blob).toBe(a);
    expect(cache.get("am_adam", "hash-1").blob).toBe(b);
  });

  it("returns the cues stored with the audio", () => {
    const cache = createChunkCache();
    const b = new Blob(["audio"]);
    const cues = [{ text: "hi", start: 0, end: 1 }];

    cache.set("af_heart", "hash1", b, cues);

    expect(cache.get("af_heart", "hash1")).toEqual({ blob: b, cues });
  });

  it("stores an empty cue list when none is given", () => {
    const cache = createChunkCache();
    cache.set("af_heart", "hash1", new Blob(["audio"]));

    expect(cache.get("af_heart", "hash1").cues).toEqual([]);
  });

  it("evicts the oldest entry once the byte budget is exceeded", () => {
    const cache = createChunkCache({ maxBytes: 15 });
    cache.set("af_heart", "hash-1", blob(10));
    cache.set("af_heart", "hash-2", blob(10));
    expect(cache.get("af_heart", "hash-1")).toBeNull();
    expect(cache.get("af_heart", "hash-2")).not.toBeNull();
  });

  it("refreshes an entry's recency on get, protecting it from eviction", () => {
    const cache = createChunkCache({ maxBytes: 25 });
    cache.set("af_heart", "hash-1", blob(10));
    cache.set("af_heart", "hash-2", blob(10));
    cache.get("af_heart", "hash-1");
    cache.set("af_heart", "hash-3", blob(10));
    expect(cache.get("af_heart", "hash-1")).not.toBeNull();
    expect(cache.get("af_heart", "hash-2")).toBeNull();
    expect(cache.get("af_heart", "hash-3")).not.toBeNull();
  });

  it("clear() empties the cache", () => {
    const cache = createChunkCache();
    cache.set("af_heart", "hash-1", blob(10));
    cache.clear();
    expect(cache.get("af_heart", "hash-1")).toBeNull();
    expect(cache.size).toBe(0);
  });
});
