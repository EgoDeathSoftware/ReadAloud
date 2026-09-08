from fastapi import APIRouter

from readaloud.config import settings
from readaloud.models.schemas import SettingsResponse

router = APIRouter()


@router.get("/settings")
async def get_settings() -> SettingsResponse:
    """Return the server's TTS configuration.

    Read-only by design: these values come from environment variables. Never
    includes the API key.
    """
    return SettingsResponse(
        tts_base_url=settings.TTS_BASE_URL,
        tts_model=settings.TTS_MODEL,
        tts_default_voice=settings.TTS_DEFAULT_VOICE,
        max_chunk_chars=settings.MAX_CHUNK_CHARS,
    )
