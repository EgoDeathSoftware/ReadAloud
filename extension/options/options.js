"use strict";

const DEFAULT_SERVER_URL = "http://localhost:8000";

const serverUrlInput = document.getElementById("server-url");
const voiceSelect = document.getElementById("voice-select");
const speedRange = document.getElementById("speed-range");
const speedValue = document.getElementById("speed-value");
const btnSave = document.getElementById("btn-save");
const btnTest = document.getElementById("btn-test");
const messageEl = document.getElementById("message");

function showMessage(text, type) {
  messageEl.textContent = text;
  messageEl.className = type;
  setTimeout(() => {
    messageEl.className = "hidden";
  }, 4000);
}

function getServerUrl() {
  return (serverUrlInput.value || DEFAULT_SERVER_URL).replace(/\/+$/, "");
}

async function loadSettings() {
  const saved = await browser.storage.local.get([
    "serverUrl",
    "defaultVoice",
    "defaultSpeed",
  ]);
  serverUrlInput.value = saved.serverUrl || DEFAULT_SERVER_URL;
  speedRange.value = saved.defaultSpeed || 1.0;
  speedValue.textContent = parseFloat(speedRange.value).toFixed(1);

  await loadVoices(saved.defaultVoice);
}

async function loadVoices(selectedVoice) {
  const url = getServerUrl();
  try {
    const response = await fetch(`${url}/api/voices`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const voices = await response.json();

    voiceSelect.innerHTML = "";
    for (const v of voices) {
      const opt = document.createElement("option");
      opt.value = v.id;
      opt.textContent = v.name || v.id;
      voiceSelect.appendChild(opt);
    }

    if (selectedVoice) {
      voiceSelect.value = selectedVoice;
    }
  } catch (_) {
    voiceSelect.innerHTML = '<option value="">Could not load voices</option>';
  }
}

speedRange.addEventListener("input", () => {
  speedValue.textContent = parseFloat(speedRange.value).toFixed(1);
});

btnSave.addEventListener("click", async () => {
  await browser.storage.local.set({
    serverUrl: getServerUrl(),
    defaultVoice: voiceSelect.value,
    defaultSpeed: parseFloat(speedRange.value),
  });
  showMessage("Settings saved.", "success");
});

btnTest.addEventListener("click", async () => {
  const url = getServerUrl();
  try {
    const response = await fetch(`${url}/api/health`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();

    if (data.status === "healthy") {
      showMessage("Connected to server. TTS server is reachable.", "success");
    } else {
      showMessage(
        `Server reached, but TTS backend is ${data.tts_server}.`,
        "error"
      );
    }

    await loadVoices(voiceSelect.value);
  } catch (err) {
    showMessage(`Cannot reach server: ${err.message}`, "error");
  }
});

serverUrlInput.addEventListener("change", () => {
  loadVoices(voiceSelect.value);
});

loadSettings();
