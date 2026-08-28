import { pickAdapter } from "/lib/adapters/index.js";
import { createPlayer } from "/lib/player.js";
import { loadSettings } from "/lib/settings.js";
import { isPdfUrl, resolvePdfSourceUrl } from "/lib/pdf.js";

const state = {
  phase: "idle",
  progress: 0,
  chunksCompleted: 0,
  chunksTotal: 0,
  error: null,
};

const player = createPlayer({});
let abortController = null;

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
  resetState();
  broadcastState();
}

async function handleReadRequest(text, voice, speed) {
  stopAll();

  if (!text || text.trim().length === 0) {
    setError("No text to read");
    return;
  }

  const settings = await loadSettings();
  const adapter = pickAdapter(settings);
  abortController = new AbortController();

  player.setSpeed(speed || settings.defaultSpeed);
  setPhase("generating");

  const generator = adapter.synthesize({
    text,
    voice: voice || settings.defaultVoice,
    settings,
    signal: abortController.signal,
    onProgress: ({ chunksCompleted, chunksTotal, progress }) => {
      state.chunksCompleted = chunksCompleted;
      state.chunksTotal = chunksTotal;
      state.progress = progress;
      if (state.phase === "generating" || state.phase === "playing") broadcastState();
    },
  });

  try {
    setPhase("playing");
    await player.play(generator);
    if (state.phase !== "error") {
      resetState();
      broadcastState();
    }
  } catch (err) {
    if (err.name === "AbortError") return;
    setError(err.message);
  } finally {
    abortController = null;
  }
}

async function handleReadPage(tab, voice, speed) {
  stopAll();

  if (isPdfUrl(resolvePdfSourceUrl(tab.url))) {
    await handleReadPdf(tab, voice, speed);
    return;
  }

  setPhase("extracting");

  try {
    // Inject Readability.js first (defines the global), then run the extractor.
    await browser.tabs.executeScript(tab.id, { file: "Readability.js" });
    const results = await browser.tabs.executeScript(tab.id, { file: "content.js" });
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

// fetch() is unreliable for file:// URLs in Firefox extension background pages
// (a long-standing restriction of Firefox's security model, not something to
// work around with fetch options). XMLHttpRequest with responseType "blob" is
// the historically-reliable path for reading file:// content, so branch on
// scheme. file:// responses typically report xhr.status === 0 — treat that as
// success too.
function fetchAsBlob(url, signal) {
  if (url.startsWith("file:")) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      const xhr = new XMLHttpRequest();
      xhr.open("GET", url);
      xhr.responseType = "blob";
      xhr.onload = () => {
        if (xhr.status === 0 || xhr.status === 200) resolve(xhr.response);
        else reject(new Error(`Could not fetch PDF: ${xhr.status}`));
      };
      xhr.onerror = () => reject(new Error("Could not fetch PDF: network error"));
      signal?.addEventListener("abort", () => {
        xhr.abort();
        reject(new DOMException("Aborted", "AbortError"));
      });
      xhr.send();
    });
  }
  return fetch(url, { signal }).then((response) => {
    if (!response.ok) throw new Error(`Could not fetch PDF: ${response.status}`);
    return response.blob();
  });
}

async function handleReadPdf(tab, voice, speed) {
  setPhase("extracting");
  abortController = new AbortController();
  const { signal } = abortController;

  try {
    const sourceUrl = resolvePdfSourceUrl(tab.url);
    const pdfBytes = await fetchAsBlob(sourceUrl, signal);

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
  id: "readaloud-page",
  title: "ReadAloud: Read Page",
  contexts: ["page"],
});

browser.contextMenus.onClicked.addListener(async (info, tab) => {
  const settings = await loadSettings();
  if (info.menuItemId === "readaloud-selection" && info.selectionText) {
    handleReadRequest(info.selectionText, settings.defaultVoice, settings.defaultSpeed);
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
