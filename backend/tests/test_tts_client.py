import base64
import json
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from readaloud.config import auth_headers, settings
from readaloud.services.reading_cues import WordTimestamp
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
async def test_generate_speech_raises_on_empty_audio(client):
    empty_response = httpx.Response(200, content=b"", request=httpx.Request("POST", "http://test"))
    with patch.object(client._client, "post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = empty_response
        with pytest.raises(RuntimeError, match="empty audio"):
            await client.generate_speech("Hello")
    await client.close()


@pytest.mark.asyncio
async def test_generate_speech_raises_after_max_retries(client):
    with patch.object(client._client, "post", new_callable=AsyncMock) as mock_post:
        mock_post.side_effect = httpx.ConnectError("Connection refused")
        with pytest.raises(RuntimeError, match="TTS generation failed"):
            await client.generate_speech("Hello")
    assert mock_post.call_count == 3
    await client.close()


@pytest.mark.asyncio
async def test_generate_speech_does_not_retry_client_error(client):
    error_body = json.dumps({"error": {"message": "Invalid voice: bogus"}}).encode()
    error_response = httpx.Response(
        400, content=error_body, request=httpx.Request("POST", "http://test")
    )
    with patch.object(client._client, "post", new_callable=AsyncMock) as mock_post:
        mock_post.side_effect = httpx.HTTPStatusError(
            "Bad request", request=error_response.request, response=error_response
        )
        with pytest.raises(RuntimeError, match="Invalid voice: bogus"):
            await client.generate_speech("Hello", voice="bogus")
    assert mock_post.call_count == 1
    await client.close()


@pytest.mark.asyncio
async def test_generate_speech_honors_retry_after_header(client):
    error_response = httpx.Response(
        429,
        headers={"Retry-After": "7"},
        request=httpx.Request("POST", "http://test"),
    )
    success_response = httpx.Response(
        200, content=b"audio", request=httpx.Request("POST", "http://test")
    )
    with (
        patch.object(client._client, "post", new_callable=AsyncMock) as mock_post,
        patch("readaloud.services.tts_client.asyncio.sleep", new_callable=AsyncMock) as mock_sleep,
    ):
        mock_post.side_effect = [
            httpx.HTTPStatusError(
                "Rate limited", request=error_response.request, response=error_response
            ),
            success_response,
        ]
        result = await client.generate_speech("Hello")
    assert result == b"audio"
    assert mock_post.call_count == 2
    mock_sleep.assert_awaited_once_with(7.0)
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


@pytest.mark.asyncio
async def test_generate_speech_with_timestamps_success(client):
    body = json.dumps(
        {
            "audio": base64.b64encode(b"fake-mp3-data").decode(),
            "audio_format": "audio/mpeg",
            "timestamps": [
                {"word": "Hello", "start_time": 0.0, "end_time": 0.3},
                {"word": ",", "start_time": 0.3, "end_time": 0.4},
            ],
        }
    ).encode()
    mock_response = httpx.Response(200, content=body, request=httpx.Request("POST", "http://test"))
    with patch.object(client._client, "post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = mock_response
        audio, timestamps = await client.generate_speech_with_timestamps("Hello,")
    assert audio == b"fake-mp3-data"
    assert timestamps == [
        WordTimestamp(word="Hello", start=0.0, end=0.3),
        WordTimestamp(word=",", start=0.3, end=0.4),
    ]
    await client.close()


@pytest.mark.asyncio
async def test_generate_speech_with_timestamps_falls_back_on_404(client):
    not_found = httpx.Response(404, request=httpx.Request("POST", "http://test"))
    fallback_response = httpx.Response(
        200, content=b"fallback-audio", request=httpx.Request("POST", "http://test")
    )
    with patch.object(client._client, "post", new_callable=AsyncMock) as mock_post:
        mock_post.side_effect = [not_found, fallback_response]
        audio, timestamps = await client.generate_speech_with_timestamps("Hello")
    assert audio == b"fallback-audio"
    assert timestamps is None
    assert client._captions_supported is False
    assert mock_post.call_count == 2
    await client.close()


@pytest.mark.asyncio
async def test_generate_speech_with_timestamps_skips_captions_after_first_404(client):
    client._captions_supported = False
    mock_response = httpx.Response(
        200, content=b"plain-audio", request=httpx.Request("POST", "http://test")
    )
    with patch.object(client._client, "post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = mock_response
        audio, timestamps = await client.generate_speech_with_timestamps("Hello")
    assert audio == b"plain-audio"
    assert timestamps is None
    assert mock_post.call_count == 1
    called_url = mock_post.await_args.args[0]
    assert called_url.endswith("/v1/audio/speech")
    await client.close()


@pytest.mark.asyncio
async def test_generate_speech_with_timestamps_retries_on_server_error(client):
    error_response = httpx.Response(500, request=httpx.Request("POST", "http://test"))
    body = json.dumps(
        {
            "audio": base64.b64encode(b"audio-after-retry").decode(),
            "audio_format": "audio/mpeg",
            "timestamps": [{"word": "Hi", "start_time": 0.0, "end_time": 0.2}],
        }
    ).encode()
    success_response = httpx.Response(
        200, content=body, request=httpx.Request("POST", "http://test")
    )
    with patch.object(client._client, "post", new_callable=AsyncMock) as mock_post:
        mock_post.side_effect = [
            httpx.HTTPStatusError(
                "Server error", request=error_response.request, response=error_response
            ),
            success_response,
        ]
        audio, timestamps = await client.generate_speech_with_timestamps("Hi")
    assert audio == b"audio-after-retry"
    assert timestamps == [WordTimestamp(word="Hi", start=0.0, end=0.2)]
    assert mock_post.call_count == 2
    await client.close()


@pytest.mark.asyncio
async def test_generate_speech_with_timestamps_raises_on_empty_audio(client):
    body = json.dumps({"audio": "", "audio_format": "audio/mpeg", "timestamps": []}).encode()
    mock_response = httpx.Response(200, content=body, request=httpx.Request("POST", "http://test"))
    with patch.object(client._client, "post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = mock_response
        with pytest.raises(RuntimeError, match="empty audio"):
            await client.generate_speech_with_timestamps("Hello")
    await client.close()


@pytest.mark.asyncio
async def test_generate_speech_with_timestamps_raises_on_malformed_response(client):
    # Observed in production: a Kokoro GPU-context failure returns HTTP 200
    # with an empty body. response.json() would raise json.JSONDecodeError
    # before the empty-audio check is reached; this must surface as a clear
    # RuntimeError instead of that raw parse error.
    mock_response = httpx.Response(200, content=b"", request=httpx.Request("POST", "http://test"))
    with patch.object(client._client, "post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = mock_response
        with pytest.raises(RuntimeError, match="Malformed captioned-speech response"):
            await client.generate_speech_with_timestamps("Hello")
    await client.close()


@pytest.mark.asyncio
async def test_generate_speech_with_timestamps_propagates_non_retryable_error(client):
    error_body = json.dumps({"error": {"message": "Invalid voice: bogus"}}).encode()
    error_response = httpx.Response(
        400, content=error_body, request=httpx.Request("POST", "http://test")
    )
    with patch.object(client._client, "post", new_callable=AsyncMock) as mock_post:
        mock_post.side_effect = httpx.HTTPStatusError(
            "Bad request", request=error_response.request, response=error_response
        )
        with pytest.raises(RuntimeError, match="Invalid voice: bogus"):
            await client.generate_speech_with_timestamps("Hello", voice="bogus")
    assert mock_post.call_count == 1
    await client.close()
