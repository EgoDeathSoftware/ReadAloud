import { useState } from "react";
import { useSettingsStore } from "src/stores/settings.ts";
import { updateSettings as apiUpdateSettings } from "src/api/client.ts";

export function SettingsPanel() {
  const [open, setOpen] = useState(false);
  const settings = useSettingsStore();

  function handleChange(
    partial: Partial<{
      tts_mode: "local" | "remote";
      tts_base_url: string;
      tts_model: string;
      tts_default_voice: string;
    }>,
  ) {
    settings.updateSettings(partial);
    apiUpdateSettings(partial).catch(() => {
      // Settings sync failure is non-critical
    });
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
            <label>Mode</label>
            <div className="settings-panel__radio-group">
              <label>
                <input
                  type="radio"
                  name="tts_mode"
                  value="local"
                  checked={settings.tts_mode === "local"}
                  onChange={() =>
                    handleChange({ tts_mode: "local" })
                  }
                />
                Local
              </label>
              <label>
                <input
                  type="radio"
                  name="tts_mode"
                  value="remote"
                  checked={settings.tts_mode === "remote"}
                  onChange={() =>
                    handleChange({ tts_mode: "remote" })
                  }
                />
                Remote
              </label>
            </div>
          </div>
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
