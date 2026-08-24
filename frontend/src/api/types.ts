export interface TtsGenerateRequest {
  text: string;
  voice?: string | undefined;
  model?: string | undefined;
  speed?: number | undefined;
}

export interface TtsGenerateResponse {
  job_id: string;
  status: "complete" | "processing" | "failed";
  audio_url: string | null;
}

export interface TtsStatusResponse {
  job_id: string;
  status: "complete" | "processing" | "failed" | "pending";
  progress: number;
  chunks_completed: number;
  chunks_total: number;
  error: string | null;
}

export interface ExtractRequest {
  url: string;
}

export interface ExtractResponse {
  title: string | null;
  text: string;
  word_count: number;
}

export interface VoiceInfo {
  id: string;
  name: string | null;
}

export interface Settings {
  tts_base_url: string;
  tts_model: string;
  tts_default_voice: string;
}
