// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadScript } from "/tests/load-script.js";

const POPUP_HTML = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "popup.html"),
  "utf8",
);

const IDLE = { phase: "idle", progress: 0, chunksCompleted: 0, chunksTotal: 0, error: null };

/**
 * Open the popup against a fake background page. `replies` maps a message
 * type to its response; types without one resolve to undefined.
 */
function openPopup(replies = {}) {
  document.documentElement.innerHTML = POPUP_HTML.replace(/<script[^>]*><\/script>/, "");
  globalThis.browser = {
    runtime: {
      sendMessage: vi.fn(async (message) => {
        const reply = replies[message.type];
        return typeof reply === "function" ? reply(message) : reply;
      }),
      onMessage: { addListener: vi.fn() },
      openOptionsPage: vi.fn(),
    },
    storage: { local: { get: async () => ({}), set: async () => {} } },
  };
  loadScript("popup/popup.js");
}

const byId = (id) => document.getElementById(id);
const never = () => new Promise(() => {});

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("popup", () => {
  it("sends resume when the read is paused", async () => {
    openPopup({ getState: { ...IDLE, phase: "paused" } });
    await vi.waitFor(() => expect(byId("status-text").textContent).toBe("Paused"));

    byId("btn-pause").click();

    expect(browser.runtime.sendMessage).toHaveBeenCalledWith({ type: "resume" });
  });

  it("sends pause when the read is playing", async () => {
    openPopup({ getState: { ...IDLE, phase: "playing" } });
    await vi.waitFor(() => expect(byId("status-text").textContent).toBe("Playing"));

    byId("btn-pause").click();

    expect(browser.runtime.sendMessage).toHaveBeenCalledWith({ type: "pause" });
  });

  it("shows playback controls while the server check is still pending", async () => {
    openPopup({ getState: { ...IDLE, phase: "playing" }, getVoices: never, healthCheck: never });

    await vi.waitFor(() => expect(byId("status-text").textContent).toBe("Playing"));
    expect(byId("transport-section").classList.contains("hidden")).toBe(false);
  });
});
