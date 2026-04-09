"use strict";

const DEFAULT_SERVER_URL = "http://localhost:8000";
const POLL_INTERVAL_MS = 2000;

const state = {
  phase: "idle",
  jobId: null,
  progress: 0,
  chunksCompleted: 0,
  chunksTotal: 0,
  error: null,
};

let audio = new Audio();
let pollTimer = null;

// Chunk streaming state
let chunkQueue = [];
let chunksFetched = 0;
let currentChunkIndex = 0;
let allChunksGenerated = false;

function resetState() {
  state.phase = "idle";
  state.jobId = null;
  state.progress = 0;
  state.chunksCompleted = 0;
  state.chunksTotal = 0;
  state.error = null;
  chunkQueue = [];
  chunksFetched = 0;
  currentChunkIndex = 0;
  allChunksGenerated = false;
}

function setError(message) {
  stopPolling();
  state.phase = "error";
  state.error = message;
  broadcastState();
}

function broadcastState() {
  browser.runtime.sendMessage({ type: "stateUpdate", state: { ...state } })
    .catch(() => {});
}

async function getServerUrl() {
  const result = await browser.storage.local.get("serverUrl");
  return result.serverUrl || DEFAULT_SERVER_URL;
}

async function getSettings() {
  const result = await browser.storage.local.get([
    "serverUrl",
    "defaultVoice",
    "defaultSpeed",
  ]);
  return {
    serverUrl: result.serverUrl || DEFAULT_SERVER_URL,
    voice: result.defaultVoice || "",
    speed: result.defaultSpeed || 1.0,
  };
}

