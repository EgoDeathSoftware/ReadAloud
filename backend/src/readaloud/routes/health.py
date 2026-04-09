import httpx
from fastapi import APIRouter

from readaloud.config import settings

router = APIRouter()


@router.get("/health")
async def health_check() -> dict:
    """Check API and TTS server health."""
    tts_status = "unreachable"
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.get(
                f"{settings.TTS_BASE_URL}/v1/models"
            )
            if response.status_code < 500:
                tts_status = "connected"
    except httpx.HTTPError:
        pass

    status = "healthy" if tts_status == "connected" else "unhealthy"
    return {"status": status, "tts_server": tts_status}
