import { TARGET_DIRECT } from "/lib/settings.js";
import { backendAdapter } from "/lib/adapters/backend.js";
import { openaiAdapter } from "/lib/adapters/openai.js";

/** Choose the TTS adapter for the configured target. */
export function pickAdapter(settings) {
  return settings.ttsTarget === TARGET_DIRECT ? openaiAdapter : backendAdapter;
}

export { backendAdapter, openaiAdapter };
