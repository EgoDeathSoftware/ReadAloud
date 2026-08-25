import { useState } from "react";
import { useSettingsStore } from "src/stores/settings.ts";

export function SettingsPanel() {
  const [open, setOpen] = useState(false);
  const settings = useSettingsStore();

  function handleChange(
    partial: Partial<{
      tts_base_url: string;
      tts_model: string;
      tts_default_voice: string;
    }>,
  ) {
    settings.updateSettings(partial);
  }

  return (
    <div className="settings-panel">
      <button
        className="btn btn--secondary"
        onClick={() => setOpen(!open)}
      >
        {open ? "Hide Settings" : "Settings"}
      </button>
      {open && (
        <div className="settings-panel__body">
          <div className="settings-panel__field">
            <label>TTS Server URL</label>
            <input
              type="text"
              value={settings.tts_base_url}
              onChange={(e) =>
                handleChange({ tts_base_url: e.target.value })
              }
            />
          </div>
          <div className="settings-panel__field">
            <label>Model</label>
            <input
              type="text"
              value={settings.tts_model}
              onChange={(e) =>
                handleChange({ tts_model: e.target.value })
              }
            />
          </div>
        </div>
      )}
    </div>
  );
}
