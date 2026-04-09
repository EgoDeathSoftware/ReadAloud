import { useState } from "react";
import { useVoices } from "src/hooks/useVoices.ts";

interface VoiceSelectorProps {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}

export function VoiceSelector({
  value,
  onChange,
  disabled,
}: VoiceSelectorProps) {
  const { voices, loading } = useVoices();
  const [customMode, setCustomMode] = useState(false);

  if (customMode) {
    return (
      <div className="voice-selector">
        <label className="voice-selector__label">Voice</label>
        <div className="voice-selector__row">
          <input
            type="text"
            className="voice-selector__input"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            placeholder="Enter voice name"
          />
          <button
            className="btn btn--small"
            onClick={() => setCustomMode(false)}
            disabled={disabled}
          >
            List
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="voice-selector">
      <label className="voice-selector__label">Voice</label>
      <div className="voice-selector__row">
        <select
          className="voice-selector__select"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled || loading}
        >
          {voices.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name ?? v.id}
            </option>
          ))}
        </select>
        <button
          className="btn btn--small"
          onClick={() => setCustomMode(true)}
          disabled={disabled}
        >
          Custom
        </button>
      </div>
    </div>
  );
}
