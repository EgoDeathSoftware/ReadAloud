from unittest.mock import AsyncMock, patch

import httpx
import pytest

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
