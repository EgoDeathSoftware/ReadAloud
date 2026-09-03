import { pickAdapter } from "/lib/adapters/index.js";
import { createPlayer } from "/lib/player.js";
import { loadSettings } from "/lib/settings.js";
import { isPdfTab, resolvePdfSourceUrl } from "/lib/pdf.js";
import { sliceFromArticle } from "/lib/read-from-here.js";

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

// Inject Readability.js first (defines the global), then run the extractor.
// Returns the extracted article text, or null if nothing could be extracted.
async function extractArticleText(tab) {
  await browser.tabs.executeScript(tab.id, { file: "Readability.js" });
  const results = await browser.tabs.executeScript(tab.id, { file: "content.js" });
  const article = results && results[0];
  if (!article || !article.text || article.text.trim().length === 0) return null;
  return article.text;
}

async function handleReadPage(tab, voice, speed) {
  stopAll();

  if (await isPdfTab(tab.url)) {
    await handleReadPdf(tab, voice, speed);
    return;
  }

  setPhase("extracting");

  try {
    const text = await extractArticleText(tab);
    if (!text) {
      setError("No article content could be extracted from this page");
      return;
    }

    await handleReadRequest(text, voice, speed);
  } catch (err) {
    setError(`Extraction failed: ${err.message}`);
  }
}

async function handleReadFromHere(tab, selectionText, voice, speed) {
  stopAll();
  setPhase("extracting");

  try {
    const articleText = await extractArticleText(tab);
    if (!articleText) {
      setError("No article content could be extracted from this page");
      return;
    }

    const fromHere = sliceFromArticle(articleText, selectionText);
    if (!fromHere) {
      setError("Could not find that selection in the page text");
      return;
    }

    await handleReadRequest(fromHere, voice, speed);
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
    handleReadFromHere(tab, info.selectionText, settings.defaultVoice, settings.defaultSpeed);
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
