from unittest.mock import AsyncMock, patch

import httpx
import pytest

from readaloud.config import auth_headers, settings
from readaloud.services.tts_client import TtsClient


@pytest.fixture
def client():
    return TtsClient()


@pytest.mark.asyncio
async def test_generate_speech_success(client):
    mock_request = httpx.Request("POST", "http://test")
    mock_response = httpx.Response(200, content=b"fake-mp3-data", request=mock_request)
    with patch.object(client._client, "post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = mock_response
        result = await client.generate_speech("Hello")
    assert result == b"fake-mp3-data"
    await client.close()


@pytest.mark.asyncio
async def test_generate_speech_retries_on_failure(client):
    error_response = httpx.Response(500, request=httpx.Request("POST", "http://test"))
    success_response = httpx.Response(
        200, content=b"audio", request=httpx.Request("POST", "http://test")
    )
    with patch.object(client._client, "post", new_callable=AsyncMock) as mock_post:
        mock_post.side_effect = [
            httpx.HTTPStatusError(
                "Server error", request=error_response.request, response=error_response
            ),
            success_response,
        ]
        result = await client.generate_speech("Hello")
    assert result == b"audio"
    assert mock_post.call_count == 2
    await client.close()


@pytest.mark.asyncio
async def test_generate_speech_raises_after_max_retries(client):
    with patch.object(client._client, "post", new_callable=AsyncMock) as mock_post:
        mock_post.side_effect = httpx.ConnectError("Connection refused")
        with pytest.raises(RuntimeError, match="TTS generation failed"):
            await client.generate_speech("Hello")
    assert mock_post.call_count == 3
    await client.close()


def test_auth_headers_empty_when_no_key(monkeypatch):
    monkeypatch.setattr(settings, "TTS_API_KEY", "")
    assert auth_headers() == {}


def test_auth_headers_bearer_when_key_set(monkeypatch):
    monkeypatch.setattr(settings, "TTS_API_KEY", "sk-test-123")
    assert auth_headers() == {"Authorization": "Bearer sk-test-123"}


async def _capture_request_headers(monkeypatch, api_key: str) -> dict[str, str]:
    """Run one generate_speech call against a mock transport, returning the headers sent."""
    monkeypatch.setattr(settings, "TTS_API_KEY", api_key)
    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(request.headers)
        return httpx.Response(200, content=b"ID3audio")

    tts = TtsClient()
    await tts.close()
    tts._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        audio = await tts.generate_speech("hello", "af_heart", "kokoro", 1.0)
    finally:
        await tts.close()

    assert audio == b"ID3audio"
    return seen


@pytest.mark.asyncio
async def test_generate_speech_sends_bearer_token(monkeypatch):
    seen = await _capture_request_headers(monkeypatch, "sk-test-123")
    assert seen["authorization"] == "Bearer sk-test-123"


@pytest.mark.asyncio
async def test_generate_speech_omits_auth_header_when_no_key(monkeypatch):
    seen = await _capture_request_headers(monkeypatch, "")
    assert "authorization" not in seen
