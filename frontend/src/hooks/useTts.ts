import { useState, useCallback, useRef } from "react";
import {
  generateTts,
  getTtsStatus,
  getTtsAudioUrl,
} from "src/api/client.ts";

type TtsState =
  | "idle"
  | "generating"
  | "polling"
  | "complete"
  | "error";

interface UseTtsResult {
  state: TtsState;
  progress: number;
  chunksCompleted: number;
  chunksTotal: number;
  audioUrl: string | null;
  error: string | null;
  generate: (
    text: string,
    voice?: string,
    model?: string,
    speed?: number,
  ) => void;
  reset: () => void;
}

async function fetchAudioBlobUrl(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch audio: ${response.status}`);
  }
  const blob = await response.blob();
  return URL.createObjectURL(blob);
}

export function useTts(): UseTtsResult {
  const [state, setState] = useState<TtsState>("idle");
  const [progress, setProgress] = useState(0);
  const [chunksCompleted, setChunksCompleted] = useState(0);
  const [chunksTotal, setChunksTotal] = useState(0);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const blobUrlRef = useRef<string | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const revokeBlobUrl = useCallback(() => {
    if (blobUrlRef.current !== null) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
  }, []);

  const setAudioBlobUrl = useCallback(
    (apiUrl: string, onDone: () => void) => {
      fetchAudioBlobUrl(apiUrl)
        .then((blobUrl) => {
          revokeBlobUrl();
          blobUrlRef.current = blobUrl;
          setAudioUrl(blobUrl);
          onDone();
        })
        .catch((err: unknown) => {
          const message =
            err instanceof Error ? err.message : "Audio fetch failed";
          setError(message);
          setState("error");
        });
    },
    [revokeBlobUrl],
  );

  const reset = useCallback(() => {
    clearTimer();
    revokeBlobUrl();
    setState("idle");
    setProgress(0);
    setChunksCompleted(0);
    setChunksTotal(0);
    setAudioUrl(null);
    setError(null);
  }, [clearTimer, revokeBlobUrl]);

  const startPolling = useCallback(
    (jobId: string) => {
      setState("polling");
      timerRef.current = setInterval(() => {
        getTtsStatus(jobId)
          .then((status) => {
            setProgress(status.progress);
            setChunksCompleted(status.chunks_completed);
            setChunksTotal(status.chunks_total);

            if (status.status === "complete") {
              clearTimer();
              setAudioBlobUrl(getTtsAudioUrl(jobId), () =>
                setState("complete"),
              );
            } else if (status.status === "failed") {
              clearTimer();
              setError(status.error ?? "Generation failed");
              setState("error");
            }
          })
          .catch((err: unknown) => {
            clearTimer();
            const message =
              err instanceof Error ? err.message : "Polling failed";
            setError(message);
            setState("error");
          });
      }, 2000);
    },
    [clearTimer, setAudioBlobUrl],
  );

  const generate = useCallback(
    (
      text: string,
      voice?: string,
      model?: string,
      speed?: number,
    ) => {
      clearTimer();
      setState("generating");
      setProgress(0);
      setError(null);
      setAudioUrl(null);

      generateTts({ text, voice, model, speed })
        .then((resp) => {
          if (resp.status === "complete") {
            setAudioBlobUrl(getTtsAudioUrl(resp.job_id), () =>
              setState("complete"),
            );
          } else if (resp.status === "processing") {
            startPolling(resp.job_id);
          } else {
            setError("Generation failed");
            setState("error");
          }
        })
        .catch((err: unknown) => {
          const message =
            err instanceof Error
              ? err.message
              : "Generation request failed";
          setError(message);
          setState("error");
        });
    },
    [clearTimer, startPolling, setAudioBlobUrl],
  );

  return {
    state,
    progress,
    chunksCompleted,
    chunksTotal,
    audioUrl,
    error,
    generate,
    reset,
  };
}
