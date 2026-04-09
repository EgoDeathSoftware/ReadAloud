import { useState, useEffect, useCallback } from "react";
import type { VoiceInfo } from "src/api/types.ts";
import { getVoices } from "src/api/client.ts";

interface UseVoicesResult {
  voices: VoiceInfo[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useVoices(): UseVoicesResult {
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchVoices = useCallback(() => {
    setLoading(true);
    setError(null);
    getVoices()
      .then((data) => {
        setVoices(data);
        setLoading(false);
      })
      .catch((err: unknown) => {
        const message =
          err instanceof Error ? err.message : "Failed to fetch voices";
        setError(message);
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    fetchVoices();
  }, [fetchVoices]);

  return { voices, loading, error, refetch: fetchVoices };
}
