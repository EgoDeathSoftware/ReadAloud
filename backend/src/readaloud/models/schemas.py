from typing import Literal

from pydantic import BaseModel, Field


class KnownChunk(BaseModel):
    hash: str
    audio_b64: str


class TtsGenerateRequest(BaseModel):
    text: str
    voice: str | None = None
    model: str | None = None
    speed: float = 1.0
    known_chunks: list[KnownChunk] = Field(default_factory=list)


class TtsGenerateResponse(BaseModel):
    job_id: str
    status: str
    audio_url: str | None = None


class ChunkStatus(BaseModel):
    index: int
    hash: str
    source: Literal["synthesized", "client_cache"]


class TtsStatusResponse(BaseModel):
    job_id: str
    status: str
    progress: float = Field(default=0.0, ge=0.0, le=1.0)
    chunks_completed: int = 0
    chunks_total: int = 0
    error: str | None = None
    chunks: list[ChunkStatus] = Field(default_factory=list)


class ExtractRequest(BaseModel):
    url: str


class ExtractResponse(BaseModel):
    title: str | None = None
    text: str
    word_count: int


class VoiceInfo(BaseModel):
    id: str
    name: str | None = None


class SettingsResponse(BaseModel):
    tts_base_url: str
    tts_model: str
    tts_default_voice: str
    max_chunk_chars: int
