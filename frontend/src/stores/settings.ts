import { create } from "zustand";
import { persist } from "zustand/middleware";

interface SettingsState {
  tts_base_url: string;
  tts_model: string;
  tts_default_voice: string;
  updateSettings: (partial: Partial<Omit<SettingsState, "updateSettings">>) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      tts_base_url: "http://localhost:8880",
      tts_model: "kokoro",
      tts_default_voice: "af_heart",
      updateSettings: (partial) => set(partial),
    }),
    { name: "readaloud-settings" },
  ),
);
