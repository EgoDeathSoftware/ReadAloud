import asyncio

import httpx

from readaloud.config import auth_headers, settings

MAX_ATTEMPTS = 3
RETRYABLE_STATUS_CODES = {429, 500, 502, 503, 504}


def _error_message(response: httpx.Response) -> str:
    try:
        detail = response.json().get("error", {}).get("message")
    except ValueError:
        detail = None
    if detail:
        return f"TTS server error {response.status_code}: {detail}"
    return f"TTS server error {response.status_code}"


def _retry_delay(response: httpx.Response, attempt: int) -> float:
    retry_after = response.headers.get("Retry-After")
    if retry_after is not None:
        try:
            return float(retry_after)
        except ValueError:
            pass
    return 2**attempt


class TtsClient:
    """Async client for OpenAI-compatible TTS servers."""

    def __init__(self) -> None:
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(120.0))

    async def _post_with_retry(self, url: str, payload: dict) -> httpx.Response:
        """POST with retry/backoff on retryable failures.

        Raises:
            RuntimeError: A non-retryable HTTP error, or every attempt was
                exhausted.
        """
        last_error: Exception | str | None = None
        for attempt in range(MAX_ATTEMPTS):
            try:
                response = await self._client.post(url, json=payload, headers=auth_headers())
                response.raise_for_status()
                return response
            except httpx.HTTPStatusError as exc:
                status = exc.response.status_code
                last_error = _error_message(exc.response)
                if status not in RETRYABLE_STATUS_CODES:
                    raise RuntimeError(last_error) from exc
                if attempt < MAX_ATTEMPTS - 1:
                    await asyncio.sleep(_retry_delay(exc.response, attempt))
            except (httpx.HTTPError, httpx.StreamError) as exc:
                last_error = exc
                if attempt < MAX_ATTEMPTS - 1:
                    await asyncio.sleep(2**attempt)

        raise RuntimeError(f"TTS generation failed after {MAX_ATTEMPTS} attempts: {last_error}")

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
        response = await self._post_with_retry(url, payload)
        if not response.content:
            raise RuntimeError(
                f"TTS server returned empty audio (status {response.status_code})"
            )
        return response.content

    async def close(self) -> None:
        await self._client.aclose()
