import { pickAdapter } from "/lib/adapters/index.js";
import { backendAdapter } from "/lib/adapters/backend.js";
import { chunkCache } from "/lib/chunk-cache.js";
import { chunkText } from "/lib/chunker.js";
import { createPlayer } from "/lib/player.js";
import { sha256Hex } from "/lib/hash.js";
import { loadSettings } from "/lib/settings.js";
import { isPdfTab, resolvePdfSourceUrl } from "/lib/pdf.js";
import { findActiveCueIndex } from "/lib/cues.js";

const state = {
  phase: "idle",
  progress: 0,
  chunksCompleted: 0,
  chunksTotal: 0,
  error: null,
};

const player = createPlayer({});
let abortController = null;

const HIGHLIGHT_INTERVAL_MS = 100;

/**
 * Word-highlight state for the current read. `cueChunks[i]` holds chunk i's
 * chunk-relative cues and `chunkOffsets[i]` how many words precede it, so a
 * (chunk, time) position resolves to one index into the tab's word list.
 * `enabled` goes false the moment the cues stop lining up with the indexed
 * words -- audio keeps playing, the highlight just stops.
 */
const highlight = {
  tabId: null,
  enabled: false,
  wordOffset: 0,
  wordCount: 0,
  cueChunks: [],
  chunkOffsets: [],
  activeIndex: null,
  timer: null,
};
let activePlayer = player;

function startHighlighting({ tabId, wordOffset, wordCount }) {
  highlight.tabId = tabId;
  highlight.enabled = true;
  highlight.wordOffset = wordOffset;
  highlight.wordCount = wordCount;
  highlight.cueChunks = [];
  highlight.chunkOffsets = [];
  highlight.activeIndex = null;
  highlight.timer = setInterval(highlightTick, HIGHLIGHT_INTERVAL_MS);
}

function stopHighlighting() {
  if (highlight.timer !== null) clearInterval(highlight.timer);
  highlight.timer = null;
  if (highlight.tabId !== null) {
    browser.tabs.sendMessage(highlight.tabId, { type: "readaloudClear" }).catch(() => {});
  }
  highlight.tabId = null;
  highlight.enabled = false;
  highlight.activeIndex = null;
}

/**
 * Record a chunk's cues as it is yielded, and check they still line up.
 * `total` is the adapter's chunk count for the whole read; on the last chunk
 * the cumulative cue count must exactly match `wordCount` -- an undercount
 * would otherwise desync every highlight position for the rest of the read.
 */
function recordChunkCues({ index, total, cues }) {
  highlight.cueChunks[index] = cues || [];
  highlight.chunkOffsets[index] =
    index === 0
      ? 0
      : (highlight.chunkOffsets[index - 1] || 0) + (highlight.cueChunks[index - 1]?.length || 0);

  const cumulative = highlight.chunkOffsets[index] + highlight.cueChunks[index].length;
  if (highlight.cueChunks[index].length === 0 || cumulative > highlight.wordCount) {
    highlight.enabled = false;
    return;
  }
  if (index === total - 1 && cumulative !== highlight.wordCount) {
    highlight.enabled = false;
  }
}

function highlightTick() {
  if (!highlight.enabled || highlight.tabId === null) return;
  const chunk = activePlayer.currentChunkIndex;
  const cues = highlight.cueChunks[chunk];
  if (!cues) return;

  const local = findActiveCueIndex(cues, activePlayer.currentTime);
  if (local === null) return;

  const index = highlight.wordOffset + highlight.chunkOffsets[chunk] + local;
  if (index === highlight.activeIndex) return;
  highlight.activeIndex = index;
  browser.tabs
    .sendMessage(highlight.tabId, { type: "readaloudHighlight", index })
    .catch(() => {});
}

/** Pass chunks through to the player while recording their cues. */
async function* captureCues(generator) {
  for await (const item of generator) {
    recordChunkCues(item);
    yield item;
  }
}

export const __testing = {
  startHighlighting,
  stopHighlighting,
  recordChunkCues,
  highlightTick,
  captureCues,
  buildPageIndex,
  setPosition(currentChunkIndex, currentTime) {
    activePlayer = { currentChunkIndex, currentTime };
  },
};

function resetState() {
  state.phase = "idle";
  state.progress = 0;
  state.chunksCompleted = 0;
  state.chunksTotal = 0;
  state.error = null;
}

function broadcastState() {
  browser.runtime.sendMessage({ type: "stateUpdate", state: { ...state } }).catch(() => {});
}

function setPhase(phase) {
  state.phase = phase;
  broadcastState();
}

