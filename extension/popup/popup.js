"use strict";

const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const voiceSelect = document.getElementById("voice-select");
const speedRange = document.getElementById("speed-range");
const speedValue = document.getElementById("speed-value");
const btnSelection = document.getElementById("btn-selection");
const btnPage = document.getElementById("btn-page");
const btnPause = document.getElementById("btn-pause");
const btnStop = document.getElementById("btn-stop");
const progressSection = document.getElementById("progress-section");
const progressFill = document.getElementById("progress-fill");
const progressText = document.getElementById("progress-text");
const errorSection = document.getElementById("error-section");
const errorText = document.getElementById("error-text");
const serverDot = document.getElementById("server-dot");
const serverText = document.getElementById("server-text");

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

  statusText.textContent = phaseLabels[s.phase] || s.phase;

  statusDot.className = "dot";
  if (s.phase === "idle") statusDot.classList.add("dot-idle");
  else if (s.phase === "playing") statusDot.classList.add("dot-playing");
  else if (s.phase === "paused") statusDot.classList.add("dot-active");
  else if (s.phase === "error") statusDot.classList.add("dot-error");
  else statusDot.classList.add("dot-active");

  const isActive = !["idle", "error"].includes(s.phase);
  btnSelection.disabled = isActive;
  btnPage.disabled = isActive;
  btnPause.classList.toggle("hidden", s.phase !== "playing" && s.phase !== "paused");
  btnPause.textContent = s.phase === "paused" ? "Resume" : "Pause";
  btnStop.classList.toggle("hidden", !isActive);

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
      for (const v of voices) {
        const opt = document.createElement("option");
        opt.value = v.id;
        opt.textContent = v.name || v.id;
        voiceSelect.appendChild(opt);
      }
      const saved = await browser.storage.local.get("defaultVoice");
      if (saved.defaultVoice) {
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

async function checkServer() {
  try {
    const result = await browser.runtime.sendMessage({ type: "healthCheck" });
    if (result && result.status === "healthy") {
      serverDot.className = "dot dot-connected";
      serverText.textContent = "Server connected";
    } else {
      serverDot.className = "dot dot-disconnected";
      serverText.textContent = "Server unreachable";
    }
  } catch (_) {
    serverDot.className = "dot dot-disconnected";
    serverText.textContent = "Server unreachable";
  }
}

speedRange.addEventListener("input", () => {
  const val = parseFloat(speedRange.value).toFixed(1);
  speedValue.textContent = val;
});

speedRange.addEventListener("change", () => {
  browser.storage.local.set({ defaultSpeed: parseFloat(speedRange.value) });
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

btnPage.addEventListener("click", () => {
  browser.runtime.sendMessage({
    type: "readPage",
    voice: getVoice(),
    speed: getSpeed(),
  });
});

btnPause.addEventListener("click", () => {
  const isPaused = btnPause.textContent === "Resume";
  browser.runtime.sendMessage({ type: isPaused ? "resume" : "pause" });
});

btnStop.addEventListener("click", () => {
  browser.runtime.sendMessage({ type: "stop" });
});

browser.runtime.onMessage.addListener((message) => {
  if (message.type === "stateUpdate") {
    renderState(message.state);
  }
});

// Initialize
(async () => {
  await Promise.all([loadVoices(), loadSpeed(), checkServer()]);
  const currentState = await browser.runtime.sendMessage({ type: "getState" });
  renderState(currentState);
})();
