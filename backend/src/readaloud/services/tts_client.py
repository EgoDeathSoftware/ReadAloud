import asyncio

import httpx

from readaloud.config import auth_headers, settings


class TtsClient:
    """Async client for OpenAI-compatible TTS servers."""

    def __init__(self) -> None:
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(120.0))

    async def generate_speech(
        self,
        text: str,
        voice: str | None = None,
        model: str | None = None,
        speed: float = 1.0,
    ) -> bytes:
        """Generate speech audio from text via the TTS server.

        Args:
            text: The text to synthesize.
            voice: Voice ID to use. Defaults to configured voice.
            model: Model ID to use. Defaults to configured model.
            speed: Playback speed multiplier.

        Returns:
            Raw MP3 audio bytes.
        """
        url = f"{settings.TTS_BASE_URL}/v1/audio/speech"
        payload = {
            "model": model or settings.TTS_MODEL,
            "input": text,
            "voice": voice or settings.TTS_DEFAULT_VOICE,
            "speed": speed,
            "response_format": "mp3",
        }

        last_error: Exception | None = None
        for attempt in range(3):
            try:
                response = await self._client.post(url, json=payload, headers=auth_headers())
                response.raise_for_status()
                return response.content
            except (httpx.HTTPError, httpx.StreamError) as exc:
                last_error = exc
                if attempt < 2:
                    await asyncio.sleep(2**attempt)

        raise RuntimeError(f"TTS generation failed after 3 attempts: {last_error}")

    async def close(self) -> None:
        await self._client.aclose()
