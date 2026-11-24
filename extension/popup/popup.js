"use strict";

const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const voiceSelect = document.getElementById("voice-select");
const highlightToggle = document.getElementById("highlight-toggle");
const speedRange = document.getElementById("speed-range");
const speedValue = document.getElementById("speed-value");
const btnSelection = document.getElementById("btn-selection");
const btnFromHere = document.getElementById("btn-from-here");
const btnPage = document.getElementById("btn-page");
const btnPause = document.getElementById("btn-pause");
const btnStop = document.getElementById("btn-stop");
const btnRewind = document.getElementById("btn-rewind");
const btnForward = document.getElementById("btn-forward");
const transportSection = document.getElementById("transport-section");
const readingSection = document.getElementById("reading-section");
const readingTitle = document.getElementById("reading-title");
const btnShowTab = document.getElementById("btn-show-tab");
const SKIP_SECONDS = 15;
const progressSection = document.getElementById("progress-section");
const progressFill = document.getElementById("progress-fill");
const progressText = document.getElementById("progress-text");
const errorSection = document.getElementById("error-section");
const errorText = document.getElementById("error-text");
const serverDot = document.getElementById("server-dot");
const serverText = document.getElementById("server-text");
const btnSettings = document.getElementById("btn-settings");

let currentPhase = "idle";

function getVoice() {
  return voiceSelect.value || undefined;
}

function getSpeed() {
  return parseFloat(speedRange.value) || 1.0;
}

function renderState(s) {
  const phaseLabels = {
    idle: "Idle",
    extracting: "Extracting text...",
    generating: "Generating audio...",
    polling: "Processing...",
    playing: "Playing",
    paused: "Paused",
    error: "Error",
  };

  currentPhase = s.phase;
  statusText.textContent = phaseLabels[s.phase] || s.phase;

  statusDot.className = "dot";
  if (s.phase === "idle") statusDot.classList.add("dot-idle");
  else if (s.phase === "playing") statusDot.classList.add("dot-playing");
  else if (s.phase === "paused") statusDot.classList.add("dot-active");
  else if (s.phase === "error") statusDot.classList.add("dot-error");
  else statusDot.classList.add("dot-active");

  const isActive = !["idle", "error"].includes(s.phase);
  btnSelection.disabled = isActive;
  btnFromHere.disabled = isActive;
  btnPage.disabled = isActive;
  readingSection.classList.toggle("hidden", !s.tab);
  readingTitle.textContent = s.tab ? s.tab.title || "Untitled tab" : "";
  readingTitle.title = readingTitle.textContent;
  transportSection.classList.toggle("hidden", s.phase !== "playing" && s.phase !== "paused");
  btnPause.textContent = s.phase === "paused" ? "▶" : "❚❚";
  btnPause.title = s.phase === "paused" ? "Resume" : "Pause";
  btnPause.setAttribute("aria-label", btnPause.title);

  const showProgress =
    s.chunksTotal > 1 &&
    ["polling", "playing", "paused"].includes(s.phase);
  if (showProgress) {
    progressSection.classList.remove("hidden");
    const pct = Math.round(s.progress * 100);
    progressFill.style.width = pct + "%";
    progressText.textContent =
      `Chunk ${s.chunksCompleted}/${s.chunksTotal} (${pct}%)`;
  } else {
    progressSection.classList.add("hidden");
  }

  if (s.phase === "error" && s.error) {
    errorSection.classList.remove("hidden");
    errorText.textContent = s.error;
  } else {
    errorSection.classList.add("hidden");
  }
}

