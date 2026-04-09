from fastapi import APIRouter

from readaloud.config import settings
from readaloud.models.schemas import SettingsResponse, SettingsUpdateRequest

router = APIRouter()


@router.get("/settings")
async def get_settings() -> SettingsResponse:
    """Return current application settings."""
    return SettingsResponse(
        tts_mode=settings.TTS_MODE,
        tts_base_url=settings.TTS_BASE_URL,
        tts_model=settings.TTS_MODEL,
        tts_default_voice=settings.TTS_DEFAULT_VOICE,
    )


@router.put("/settings")
async def update_settings(request: SettingsUpdateRequest) -> SettingsResponse:
    """Update application settings in memory (does not persist across restarts)."""
    if request.tts_mode is not None:
        settings.TTS_MODE = request.tts_mode
    if request.tts_base_url is not None:
        settings.TTS_BASE_URL = request.tts_base_url
    if request.tts_model is not None:
        settings.TTS_MODEL = request.tts_model
    if request.tts_default_voice is not None:
        settings.TTS_DEFAULT_VOICE = request.tts_default_voice

    return SettingsResponse(
        tts_mode=settings.TTS_MODE,
        tts_base_url=settings.TTS_BASE_URL,
        tts_model=settings.TTS_MODEL,
        tts_default_voice=settings.TTS_DEFAULT_VOICE,
    )