function setError(message) {
  state.phase = "error";
  state.error = message;
  broadcastState();
}

function stopAll() {
  abortController?.abort();
  abortController = null;
  player.stop();
  stopHighlighting();
  resetState();
  broadcastState();
}

function blobToBase64(blob) {
  return blob.arrayBuffer().then((buffer) => {
    let binary = "";
    for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
    return btoa(binary);
  });
}

/**
 * Chunk `text` the same way the backend will, and offer back the audio for any
 * chunk already cached this session -- lets the server skip resynthesizing it.
 * Best-effort: any failure (unreachable backend, aborted read) just means no
 * chunks are offered, falling back to full synthesis.
 */
async function buildKnownChunks(text, voice, settings, signal) {
  try {
    const response = await fetch(`${settings.backendUrl}/api/settings`, { signal });
    if (!response.ok) return [];
    const { max_chunk_chars: maxChunkChars } = await response.json();

    const knownChunks = [];
    for (const chunk of chunkText(text, maxChunkChars)) {
      const hash = await sha256Hex(chunk);
      const entry = chunkCache.get(voice, hash);
      if (entry) knownChunks.push({ hash, audioB64: await blobToBase64(entry.blob) });
    }
    return knownChunks;
  } catch {
    return [];
  }
}

async function handleReadRequest(text, voice, speed, highlightTarget = null) {
  stopAll();

  if (!text || text.trim().length === 0) {
    setError("No text to read");
    return;
  }

  const settings = await loadSettings();
  const adapter = pickAdapter(settings);
  const resolvedVoice = voice || settings.defaultVoice;
  abortController = new AbortController();

  player.setSpeed(speed || settings.defaultSpeed);
  setPhase("generating");

  const knownChunks =
    adapter === backendAdapter
      ? await buildKnownChunks(text, resolvedVoice, settings, abortController.signal)
      : [];

  const generator = adapter.synthesize({
    text,
    voice: resolvedVoice,
    settings,
    signal: abortController.signal,
    knownChunks,
    onProgress: ({ chunksCompleted, chunksTotal, progress }) => {
      state.chunksCompleted = chunksCompleted;
      state.chunksTotal = chunksTotal;
      state.progress = progress;
      if (state.phase === "generating" || state.phase === "playing") broadcastState();
    },
  });

  try {
    setPhase("playing");
    if (highlightTarget) startHighlighting(highlightTarget);
    await player.play(highlightTarget ? captureCues(generator) : generator);
    if (state.phase !== "error") {
      resetState();
      broadcastState();
    }
  } catch (err) {
    if (err.name === "AbortError") return;
    setError(err.message);
  } finally {
    abortController = null;
    stopHighlighting();
  }
}

// Inject Readability.js first (defines the global), then the reader, then ask
// it to index the page. The word index stays in the tab -- only plain data
// crosses back.
async function buildPageIndex(tab, { fromSelection = false } = {}) {
  await browser.tabs.executeScript(tab.id, { file: "Readability.js" });
  await browser.tabs.executeScript(tab.id, { file: "content-reader.js" });
  const results = await browser.tabs.executeScript(tab.id, {
    code: `window.__readaloud.buildIndex({ fromSelection: ${fromSelection} })`,
  });
  const article = results && results[0];
  if (!article || !article.text || article.text.trim().length === 0) return null;
  return article;
}

async function handleReadPage(tab, voice, speed) {
  stopAll();

  if (await isPdfTab(tab.url)) {
    await handleReadPdf(tab, voice, speed);
    return;
  }

  setPhase("extracting");

  try {
    const article = await buildPageIndex(tab);
    if (!article) {
      setError("No article content could be extracted from this page");
      return;
    }

    await handleReadRequest(article.text, voice, speed, {
      tabId: tab.id,
      wordOffset: article.startWordIndex,
      wordCount: article.wordCount,
    });
  } catch (err) {
    setError(`Extraction failed: ${err.message}`);
  }
}

async function handleReadFromHere(tab, voice, speed) {
  stopAll();
  setPhase("extracting");

  try {
    const article = await buildPageIndex(tab, { fromSelection: true });
    if (!article) {
      setError("No article content could be extracted from this page");
      return;
    }

    await handleReadRequest(article.text, voice, speed, {
      tabId: tab.id,
      wordOffset: article.startWordIndex,
      wordCount: article.wordCount,
    });
  } catch (err) {
    setError(`Extraction failed: ${err.message}`);
  }
}

