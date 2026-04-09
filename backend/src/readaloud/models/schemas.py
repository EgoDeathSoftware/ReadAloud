from pydantic import BaseModel, Field


class TtsGenerateRequest(BaseModel):
    text: str
    voice: str | None = None
    model: str | None = None
    speed: float = 1.0


class TtsGenerateResponse(BaseModel):
    job_id: str
    status: str
    audio_url: str | None = None


class TtsStatusResponse(BaseModel):
    job_id: str
    status: str
    progress: float = Field(default=0.0, ge=0.0, le=1.0)
    chunks_completed: int = 0
    chunks_total: int = 0
    error: str | None = None


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
    tts_mode: str
    tts_base_url: str
    tts_model: str
    tts_default_voice: str


class SettingsUpdateRequest(BaseModel):
    tts_mode: str | None = None
    tts_base_url: str | None = None
    tts_model: str | None = None
    tts_default_voice: str | None = None
