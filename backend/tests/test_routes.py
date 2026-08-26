import json
import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from readaloud.main import app
from readaloud.main import create_app as tts_routes_app
from readaloud.routes import tts as tts_routes
from readaloud.routes.tts import JobState, jobs
from readaloud.services.job_store import JobStore


@pytest.fixture(autouse=True)
def temp_job_store(tmp_path, monkeypatch):
    """Point job audio at a per-test directory and start from an empty job table."""
    store = JobStore(root=tmp_path / "jobs")
    monkeypatch.setattr(tts_routes, "job_store", store)
    jobs.clear()
    yield store
    jobs.clear()


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


def test_settings_get_returns_config(client):
    response = client.get("/api/settings")
    assert response.status_code == 200
    assert set(response.json()) == {"tts_base_url", "tts_model", "tts_default_voice"}


def test_settings_put_is_gone(client):
    response = client.put("/api/settings", json={"tts_base_url": "http://evil.test"})
    assert response.status_code == 405


def test_settings_get_never_leaks_api_key(client, monkeypatch):
    from readaloud.config import settings as app_settings

    monkeypatch.setattr(app_settings, "TTS_API_KEY", "sk-secret")
    assert "sk-secret" not in json.dumps(client.get("/api/settings").json())


def test_tts_generate_short_text(client, temp_job_store):
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

    job_id = data["job_id"]
    assert temp_job_store.read_final(job_id) == b"mp3data"


def test_job_state_holds_no_audio_bytes(client, temp_job_store):
    """Audio lives on disk; the in-memory job table keeps metadata only."""
    with patch("readaloud.routes.tts.TtsClient") as mock_cls:
        mock_client = MagicMock()
        mock_client.generate_speech = AsyncMock(return_value=b"mp3data")
        mock_client.close = AsyncMock()
        mock_cls.return_value = mock_client
        response = client.post("/api/tts/generate", json={"text": "Short text"})

    job = jobs[response.json()["job_id"]]
    assert not any(isinstance(value, bytes) for value in vars(job).values())
    assert not any(
        isinstance(value, (list, dict)) and any(isinstance(v, bytes) for v in value)
        for value in vars(job).values()
    )


def test_tts_status_not_found(client):
    response = client.get("/api/tts/status/nonexistent")
    assert response.status_code == 404


def test_tts_audio_complete_job(client, temp_job_store):
    job_id = "test-audio-job"
    jobs[job_id] = JobState(id=job_id, status="complete")
    temp_job_store.write_final(job_id, b"fake-audio")

    response = client.get(f"/api/tts/audio/{job_id}")
    assert response.status_code == 200
    assert response.content == b"fake-audio"
    assert response.headers["content-type"] == "audio/mpeg"


def test_tts_audio_not_ready(client):
    job_id = "test-pending-job"
    jobs[job_id] = JobState(id=job_id, status="processing")
    response = client.get(f"/api/tts/audio/{job_id}")
    assert response.status_code == 400


def test_tts_audio_complete_but_file_missing(client):
    """A swept job whose metadata outlived its audio must not 500."""
    job_id = "test-swept-job"
    jobs[job_id] = JobState(id=job_id, status="complete")
    response = client.get(f"/api/tts/audio/{job_id}")
    assert response.status_code == 400


def test_tts_chunk_audio(client, temp_job_store):
    job_id = "test-chunk-job"
    jobs[job_id] = JobState(
        id=job_id,
        status="processing",
        chunks_total=3,
        chunks_completed=2,
    )
    temp_job_store.write_chunk(job_id, 0, b"chunk-0-audio")
    temp_job_store.write_chunk(job_id, 1, b"chunk-1-audio")

    response = client.get(f"/api/tts/audio/{job_id}/0")
    assert response.status_code == 200
    assert response.content == b"chunk-0-audio"
    assert response.headers["content-type"] == "audio/mpeg"

    response = client.get(f"/api/tts/audio/{job_id}/1")
    assert response.status_code == 200
    assert response.content == b"chunk-1-audio"

    response = client.get(f"/api/tts/audio/{job_id}/2")
    assert response.status_code == 503