function fetchAsBlob(url, signal) {
  return fetch(url, { signal }).then((response) => {
    if (!response.ok) throw new Error(`Could not fetch PDF: ${response.status}`);
    return response.blob();
  });
}

// The background page cannot fetch() or XHR a file:// URL directly — Firefox
// blocks that at the network layer regardless of the "Allow access to file
// URLs" extension setting. That setting instead controls whether extension
// code may run *inside* a file:// tab, so read the bytes from within the tab
// itself (same-origin fetch of its own location) via executeScript.
function fetchFileTabBytes(tabId) {
  return browser.tabs
    .executeScript(tabId, {
      code: "fetch(location.href).then((r) => r.arrayBuffer())",
    })
    .then((results) => {
      const arrayBuffer = results && results[0];
      if (!arrayBuffer) throw new Error("Could not read local file");
      return new Blob([arrayBuffer], { type: "application/pdf" });
    });
}

async function handleReadPdf(tab, voice, speed) {
  setPhase("extracting");
  abortController = new AbortController();
  const { signal } = abortController;

  try {
    const sourceUrl = resolvePdfSourceUrl(tab.url);
    const pdfBytes = sourceUrl.startsWith("file:")
      ? await fetchFileTabBytes(tab.id)
      : await fetchAsBlob(sourceUrl, signal);

    const settings = await loadSettings();
    const form = new FormData();
    form.append("file", pdfBytes, "document.pdf");

    const extractResponse = await fetch(`${settings.backendUrl}/api/extract/pdf`, {
      method: "POST",
      body: form,
      signal,
    });
    if (!extractResponse.ok) {
      const body = await extractResponse.text().catch(() => "");
      throw new Error(`${extractResponse.status}: ${body}`);
    }
    const { text } = await extractResponse.json();

    await handleReadRequest(text, voice, speed);
  } catch (err) {
    if (err.name === "AbortError") return;
    setError(`Could not read PDF: ${err.message}`);
  } finally {
    abortController = null;
  }
}

browser.contextMenus.create({
  id: "readaloud-selection",
  title: "ReadAloud: Read Selection",
  contexts: ["selection"],
});

browser.contextMenus.create({
  id: "readaloud-from-here",
  title: "ReadAloud: Read From Here",
  contexts: ["selection"],
});

browser.contextMenus.create({
  id: "readaloud-page",
  title: "ReadAloud: Read Page",
  contexts: ["page"],
});

browser.contextMenus.onClicked.addListener(async (info, tab) => {
  const settings = await loadSettings();
  if (info.menuItemId === "readaloud-selection" && info.selectionText) {
    handleReadRequest(info.selectionText, settings.defaultVoice, settings.defaultSpeed);
  } else if (info.menuItemId === "readaloud-from-here" && info.selectionText && tab.id) {
    handleReadFromHere(tab, settings.defaultVoice, settings.defaultSpeed);
  } else if (info.menuItemId === "readaloud-page" && tab.id) {
    handleReadPage(tab, settings.defaultVoice, settings.defaultSpeed);
  }
});

browser.runtime.onMessage.addListener((message) => {
  switch (message.type) {
    case "getState":
      return Promise.resolve({ ...state });

    case "readSelection":
      return browser.tabs
        .query({ active: true, currentWindow: true })
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
        .catch((err) => setError(`Could not read selection: ${err.message}`));

    case "readPage":
      return browser.tabs
        .query({ active: true, currentWindow: true })
        .then((tabs) => {
          if (!tabs[0]) throw new Error("No active tab");
          handleReadPage(tabs[0], message.voice, message.speed);
        })
        .catch((err) => setError(`Could not read page: ${err.message}`));

    case "setSpeed":
      player.setSpeed(message.speed);
      return Promise.resolve();

    case "pause":
      player.pause();
      if (player.phase === "paused") setPhase("paused");
      return Promise.resolve();

    case "resume":
      player.resume();
      if (player.phase === "playing") setPhase("playing");
      return Promise.resolve();

    case "stop":
      stopAll();
      return Promise.resolve();

    case "skip":
      player.skip(message.seconds);
      return Promise.resolve();

    case "getVoices":
      return loadSettings()
        .then((settings) => pickAdapter(settings).listVoices(settings))
        .catch((err) => ({ error: err.message }));

    case "healthCheck":
      return loadSettings()
        .then((settings) => pickAdapter(settings).checkHealth(settings))
        .then((result) => ({
          status: result.ok ? "healthy" : "unhealthy",
          detail: result.detail,
        }))
        .catch((err) => ({ status: "unreachable", error: err.message }));

    default:
      return Promise.resolve();
  }
});