async function loadVoices() {
  try {
    const voices = await browser.runtime.sendMessage({ type: "getVoices" });
    if (voices && !voices.error && Array.isArray(voices)) {
      voiceSelect.innerHTML = "";
      const defaultOpt = document.createElement("option");
      defaultOpt.value = "";
      defaultOpt.textContent = "Default";
      voiceSelect.appendChild(defaultOpt);
      for (const v of voices) {
        const opt = document.createElement("option");
        opt.value = v.id;
        opt.textContent = v.name || v.id;
        voiceSelect.appendChild(opt);
      }
      const saved = await browser.storage.local.get("defaultVoice");
      if (voices.some((v) => v.id === saved.defaultVoice)) {
        voiceSelect.value = saved.defaultVoice;
      }
    }
  } catch (_) {
    // Voices will be empty; user can configure in options
  }
}

async function loadSpeed() {
  const saved = await browser.storage.local.get("defaultSpeed");
  if (saved.defaultSpeed) {
    speedRange.value = saved.defaultSpeed;
    speedValue.textContent = parseFloat(saved.defaultSpeed).toFixed(1);
  }
}

async function loadHighlight() {
  const saved = await browser.storage.local.get(["highlightEnabled", "ttsTarget"]);
  highlightToggle.checked = saved.highlightEnabled !== false;

  const direct = saved.ttsTarget === "direct";
  document.getElementById("highlight-note").classList.toggle("hidden", !direct);
}

async function checkServer() {
  const { ttsTarget } = await browser.storage.local.get("ttsTarget");
  const name = ttsTarget === "direct" ? "OpenAI-compatible endpoint" : "ReadAloud backend";
  let healthy = false;
  try {
    const result = await browser.runtime.sendMessage({ type: "healthCheck" });
    healthy = result?.status === "healthy";
  } catch (_) {
    // Treated as unreachable.
  }
  serverDot.className = healthy ? "dot dot-connected" : "dot dot-disconnected";
  serverText.textContent = `${name}: ${healthy ? "connected" : "unreachable"}`;
}

speedRange.addEventListener("input", () => {
  const speed = parseFloat(speedRange.value);
  speedValue.textContent = speed.toFixed(1);
  browser.runtime.sendMessage({ type: "setSpeed", speed });
});

speedRange.addEventListener("change", () => {
  browser.storage.local.set({ defaultSpeed: parseFloat(speedRange.value) });
});

highlightToggle.addEventListener("change", () => {
  browser.storage.local.set({ highlightEnabled: highlightToggle.checked });
});

voiceSelect.addEventListener("change", () => {
  browser.storage.local.set({ defaultVoice: voiceSelect.value });
});

btnSelection.addEventListener("click", () => {
  browser.runtime.sendMessage({
    type: "readSelection",
    voice: getVoice(),
    speed: getSpeed(),
  });
});

btnFromHere.addEventListener("click", () => {
  browser.runtime.sendMessage({
    type: "readFromHere",
    voice: getVoice(),
    speed: getSpeed(),
  });
});

btnPage.addEventListener("click", () => {
  browser.runtime.sendMessage({
    type: "readPage",
    voice: getVoice(),
    speed: getSpeed(),
  });
});

btnPause.addEventListener("click", () => {
  browser.runtime.sendMessage({ type: currentPhase === "paused" ? "resume" : "pause" });
});

btnShowTab.addEventListener("click", () => {
  browser.runtime.sendMessage({ type: "showReadingTab" });
});

btnStop.addEventListener("click", () => {
  browser.runtime.sendMessage({ type: "stop" });
});

btnRewind.addEventListener("click", () => {
  browser.runtime.sendMessage({ type: "skip", seconds: -SKIP_SECONDS });
});

btnForward.addEventListener("click", () => {
  browser.runtime.sendMessage({ type: "skip", seconds: SKIP_SECONDS });
});

btnSettings.addEventListener("click", () => {
  browser.runtime.openOptionsPage();
});

browser.runtime.onMessage.addListener((message) => {
  if (message.type === "stateUpdate") {
    renderState(message.state);
  }
});

// Playback state first: the voice list and server check go over the network
// and must not hold back the transport controls for a read already playing.
browser.runtime.sendMessage({ type: "getState" }).then(renderState);
loadVoices();
loadSpeed();
loadHighlight();
checkServer();
