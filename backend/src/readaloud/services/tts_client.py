import asyncio
import base64

import httpx

from readaloud.config import auth_headers, settings
from readaloud.services.reading_cues import WordTimestamp

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
        self._captions_supported: bool | None = None

    async def _post_with_retry(
        self,
        url: str,
        payload: dict,
        bypass_status_codes: frozenset[int] = frozenset(),
    ) -> httpx.Response:
        """POST with retry/backoff on retryable failures.

        A response whose status is in `bypass_status_codes` is returned
        as-is without raising -- for callers that need to inspect it (e.g.
        a 404 meaning "this endpoint isn't implemented," not a failure).

        Raises:
            RuntimeError: A non-retryable, non-bypassed HTTP error, or
                every attempt was exhausted.
        """
        last_error: Exception | str | None = None
        for attempt in range(MAX_ATTEMPTS):
            try:
                response = await self._client.post(url, json=payload, headers=auth_headers())
                if response.status_code in bypass_status_codes:
                    return response
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

    async def generate_speech_with_timestamps(
        self,
        text: str,
        voice: str | None = None,
        model: str | None = None,
        speed: float = 1.0,
    ) -> tuple[bytes, list[WordTimestamp] | None]:
        """Generate speech with real per-word timestamps, when supported.

        Tries Kokoro-FastAPI's `/dev/captioned_speech` endpoint. A 404 means
        the configured server doesn't implement it -- cached on this
        instance (one `TtsClient` per job) so later calls this job skip
        straight to `generate_speech` instead of repeating a request that
        will only fail again. Any other error propagates like
        `generate_speech`'s does.

        Returns:
            The audio bytes, and either the server's real per-word
            timestamps or None if the server doesn't support them.
        """
        if self._captions_supported is False:
            audio = await self.generate_speech(text, voice, model, speed)
            return audio, None

        url = f"{settings.TTS_BASE_URL}/dev/captioned_speech"
        payload = {
            "model": model or settings.TTS_MODEL,
            "input": text,
            "voice": voice or settings.TTS_DEFAULT_VOICE,
            "speed": speed,
            "response_format": "mp3",
            "stream": False,
            "return_timestamps": True,
        }
        response = await self._post_with_retry(url, payload, bypass_status_codes=frozenset({404}))

        if response.status_code == 404:
            self._captions_supported = False
            audio = await self.generate_speech(text, voice, model, speed)
            return audio, None

        self._captions_supported = True
        try:
            data = response.json()
            audio = base64.b64decode(data["audio"])
            timestamps = [
                WordTimestamp(word=item["word"], start=item["start_time"], end=item["end_time"])
                for item in data["timestamps"]
            ]
        except (ValueError, KeyError, TypeError) as exc:
            raise RuntimeError(
                f"Malformed captioned-speech response from TTS server: {exc}"
            ) from exc
        if not audio:
            raise RuntimeError("TTS server returned empty audio with timestamps")
        return audio, timestamps

    async def close(self) -> None:
        await self._client.aclose()
