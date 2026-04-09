import type {
  TtsGenerateRequest,
  TtsGenerateResponse,
  TtsStatusResponse,
  ExtractRequest,
  ExtractResponse,
  VoiceInfo,
  Settings,
} from "src/api/types.ts";

class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "Unknown error");
    throw new ApiError(response.status, text);
  }
  return response.json() as Promise<T>;
}

export function generateTts(
  req: TtsGenerateRequest,
): Promise<TtsGenerateResponse> {
  return request<TtsGenerateResponse>("/api/tts/generate", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export function getTtsStatus(
  jobId: string,
): Promise<TtsStatusResponse> {
  return request<TtsStatusResponse>(`/api/tts/status/${jobId}`);
}

export function getTtsAudioUrl(jobId: string): string {
  return `/api/tts/audio/${jobId}`;
}

export function extractUrl(
  req: ExtractRequest,
): Promise<ExtractResponse> {
  return request<ExtractResponse>("/api/extract", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export function getVoices(): Promise<VoiceInfo[]> {
  return request<VoiceInfo[]>("/api/voices");
}

export function getSettings(): Promise<Settings> {
  return request<Settings>("/api/settings");
}

export function updateSettings(
  settings: Partial<Settings>,
): Promise<Settings> {
  return request<Settings>("/api/settings", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

export function checkHealth(): Promise<{
  status: string;
  tts_server: string;
}> {
  return request("/api/health");
}
