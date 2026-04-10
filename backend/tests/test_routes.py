from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from readaloud.main import app
from readaloud.routes.tts import JobState, jobs


@pytest.fixture
def client():
    return TestClient(app)


def test_health_check_tts_unreachable(client):
    with patch("readaloud.routes.health.httpx.AsyncClient") as mock_cls:
        mock_client = AsyncMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        import httpx

        mock_client.get.side_effect = httpx.ConnectError("refused")
        mock_cls.return_value = mock_client
        response = client.get("/api/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "unhealthy"
    assert data["tts_server"] == "unreachable"


def test_extract_endpoint(client):
    mock_content = MagicMock()
    mock_content.title = "Test Title"
    mock_content.text = "Some extracted text here"
    mock_content.word_count = 4

    with patch("readaloud.routes.extract.extract_from_url", return_value=mock_content):
        response = client.post("/api/extract", json={"url": "https://example.com"})
    assert response.status_code == 200
    data = response.json()
    assert data["text"] == "Some extracted text here"
    assert data["word_count"] == 4


def test_extract_endpoint_failure(client):
    with patch(
        "readaloud.routes.extract.extract_from_url",
        side_effect=ValueError("Could not fetch URL: https://bad.com"),
    ):
        response = client.post("/api/extract", json={"url": "https://bad.com"})
    assert response.status_code == 422


def test_voices_fallback(client):
    with patch("readaloud.routes.voices.httpx.AsyncClient") as mock_cls:
        mock_client = AsyncMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        import httpx

        mock_client.get.side_effect = httpx.ConnectError("refused")
        mock_cls.return_value = mock_client
        response = client.get("/api/voices")
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 6
    ids = [v["id"] for v in data]
    assert "alloy" in ids


def test_settings_get(client):
    response = client.get("/api/settings")
    assert response.status_code == 200
    data = response.json()
    assert "tts_mode" in data
    assert "tts_base_url" in data


def test_settings_update(client):
    response = client.put(
        "/api/settings",
        json={"tts_model": "new-model"},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["tts_model"] == "new-model"


def test_tts_generate_short_text(client):
    with patch("readaloud.routes.tts.TtsClient") as mock_cls:
        mock_client = MagicMock()
        mock_client.generate_speech = AsyncMock(return_value=b"mp3data")
        mock_client.close = AsyncMock()
        mock_cls.return_value = mock_client

        response = client.post(
            "/api/tts/generate",
            json={"text": "Short text"},
        )
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "complete"
    assert data["audio_url"] is not None


def test_tts_status_not_found(client):
    response = client.get("/api/tts/status/nonexistent")
    assert response.status_code == 404


def test_tts_audio_complete_job(client):
    job_id = "test-audio-job"
    jobs[job_id] = JobState(
        id=job_id,
        status="complete",
        audio_data=b"fake-audio",
    )
    response = client.get(f"/api/tts/audio/{job_id}")
    assert response.status_code == 200
    assert response.content == b"fake-audio"
    assert response.headers["content-type"] == "audio/mpeg"
    del jobs[job_id]


def test_tts_audio_not_ready(client):
    job_id = "test-pending-job"
    jobs[job_id] = JobState(id=job_id, status="processing")
    response = client.get(f"/api/tts/audio/{job_id}")
    assert response.status_code == 400
    del jobs[job_id]


def test_tts_chunk_audio(client):
    job_id = "test-chunk-job"
    jobs[job_id] = JobState(
        id=job_id,
        status="processing",
        chunks_total=3,
        chunks_completed=2,
        chunk_audio={0: b"chunk-0-audio", 1: b"chunk-1-audio"},
    )
    response = client.get(f"/api/tts/audio/{job_id}/0")
    assert response.status_code == 200
    assert response.content == b"chunk-0-audio"
    assert response.headers["content-type"] == "audio/mpeg"

    response = client.get(f"/api/tts/audio/{job_id}/1")
    assert response.status_code == 200
    assert response.content == b"chunk-1-audio"

    response = client.get(f"/api/tts/audio/{job_id}/2")
    assert response.status_code == 503

    del jobs[job_id]


def test_tts_chunk_audio_job_not_found(client):
    response = client.get("/api/tts/audio/nonexistent/0")
    assert response.status_code == 404
