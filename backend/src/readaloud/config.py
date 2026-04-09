from typing import Literal

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    model_config = {"env_prefix": "READALOUD_"}

    TTS_MODE: Literal["local", "remote"] = "local"
    TTS_BASE_URL: str = "http://localhost:8880"
    TTS_MODEL: str = "kokoro"
    TTS_DEFAULT_VOICE: str = "af_heart"
    MAX_CHUNK_CHARS: int = 4000


settings = Settings()
