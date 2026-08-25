export const TARGET_BACKEND = "backend";
export const TARGET_DIRECT = "direct";

export const DEFAULT_SETTINGS = Object.freeze({
  ttsTarget: TARGET_BACKEND,
  backendUrl: "http://localhost:8000",
  directUrl: "http://localhost:8880",
  directApiKey: "",
  directModel: "kokoro",
  defaultVoice: "",
  defaultSpeed: 1.0,
});

const KEYS = Object.keys(DEFAULT_SETTINGS);

function stripTrailingSlashes(url) {
  return String(url).replace(/\/+$/, "");
}

/**
 * Read settings from storage.local, applying defaults and migrating the
 * pre-target `serverUrl` key used by versions <= 1.0.0.
 */
export async function loadSettings() {
  const stored = await browser.storage.local.get([...KEYS, "serverUrl"]);

  if (stored.serverUrl) {
    if (!stored.backendUrl) {
      stored.backendUrl = stored.serverUrl;
      await browser.storage.local.set({ backendUrl: stored.backendUrl });
    }
    await browser.storage.local.remove("serverUrl");
  }

  const settings = { ...DEFAULT_SETTINGS };
  for (const key of KEYS) {
    if (stored[key] !== undefined && stored[key] !== null && stored[key] !== "") {
      settings[key] = stored[key];
    }
  }

  if (settings.ttsTarget !== TARGET_BACKEND && settings.ttsTarget !== TARGET_DIRECT) {
    settings.ttsTarget = DEFAULT_SETTINGS.ttsTarget;
  }
  settings.backendUrl = stripTrailingSlashes(settings.backendUrl);
  settings.directUrl = stripTrailingSlashes(settings.directUrl);
  settings.defaultSpeed = Number(settings.defaultSpeed) || DEFAULT_SETTINGS.defaultSpeed;

  return settings;
}

/** Persist a partial settings update. */
export async function saveSettings(partial) {
  const update = {};
  for (const key of KEYS) {
    if (key in partial) update[key] = partial[key];
  }
  await browser.storage.local.set(update);
}
