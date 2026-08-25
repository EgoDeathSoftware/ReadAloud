import { chunkText } from "/lib/chunker.js";

/**
 * OpenAI's hard `input` cap is 4096 characters. 4000 leaves headroom and
 * matches the backend's READALOUD_MAX_CHUNK_CHARS default. Self-hosted
 * servers such as Kokoro have no cap, but chunking still lets playback
 * start before the whole article is synthesised.
 */
const MAX_INPUT_CHARS = 4000;
const MAX_ATTEMPTS = 3;

/**
 * OpenAI publishes no endpoint for enumerating voices, so this is the
 * documented built-in set from docs/openai-tts-spec.md. Used when the server
 * does not implement Kokoro's non-standard GET /v1/audio/voices.
 */
const FALLBACK_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "onyx",
  "nova",
  "sage",
  "shimmer",
  "verse",
  "marin",
  "cedar",
].map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1) }));

function headers(settings, extra = {}) {
  const result = { ...extra };
  if (settings.directApiKey) {
    result.Authorization = `Bearer ${settings.directApiKey}`;
  }
  return result;
}

function toVoice(entry) {
  if (typeof entry === "string") return { id: entry, name: entry };
  const id = entry?.id ?? "";
  return { id, name: entry?.name || id };
}

async function describeError(response) {
  let detail = `HTTP ${response.status}`;
  try {
    const body = await response.json();
    if (body?.error?.message) detail = body.error.message;
    else if (body?.detail) detail = String(body.detail);
  } catch {
    // Body was not JSON; the status code is the best we have.
  }
  return detail;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

export const openaiAdapter = {
  id: "openai",
  maxInputChars: MAX_INPUT_CHARS,

  /**
   * List voices via Kokoro's GET /v1/audio/voices, falling back to the
   * documented OpenAI voice set. /v1/models is deliberately not consulted:
   * on real OpenAI it returns model names, not voices.
   */
  async listVoices(settings) {
    try {
      const response = await fetch(`${settings.directUrl}/v1/audio/voices`, {
        headers: headers(settings),
      });
      if (response.ok) {
        const data = await response.json();
        const raw = Array.isArray(data) ? data : data?.voices || [];
        const voices = raw.map(toVoice).filter((v) => v.id);
        if (voices.length) return voices;
      }
    } catch {
      // Server does not implement the endpoint, or is unreachable.
    }
    return FALLBACK_VOICES;
  },

  async checkHealth(settings) {
    for (const path of ["/health", "/v1/models"]) {
      try {
        const response = await fetch(`${settings.directUrl}${path}`, {
          headers: headers(settings),
        });
        if (response.status < 500) {
          return { ok: true, detail: `Reachable (${path})` };
        }
      } catch {
        // Try the next probe.
      }
    }
    return { ok: false, detail: "TTS server unreachable" };
  },

  async *synthesize({ text, voice, settings, signal, onProgress }) {
    const chunks = chunkText(text, MAX_INPUT_CHARS);
    const total = chunks.length;
    onProgress({ chunksCompleted: 0, chunksTotal: total, progress: 0 });

    for (let index = 0; index < total; index++) {
      const audio = await requestChunk(chunks[index], voice, settings, signal);
      onProgress({
        chunksCompleted: index + 1,
        chunksTotal: total,
        progress: (index + 1) / total,
      });
      yield { audio, index, total };
    }
  },
};

async function requestChunk(input, voice, settings, signal) {
  const url = `${settings.directUrl}/v1/audio/speech`;
  const body = JSON.stringify({
    model: settings.directModel || "kokoro",
    input,
    voice,
    response_format: "mp3",
  });

  let lastError = "unknown error";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: headers(settings, { "Content-Type": "application/json" }),
        body,
        signal,
      });
      if (response.ok) return await response.blob();
      lastError = await describeError(response);
    } catch (err) {
      if (err.name === "AbortError") throw err;
      lastError = err.message;
    }
    if (attempt < MAX_ATTEMPTS - 1) {
      await sleep(2 ** attempt * 1000, signal);
    }
  }
  throw new Error(`TTS request failed after ${MAX_ATTEMPTS} attempts: ${lastError}`);
}
