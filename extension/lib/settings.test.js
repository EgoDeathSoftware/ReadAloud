import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "./settings.js";

function mockStorage(initial = {}) {
  let store = { ...initial };
  globalThis.browser = {
    storage: {
      local: {
        get: vi.fn(async (keys) => {
          if (keys === null || keys === undefined) return { ...store };
          const wanted = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(wanted.filter((k) => k in store).map((k) => [k, store[k]]));
        }),
        set: vi.fn(async (values) => {
          store = { ...store, ...values };
        }),
        remove: vi.fn(async (keys) => {
          for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
        }),
      },
    },
  };
  return () => store;
}

describe("loadSettings", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns defaults on a fresh install", async () => {
    mockStorage({});
    await expect(loadSettings()).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it("defaults the direct target to the Kokoro container port", () => {
    expect(DEFAULT_SETTINGS.directUrl).toBe("http://localhost:8880");
    expect(DEFAULT_SETTINGS.ttsTarget).toBe("backend");
  });

  it("migrates the legacy serverUrl key to backendUrl", async () => {
    const read = mockStorage({ serverUrl: "http://192.168.1.5:8000" });
    const settings = await loadSettings();
    expect(settings.backendUrl).toBe("http://192.168.1.5:8000");
    expect(settings.ttsTarget).toBe("backend");
    expect(read().serverUrl).toBeUndefined();
    expect(read().backendUrl).toBe("http://192.168.1.5:8000");
  });

  it("does not clobber an existing backendUrl during migration", async () => {
    mockStorage({ serverUrl: "http://old.test", backendUrl: "http://new.test" });
    const settings = await loadSettings();
    expect(settings.backendUrl).toBe("http://new.test");
  });

  it("strips trailing slashes from both URLs", async () => {
    mockStorage({ backendUrl: "http://a.test:8000//", directUrl: "http://b.test:8880/" });
    const settings = await loadSettings();
    expect(settings.backendUrl).toBe("http://a.test:8000");
    expect(settings.directUrl).toBe("http://b.test:8880");
  });

  it("falls back to defaults for an unrecognised target", async () => {
    mockStorage({ ttsTarget: "carrier-pigeon" });
    await expect(loadSettings()).resolves.toMatchObject({ ttsTarget: "backend" });
  });
});

describe("saveSettings", () => {
  it("writes only the provided keys", async () => {
    const read = mockStorage({ defaultSpeed: 1.5 });
    await saveSettings({ ttsTarget: "direct" });
    expect(read().ttsTarget).toBe("direct");
    expect(read().defaultSpeed).toBe(1.5);
  });

  it("persists an emptied API key", async () => {
    const read = mockStorage({ directApiKey: "sk-old" });
    await saveSettings({ directApiKey: "" });
    expect(read().directApiKey).toBe("");
  });
});
