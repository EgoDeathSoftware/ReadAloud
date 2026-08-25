from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    model_config = {"env_prefix": "READALOUD_"}

    TTS_BASE_URL: str = "http://localhost:8880"
    TTS_MODEL: str = "kokoro"
    TTS_DEFAULT_VOICE: str = "af_heart"
    TTS_API_KEY: str = ""
    MAX_CHUNK_CHARS: int = 4000


settings = Settings()


def auth_headers() -> dict[str, str]:
    """Build the Authorization header for the configured TTS server.

    Returns:
        A dict with a Bearer token when TTS_API_KEY is set, otherwise empty.
        Self-hosted servers such as Kokoro require no key.
    """
    if not settings.TTS_API_KEY:
        return {}
    return {"Authorization": f"Bearer {settings.TTS_API_KEY}"}
