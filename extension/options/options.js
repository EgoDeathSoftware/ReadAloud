import { pickAdapter } from "/lib/adapters/index.js";
import { TARGET_BACKEND, TARGET_DIRECT, loadSettings, saveSettings } from "/lib/settings.js";

const backendUrlInput = document.getElementById("backend-url");
const directUrlInput = document.getElementById("direct-url");
const directModelInput = document.getElementById("direct-model");
const directApiKeyInput = document.getElementById("direct-api-key");
const backendFields = document.getElementById("backend-fields");
const directFields = document.getElementById("direct-fields");
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

function selectedTarget() {
  const checked = document.querySelector('input[name="tts-target"]:checked');
  return checked?.value === TARGET_DIRECT ? TARGET_DIRECT : TARGET_BACKEND;
}

function formSettings() {
  return {
    ttsTarget: selectedTarget(),
    backendUrl: backendUrlInput.value.replace(/\/+$/, ""),
    directUrl: directUrlInput.value.replace(/\/+$/, ""),
    directModel: directModelInput.value,
    directApiKey: directApiKeyInput.value,
    defaultVoice: voiceSelect.value,
    defaultSpeed: parseFloat(speedRange.value),
  };
}

function syncFieldVisibility() {
  const direct = selectedTarget() === TARGET_DIRECT;
  directFields.classList.toggle("hidden", !direct);
  // Backend URL stays visible even on "direct" — PDF extraction always goes
  // through the ReadAloud backend regardless of the TTS target.
  backendFields.classList.toggle("hidden", false);
}

async function refreshVoices(selectedVoice) {
  const settings = formSettings();
  voiceSelect.innerHTML = '<option value="">Loading voices...</option>';
  try {
    const voices = await pickAdapter(settings).listVoices(settings);
    voiceSelect.innerHTML = "";
    for (const voice of voices) {
      const option = document.createElement("option");
      option.value = voice.id;
      option.textContent = voice.name || voice.id;
      voiceSelect.appendChild(option);
    }
    if (selectedVoice) voiceSelect.value = selectedVoice;
  } catch (err) {
    voiceSelect.innerHTML = `<option value="">Could not load voices: ${err.message}</option>`;
  }
}

async function init() {
  const settings = await loadSettings();
  document.querySelector(`input[name="tts-target"][value="${settings.ttsTarget}"]`).checked = true;
  backendUrlInput.value = settings.backendUrl;
  directUrlInput.value = settings.directUrl;
  directModelInput.value = settings.directModel;
  directApiKeyInput.value = settings.directApiKey;
  speedRange.value = settings.defaultSpeed;
  speedValue.textContent = settings.defaultSpeed.toFixed(1);
  syncFieldVisibility();
  await refreshVoices(settings.defaultVoice);
}

for (const radio of document.querySelectorAll('input[name="tts-target"]')) {
  radio.addEventListener("change", () => {
    syncFieldVisibility();
    refreshVoices(voiceSelect.value);
  });
}

for (const input of [backendUrlInput, directUrlInput, directApiKeyInput, directModelInput]) {
  input.addEventListener("change", () => refreshVoices(voiceSelect.value));
}

speedRange.addEventListener("input", () => {
  speedValue.textContent = parseFloat(speedRange.value).toFixed(1);
});

btnSave.addEventListener("click", async () => {
  await saveSettings(formSettings());
  showMessage("Settings saved.", "success");
});

btnTest.addEventListener("click", async () => {
  const settings = formSettings();
  const result = await pickAdapter(settings).checkHealth(settings);
  showMessage(result.detail, result.ok ? "success" : "error");
  await refreshVoices(voiceSelect.value);
});

init();
