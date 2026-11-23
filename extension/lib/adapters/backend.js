import { chunkCache } from "/lib/chunk-cache.js";

const POLL_INTERVAL_MS = 1000;
/** Cap on voice-list and health probes so the popup never waits on a stalled server. */
const PROBE_TIMEOUT_MS = 5000;

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

async function backendJson(settings, path, options = {}) {
  const response = await fetch(`${settings.backendUrl}${path}`, options);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${response.status}: ${body}`);
  }
  return response.json();
}

async function fetchAudio(settings, path, signal) {
  const response = await fetch(`${settings.backendUrl}${path}`, { signal });
  if (!response.ok) {
    throw new Error(`Failed to fetch audio: ${response.status}`);
  }
  return response.blob();
}

export const backendAdapter = {
  id: "backend",
  /** The backend chunks server-side, so the extension sends the full text. */
  maxInputChars: Infinity,

  async listVoices(settings) {
    const voices = await backendJson(settings, "/api/voices", {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return voices.map((v) => ({ id: v.id, name: v.name || v.id }));
  },

  async checkHealth(settings) {
    try {
      const data = await backendJson(settings, "/api/health", {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      return data.status === "healthy"
        ? { ok: true, detail: "Backend and TTS server reachable" }
        : { ok: false, detail: `Backend up, TTS server ${data.tts_server}` };
    } catch (err) {
      return { ok: false, detail: `Backend unreachable: ${err.message}` };
    }
  },

  async testVoice(voice, settings, signal) {
    const body = { text: "Hello, this is a test of your voice." };
    if (voice) body.voice = voice;

    const job = await backendJson(settings, "/api/tts/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });

    return fetchAudio(settings, `/api/tts/audio/${job.job_id}`, signal);
  },

  async *synthesize({ text, voice, settings, signal, onProgress, knownChunks = [] }) {
    const body = { text: text.trim() };
    if (voice) body.voice = voice;
    if (knownChunks.length > 0) {
      body.known_chunks = knownChunks.map(({ hash, audioB64 }) => ({
        hash,
        audio_b64: audioB64,
      }));
    }

    const job = await backendJson(settings, "/api/tts/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });

    if (job.status === "complete") {
      onProgress({ chunksCompleted: 1, chunksTotal: 1, progress: 1 });
      yield {
        audio: await fetchAudio(settings, `/api/tts/audio/${job.job_id}`, signal),
        index: 0,
        total: 1,
        cues: job.cues || [],
      };
      return;
    }

    let nextChunk = 0;
    for (;;) {
      const status = await backendJson(settings, `/api/tts/status/${job.job_id}`, { signal });
      onProgress({
        chunksCompleted: status.chunks_completed,
        chunksTotal: status.chunks_total,
        progress: status.progress,
      });

      if (status.status === "failed") {
        throw new Error(status.error || "TTS generation failed");
      }

      while (nextChunk < status.chunks_completed) {
        const info = status.chunks?.find((c) => c.index === nextChunk);
        const cached = info ? chunkCache.get(voice, info.hash) : null;
        let audio;
        let cues = info?.cues || [];
        if (info?.source === "client_cache" && cached) {
          audio = cached.blob;
          // The server never synthesized this chunk, so its cues came from the
          // heuristic. The cached ones may be the server's real timings.
          if (cached.cues.length) cues = cached.cues;
        } else {
          audio = await fetchAudio(settings, `/api/tts/audio/${job.job_id}/${nextChunk}`, signal);
          if (info) chunkCache.set(voice, info.hash, audio, cues);
        }
        yield { audio, index: nextChunk, total: status.chunks_total, cues };
        nextChunk += 1;
      }

      if (status.status === "complete" && nextChunk >= status.chunks_total) return;
      await sleep(POLL_INTERVAL_MS, signal);
    }
  },
};
