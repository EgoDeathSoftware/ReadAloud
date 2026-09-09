from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    model_config = {"env_prefix": "READALOUD_"}

    TTS_BASE_URL: str = "http://localhost:8880"
    TTS_MODEL: str = "kokoro"
    TTS_DEFAULT_VOICE: str = "af_heart"
    TTS_API_KEY: str = ""
    MAX_CHUNK_CHARS: int = 4000
    # Comma-separated browser origins allowed to call the API. Empty means
    # DEFAULT_ALLOWED_ORIGINS. Declared as a string rather than list[str] because
    # pydantic-settings would otherwise expect JSON in the environment variable.
    ALLOWED_ORIGINS: str = ""
    # Backend server port
    PORT: int = 8055


settings = Settings()

DEFAULT_ALLOWED_ORIGINS = [
    # Vite dev server
    "http://localhost:8056",
    "http://127.0.0.1:8056",
    # Backend serving frontend/dist in production
    "http://localhost:8055",
    "http://127.0.0.1:8055",
]

# The WebExtension calls the API from its own origin. MV2 host permissions already
# let it bypass CORS, so allowing the scheme grants nothing an installed extension
# does not already have.
EXTENSION_ORIGIN_REGEX = r"^(moz|chrome)-extension://[A-Za-z0-9._-]+$"


def allowed_origins() -> list[str]:
    """Browser origins permitted to call the API.

    Never returns "*": a wildcard lets any page the user visits drive TTS
    generation and read back extracted page content.
    """
    configured = [origin.strip() for origin in settings.ALLOWED_ORIGINS.split(",")]
    configured = [origin for origin in configured if origin]
    return configured or list(DEFAULT_ALLOWED_ORIGINS)


def auth_headers() -> dict[str, str]:
    """Build the Authorization header for the configured TTS server.

    Returns:
        A dict with a Bearer token when TTS_API_KEY is set, otherwise empty.
        Self-hosted servers such as Kokoro require no key.
    """
    if not settings.TTS_API_KEY:
        return {}
    return {"Authorization": f"Bearer {settings.TTS_API_KEY}"}
