const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Session-scoped LRU cache of synthesized chunk audio, keyed by (voice, chunk
 * hash). Lives only as long as the background page does -- no persistence.
 */
export function createChunkCache({ maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const store = new Map();
  let totalBytes = 0;

  function key(voice, hash) {
    return `${voice} ${hash}`;
  }

  function evict(bytesNeeded) {
    while (totalBytes + bytesNeeded > maxBytes && store.size > 0) {
      const oldestKey = store.keys().next().value;
      totalBytes -= store.get(oldestKey).bytes;
      store.delete(oldestKey);
    }
  }

  return {
    get(voice, hash) {
      const k = key(voice, hash);
      const entry = store.get(k);
      if (!entry) return null;
      store.delete(k);
      store.set(k, entry);
      return entry.blob;
    },

    set(voice, hash, blob) {
      const k = key(voice, hash);
      const existing = store.get(k);
      if (existing) {
        totalBytes -= existing.bytes;
        store.delete(k);
      }
      evict(blob.size);
      store.set(k, { blob, bytes: blob.size });
      totalBytes += blob.size;
    },

    clear() {
      store.clear();
      totalBytes = 0;
    },

    get size() {
      return store.size;
    },
  };
}

/** Shared cache instance used by the adapters and background.js. */
export const chunkCache = createChunkCache();