async function apiFetch(path, options = {}) {
  const serverUrl = await getServerUrl();
  const url = serverUrl.replace(/\/+$/, "") + path;
  const response = await fetch(url, options);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${response.status}: ${body}`);
  }
  return response;
}

async function apiJson(path, options = {}) {
  const response = await apiFetch(path, options);
  return response.json();
}

async function fetchVoices() {
  const voices = await apiJson("/api/voices");
  return voices;
}

async function healthCheck() {
  const data = await apiJson("/api/health");
  return data;
}

function stopPolling() {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function revokeCurrentBlob() {
  if (audio.src && audio.src.startsWith("blob:")) {
    URL.revokeObjectURL(audio.src);
  }
}

function stopPlayback() {
  audio.pause();
  audio.currentTime = 0;
  audio.onended = null;
  audio.onerror = null;
  revokeCurrentBlob();
  audio.src = "";
  for (const blobUrl of chunkQueue) {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
  }
}

function stopAll() {
  stopPolling();
  stopPlayback();
  resetState();
  broadcastState();
}

async function fetchChunkBlob(jobId, chunkIndex) {
  const serverUrl = await getServerUrl();
  const url =
    serverUrl.replace(/\/+$/, "") +
    `/api/tts/audio/${jobId}/${chunkIndex}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch chunk ${chunkIndex}: ${response.status}`);
  }
  const blob = await response.blob();
  return URL.createObjectURL(blob);
}

function playNextChunk() {
  if (state.phase !== "playing" && state.phase !== "paused") return;

  if (currentChunkIndex >= chunkQueue.length) {
    if (allChunksGenerated && currentChunkIndex >= state.chunksTotal) {
      resetState();
      broadcastState();
    }
    return;
  }

  const blobUrl = chunkQueue[currentChunkIndex];
  if (!blobUrl) return;

  revokeCurrentBlob();
  audio.src = blobUrl;

  audio.onended = () => {
    URL.revokeObjectURL(blobUrl);
    chunkQueue[currentChunkIndex] = null;
    currentChunkIndex++;
    if (currentChunkIndex >= state.chunksTotal && allChunksGenerated) {
      resetState();
      broadcastState();
    } else {
      playNextChunk();
    }
  };

  audio.onerror = () => {
    URL.revokeObjectURL(blobUrl);
    setError(`Playback failed on chunk ${currentChunkIndex + 1}`);
  };

  if (state.phase === "playing") {
    audio.play();
  }
}

async function fetchNewChunks(jobId, chunksCompleted) {
  while (chunksFetched < chunksCompleted) {
    const idx = chunksFetched;
    try {
      const blobUrl = await fetchChunkBlob(jobId, idx);
      chunkQueue[idx] = blobUrl;
      chunksFetched++;

      if (
        idx === currentChunkIndex &&
        (state.phase === "playing" || state.phase === "polling")
      ) {
        if (state.phase === "polling") {
          state.phase = "playing";
          broadcastState();
        }
        playNextChunk();
      }
    } catch (err) {
      setError(`Failed to fetch chunk ${idx}: ${err.message}`);
      return;
    }
  }
}

function startPolling(jobId) {
  pollTimer = setInterval(async () => {
    try {
      const status = await apiJson(`/api/tts/status/${jobId}`);
      state.progress = status.progress;
      state.chunksCompleted = status.chunks_completed;
      state.chunksTotal = status.chunks_total;

      if (status.status === "failed") {
        stopPolling();
        setError(status.error || "TTS generation failed");
        return;
      }

      if (status.status === "complete") {
        stopPolling();
        allChunksGenerated = true;
      }

      broadcastState();
      await fetchNewChunks(jobId, status.chunks_completed);
    } catch (err) {
      stopPolling();
      setError(`Polling failed: ${err.message}`);
    }
  }, POLL_INTERVAL_MS);
}

async function playFullAudio(jobId) {
  const serverUrl = await getServerUrl();
  const url = serverUrl.replace(/\/+$/, "") + `/api/tts/audio/${jobId}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch audio: ${response.status}`);
  }
  const blob = await response.blob();
  const blobUrl = URL.createObjectURL(blob);

  stopPlayback();
  audio.src = blobUrl;

  audio.onended = () => {
    URL.revokeObjectURL(blobUrl);
    resetState();
    broadcastState();
  };

  audio.onerror = () => {
    URL.revokeObjectURL(blobUrl);
    setError("Audio playback failed");
  };

  state.phase = "playing";
  broadcastState();
  await audio.play();
}

async function handleReadRequest(text, voice, speed) {
  stopAll();

  if (!text || text.trim().length === 0) {
    setError("No text to read");
    return;
  }

  state.phase = "generating";
  broadcastState();

  try {
    const body = { text: text.trim() };
    if (voice) body.voice = voice;
    if (speed) body.speed = speed;

    const result = await apiJson("/api/tts/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    state.jobId = result.job_id;

    if (result.status === "complete") {
      await playFullAudio(result.job_id);
    } else {
      state.phase = "polling";
      state.chunksTotal = 0;
      broadcastState();
      startPolling(result.job_id);
    }
  } catch (err) {
    setError(`Generation failed: ${err.message}`);
  }
}

async function handleReadPage(tabId, voice, speed) {
  stopAll();
  state.phase = "extracting";
  broadcastState();

  try {
    // Inject Readability.js first (defines the global), then run the extractor.
    await browser.tabs.executeScript(tabId, { file: "Readability.js" });
    const results = await browser.tabs.executeScript(tabId, { file: "content.js" });
    const article = results && results[0];

    if (!article || !article.text || article.text.trim().length === 0) {
      setError("No article content could be extracted from this page");
      return;
    }

    await handleReadRequest(article.text, voice, speed);
  } catch (err) {
    setError(`Extraction failed: ${err.message}`);
  }
}

// Context menus
browser.contextMenus.create({
  id: "readaloud-selection",
  title: "ReadAloud: Read Selection",
  contexts: ["selection"],
});

browser.contextMenus.create({
  id: "readaloud-page",
  title: "ReadAloud: Read Page",
  contexts: ["page"],
});

browser.contextMenus.onClicked.addListener(async (info, tab) => {
  const settings = await getSettings();
  if (info.menuItemId === "readaloud-selection" && info.selectionText) {
    handleReadRequest(info.selectionText, settings.voice, settings.speed);
  } else if (info.menuItemId === "readaloud-page" && tab.id) {
    handleReadPage(tab.id, settings.voice, settings.speed);
  }
});

// Message handler for popup
browser.runtime.onMessage.addListener((message, _sender) => {
  switch (message.type) {
    case "getState":
      return Promise.resolve({ ...state });

    case "readSelection":
      return browser.tabs.query({ active: true, currentWindow: true })
        .then((tabs) => {
          if (!tabs[0]) throw new Error("No active tab");
          return browser.tabs.executeScript(tabs[0].id, {
            code: "window.getSelection().toString();",
          });
        })
        .then((results) => {
          const text = results && results[0];
          if (!text || text.trim().length === 0) {
            setError("No text selected on this page");
            return;
          }
          handleReadRequest(text, message.voice, message.speed);
        })
        .catch((err) => {
          setError(`Could not read selection: ${err.message}`);
        });

    case "readPage":
      return browser.tabs.query({ active: true, currentWindow: true })
        .then((tabs) => {
          if (!tabs[0]) throw new Error("No active tab");
          handleReadPage(tabs[0].id, message.voice, message.speed);
        })
        .catch((err) => {
          setError(`Could not read page: ${err.message}`);
        });

    case "pause":
      if (state.phase === "playing") {
        audio.pause();
        state.phase = "paused";
        broadcastState();
      }
      return Promise.resolve();

    case "resume":
      if (state.phase === "paused") {
        state.phase = "playing";
        broadcastState();
        audio.play();
      }
      return Promise.resolve();

    case "stop":
      stopAll();
      return Promise.resolve();

    case "getVoices":
      return fetchVoices().catch((err) => {
        return { error: err.message };
      });

    case "healthCheck":
      return healthCheck().catch((err) => {
        return { status: "unreachable", error: err.message };
      });

    default:
      return Promise.resolve();
  }
});
