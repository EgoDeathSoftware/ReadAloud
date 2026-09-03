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
    expect(cache.get("af_heart", "hash-1")).toBe(b);
  });

  it("keeps entries separate per voice for the same hash", () => {
    const cache = createChunkCache();
    const a = blob(10);
    const b = blob(10);
    cache.set("af_heart", "hash-1", a);
    cache.set("am_adam", "hash-1", b);
    expect(cache.get("af_heart", "hash-1")).toBe(a);
    expect(cache.get("am_adam", "hash-1")).toBe(b);
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
