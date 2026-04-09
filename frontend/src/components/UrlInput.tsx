import { useState } from "react";
import { extractUrl } from "src/api/client.ts";

interface UrlInputProps {
  onExtracted: (text: string, title: string | null) => void;
  disabled: boolean;
}

export function UrlInput({ onExtracted, disabled }: UrlInputProps) {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [info, setInfo] = useState<{
    title: string | null;
    wordCount: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handleExtract() {
    if (!url.trim()) return;
    setLoading(true);
    setError(null);
    setInfo(null);

    extractUrl({ url: url.trim() })
      .then((resp) => {
        setInfo({ title: resp.title, wordCount: resp.word_count });
        onExtracted(resp.text, resp.title);
        setLoading(false);
      })
      .catch((err: unknown) => {
        const message =
          err instanceof Error
            ? err.message
            : "Failed to extract URL";
        setError(message);
        setLoading(false);
      });
  }

  return (
    <div className="url-input">
      <div className="url-input__row">
        <input
          type="url"
          className="url-input__field"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={disabled || loading}
          placeholder="https://example.com/article"
        />
        <button
          className="btn btn--secondary"
          onClick={handleExtract}
          disabled={disabled || loading || !url.trim()}
        >
          {loading ? "Extracting..." : "Extract"}
        </button>
      </div>
      {info !== null && (
        <div className="url-input__info">
          {info.title !== null && <strong>{info.title}</strong>}
          <span>{info.wordCount} words</span>
        </div>
      )}
      {error !== null && (
        <div className="url-input__error">{error}</div>
      )}
    </div>
  );
}
