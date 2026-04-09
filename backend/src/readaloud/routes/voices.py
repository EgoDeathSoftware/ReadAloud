import httpx
from fastapi import APIRouter

from readaloud.config import settings
from readaloud.models.schemas import VoiceInfo

router = APIRouter()

FALLBACK_VOICES = [
    VoiceInfo(id="alloy", name="Alloy"),
    VoiceInfo(id="echo", name="Echo"),
    VoiceInfo(id="fable", name="Fable"),
    VoiceInfo(id="onyx", name="Onyx"),
    VoiceInfo(id="nova", name="Nova"),
    VoiceInfo(id="shimmer", name="Shimmer"),
]


@router.get("/voices")
async def list_voices() -> list[VoiceInfo]:
    """List available TTS voices from the server."""
    async with httpx.AsyncClient(timeout=5.0) as client:
        try:
            resp = await client.get(
                f"{settings.TTS_BASE_URL}/v1/audio/voices"
            )
            if resp.status_code == 200:
                data = resp.json()
                voices = data if isinstance(data, list) else data.get("voices", [])
                return [
                    VoiceInfo(
                        id=v["id"] if isinstance(v, dict) else v,
                        name=v.get("name") if isinstance(v, dict) else None,
                    )
                    for v in voices
                ]
        except httpx.HTTPError:
            pass

        try:
            resp = await client.get(
                f"{settings.TTS_BASE_URL}/v1/models"
            )
            if resp.status_code == 200:
                data = resp.json()
                models = data.get("data", []) if isinstance(data, dict) else []
                if models:
                    return [
                        VoiceInfo(id=m.get("id", ""), name=m.get("id"))
                        for m in models
                        if isinstance(m, dict)
                    ]
        except httpx.HTTPError:
            pass

    return FALLBACK_VOICES
