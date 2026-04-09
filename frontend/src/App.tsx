import { useState } from "react";
import { Layout } from "src/components/Layout.tsx";
import { TextInput } from "src/components/TextInput.tsx";
import { UrlInput } from "src/components/UrlInput.tsx";
import { VoiceSelector } from "src/components/VoiceSelector.tsx";
import { AudioPlayer } from "src/components/AudioPlayer.tsx";
import { SettingsPanel } from "src/components/SettingsPanel.tsx";
import {
  GenerationProgress,
} from "src/components/GenerationProgress.tsx";
import { useTts } from "src/hooks/useTts.ts";
import { useSettingsStore } from "src/stores/settings.ts";
import "src/App.css";

export function App() {
  const [text, setText] = useState("");
  const [voice, setVoice] = useState("af_heart");
  const tts = useTts();
  const settings = useSettingsStore();

  const isGenerating =
    tts.state === "generating" || tts.state === "polling";

  function handleExtracted(
    extractedText: string,
    _title: string | null,
  ) {
    setText(extractedText);
  }

  function handleGenerate() {
    if (!text.trim()) return;
    tts.generate(
      text,
      voice || undefined,
      settings.tts_model || undefined,
      settings.speed,
    );
  }

  return (
    <Layout>
      <UrlInput
        onExtracted={handleExtracted}
        disabled={isGenerating}
      />

      <TextInput
        value={text}
        onChange={setText}
        disabled={isGenerating}
      />

      <div className="controls">
        <VoiceSelector
          value={voice}
          onChange={setVoice}
          disabled={isGenerating}
        />

        <button
          className="btn btn--primary btn--generate"
          onClick={handleGenerate}
          disabled={isGenerating || !text.trim()}
        >
          {isGenerating ? "Generating..." : "Generate"}
        </button>
      </div>

      <GenerationProgress
        progress={tts.progress}
        chunksCompleted={tts.chunksCompleted}
        chunksTotal={tts.chunksTotal}
        visible={isGenerating}
      />

      {tts.error !== null && (
        <div className="error-message">{tts.error}</div>
      )}

      <AudioPlayer audioUrl={tts.audioUrl} />

      <SettingsPanel />
    </Layout>
  );
}