def test_tts_chunk_audio_job_not_found(client):
    response = client.get("/api/tts/audio/nonexistent/0")
    assert response.status_code == 404


async def test_long_text_streams_chunks_and_keeps_them_readable(temp_job_store):
    """Chunk endpoints keep working after the stitch: clients fetch them lazily."""
    job_id = "long-job"
    jobs[job_id] = JobState(id=job_id, status="processing", chunks_total=3)

    with patch("readaloud.routes.tts.TtsClient") as mock_cls:
        mock_client = MagicMock()
        mock_client.generate_speech = AsyncMock(side_effect=[b"one", b"two", b"three"])
        mock_client.close = AsyncMock()
        mock_cls.return_value = mock_client

        await tts_routes._process_long_text(job_id, ["a", "b", "c"], "af_heart", "kokoro", 1.0)

    assert jobs[job_id].status == "complete"
    assert temp_job_store.read_final(job_id) == b"onetwothree"
    assert not list((temp_job_store.root / job_id).glob("chunk-*.mp3"))
    for index, expected in enumerate([b"one", b"two", b"three"]):
        assert temp_job_store.read_chunk(job_id, index) == expected


async def test_chunk_endpoint_serves_a_completed_job(client, temp_job_store):
    """A client still walking the chunks of a finished job must not get a 503."""
    job_id = "done-job"
    jobs[job_id] = JobState(id=job_id, status="processing", chunks_total=2)

    with patch("readaloud.routes.tts.TtsClient") as mock_cls:
        mock_client = MagicMock()
        mock_client.generate_speech = AsyncMock(side_effect=[b"one", b"two"])
        mock_client.close = AsyncMock()
        mock_cls.return_value = mock_client
        await tts_routes._process_long_text(job_id, ["a", "b"], "af_heart", "kokoro", 1.0)

    assert client.get(f"/api/tts/audio/{job_id}/0").content == b"one"
    assert client.get(f"/api/tts/audio/{job_id}/1").content == b"two"
    assert client.get(f"/api/tts/audio/{job_id}/2").status_code == 503


async def test_failed_long_job_records_the_error(temp_job_store):
    job_id = "failing-job"
    jobs[job_id] = JobState(id=job_id, status="processing", chunks_total=2)

    with patch("readaloud.routes.tts.TtsClient") as mock_cls:
        mock_client = MagicMock()
        mock_client.generate_speech = AsyncMock(side_effect=RuntimeError("tts exploded"))
        mock_client.close = AsyncMock()
        mock_cls.return_value = mock_client

        await tts_routes._process_long_text(job_id, ["a", "b"], "af_heart", "kokoro", 1.0)

    assert jobs[job_id].status == "failed"
    assert "tts exploded" in jobs[job_id].error


def test_expired_jobs_have_their_audio_deleted(temp_job_store):
    fresh, stale = "fresh-job", "stale-job"
    jobs[fresh] = JobState(id=fresh, status="complete")
    jobs[stale] = JobState(id=stale, status="complete", created_at=0.0)
    temp_job_store.write_final(fresh, b"keep")
    temp_job_store.write_final(stale, b"drop")

    tts_routes._cleanup_old_jobs()

    assert stale not in jobs
    assert temp_job_store.read_final(stale) is None
    assert fresh in jobs
    assert temp_job_store.read_final(fresh) == b"keep"


def test_sweeper_expires_jobs_without_any_request(monkeypatch, temp_job_store):
    """TTL must not depend on a new generate request arriving."""
    monkeypatch.setattr(tts_routes, "SWEEP_INTERVAL_SECONDS", 0.01)
    stale = "stale-job"
    jobs[stale] = JobState(id=stale, status="complete", created_at=0.0)
    temp_job_store.write_final(stale, b"drop")

    with TestClient(tts_routes_app()):
        deadline = time.monotonic() + 5
        while stale in jobs and time.monotonic() < deadline:
            time.sleep(0.02)

    assert stale not in jobs
    assert temp_job_store.read_final(stale) is None


def test_shutdown_purges_job_storage(temp_job_store):
    temp_job_store.write_final("job-1", b"audio")
    with TestClient(tts_routes_app()):
        pass
    assert temp_job_store.read_final("job-1") is None
