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


def test_extract_pdf_endpoint(client):
    from tests.pdf_test_helpers import make_pdf_bytes

    pdf_bytes = make_pdf_bytes("Hello World")
    response = client.post(
        "/api/extract/pdf", files={"file": ("test.pdf", pdf_bytes, "application/pdf")}
    )
    assert response.status_code == 200
    data = response.json()
    assert data["text"] == "Hello World"
    assert data["word_count"] == 2


def test_extract_pdf_endpoint_rejects_corrupt_pdf(client):
    response = client.post(
        "/api/extract/pdf", files={"file": ("bad.pdf", b"not a pdf", "application/pdf")}
    )
    assert response.status_code == 422


def test_extract_pdf_endpoint_rejects_oversized_upload(client):
    from readaloud.services.pdf_extractor import MAX_PDF_BYTES

    big = b"%PDF-1.4\n" + b"0" * MAX_PDF_BYTES
    response = client.post(
        "/api/extract/pdf", files={"file": ("big.pdf", big, "application/pdf")}
    )
    assert response.status_code == 413


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
    assert set(response.json()) == {
        "tts_base_url",
        "tts_model",
        "tts_default_voice",
        "max_chunk_chars",
    }


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
        mock_client.generate_speech_with_timestamps = AsyncMock(return_value=(b"mp3data", None))
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


def test_tts_generate_short_text_includes_cues(client, temp_job_store):
    with patch("readaloud.routes.tts.TtsClient") as mock_cls:
        mock_client = MagicMock()
        mock_client.generate_speech_with_timestamps = AsyncMock(return_value=(b"mp3data", None))
        mock_client.close = AsyncMock()
        mock_cls.return_value = mock_client

        response = client.post(
            "/api/tts/generate",
            json={"text": "First sentence. Second sentence."},
        )

    data = response.json()
    assert [cue["text"] for cue in data["cues"]] == [
        "First",
        "sentence.",
        "Second",
        "sentence.",
    ]


def test_job_state_holds_no_audio_bytes(client, temp_job_store):
    """Audio lives on disk; the in-memory job table keeps metadata only."""
    with patch("readaloud.routes.tts.TtsClient") as mock_cls:
        mock_client = MagicMock()
        mock_client.generate_speech_with_timestamps = AsyncMock(return_value=(b"mp3data", None))
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


async def test_long_text_job_status_includes_cues(temp_job_store):
    job_id = "cues-job"
    jobs[job_id] = JobState(id=job_id, chunks_total=2)

    with patch("readaloud.routes.tts.TtsClient") as mock_cls:
        mock_client = MagicMock()
        mock_client.generate_speech = AsyncMock(return_value=b"mp3data")
        mock_client.close = AsyncMock()
        mock_cls.return_value = mock_client

        await tts_routes._process_long_text(
            job_id, ["Chunk one.", "Chunk two."], "af_heart", "kokoro", 1.0
        )

    job = jobs[job_id]
    assert [cue.text for cue in job.cues] == ["Chunk", "one.", "Chunk", "two."]


async def test_long_text_job_status_cues_have_nonzero_duration(temp_job_store):
    from tests.mp3_test_helpers import build_frame

    job_id = "cues-duration-job"
    jobs[job_id] = JobState(id=job_id, chunks_total=1)

    frame = build_frame(bitrate_index=1, samplerate_index=0, mode=0)  # 44100Hz
    audio = frame + frame

    with patch("readaloud.routes.tts.TtsClient") as mock_cls:
        mock_client = MagicMock()
        mock_client.generate_speech = AsyncMock(return_value=audio)
        mock_client.close = AsyncMock()
        mock_cls.return_value = mock_client

        await tts_routes._process_long_text(
            job_id, ["First sentence. Second sentence."], "af_heart", "kokoro", 1.0
        )

    job = jobs[job_id]
    assert job.cues[0].end > 0
    expected_total = (1152 / 44100) * 2
    assert job.cues[-1].end == pytest.approx(expected_total)


async def test_known_chunk_hash_skips_synthesis(temp_job_store):
    import hashlib

    job_id = "cache-hit-job"
    jobs[job_id] = JobState(id=job_id, status="processing", chunks_total=2)
    known_hash = hashlib.sha256(b"a").hexdigest()

    with patch("readaloud.routes.tts.TtsClient") as mock_cls:
        mock_client = MagicMock()
        mock_client.generate_speech = AsyncMock(return_value=b"synth-b")
        mock_client.close = AsyncMock()
        mock_cls.return_value = mock_client

        await tts_routes._process_long_text(
            job_id, ["a", "b"], "af_heart", "kokoro", 1.0, {known_hash: b"cached-a"}
        )

    assert mock_client.generate_speech.await_count == 1
    assert mock_client.generate_speech.await_args.args[0] == "b"
    assert temp_job_store.read_chunk(job_id, 0) == b"cached-a"
    assert temp_job_store.read_chunk(job_id, 1) == b"synth-b"
    assert jobs[job_id].chunks[0].source == "client_cache"
    assert jobs[job_id].chunks[0].hash == known_hash
    assert jobs[job_id].chunks[1].source == "synthesized"


async def test_process_long_text_without_known_chunks_synthesizes_everything(temp_job_store):
    """Existing callers that omit the new param keep working unchanged."""
    job_id = "no-cache-job"
    jobs[job_id] = JobState(id=job_id, status="processing", chunks_total=1)

    with patch("readaloud.routes.tts.TtsClient") as mock_cls:
        mock_client = MagicMock()
        mock_client.generate_speech = AsyncMock(return_value=b"synth-only")
        mock_client.close = AsyncMock()
        mock_cls.return_value = mock_client

        await tts_routes._process_long_text(job_id, ["only"], "af_heart", "kokoro", 1.0)

    assert mock_client.generate_speech.await_count == 1
    assert jobs[job_id].chunks[0].source == "synthesized"


def test_tts_generate_known_chunk_skips_synthesis_end_to_end(client, temp_job_store, monkeypatch):
    import base64
    import hashlib
    import time as time_module

    from readaloud.config import settings as app_settings

    monkeypatch.setattr(app_settings, "MAX_CHUNK_CHARS", 10)
    text = "AAAAAAAAAA\n\nBBBBBBBBBB"
    known_hash = hashlib.sha256(b"AAAAAAAAAA").hexdigest()
    known_audio_b64 = base64.b64encode(b"cached-audio").decode()

    with patch("readaloud.routes.tts.TtsClient") as mock_cls:
        mock_client = MagicMock()
        mock_client.generate_speech = AsyncMock(return_value=b"synth-audio")
        mock_client.close = AsyncMock()
        mock_cls.return_value = mock_client

        response = client.post(
            "/api/tts/generate",
            json={
                "text": text,
                "known_chunks": [{"hash": known_hash, "audio_b64": known_audio_b64}],
            },
        )
        assert response.status_code == 200
        job_id = response.json()["job_id"]

        deadline = time_module.monotonic() + 5
        while jobs[job_id].status == "processing" and time_module.monotonic() < deadline:
            time_module.sleep(0.01)

    assert jobs[job_id].status == "complete"
    assert mock_client.generate_speech.await_count == 1
    assert temp_job_store.read_chunk(job_id, 0) == b"cached-audio"
    assert temp_job_store.read_chunk(job_id, 1) == b"synth-audio"

    status = client.get(f"/api/tts/status/{job_id}").json()
    assert status["chunks"][0]["source"] == "client_cache"
    assert status["chunks"][0]["hash"] == known_hash
    assert status["chunks"][1]["source"] == "synthesized"


def test_tts_generate_drops_malformed_known_chunk_audio(client, temp_job_store, monkeypatch):
    import time as time_module

    from readaloud.config import settings as app_settings

    monkeypatch.setattr(app_settings, "MAX_CHUNK_CHARS", 10)
    text = "AAAAAAAAAA\n\nBBBBBBBBBB"

    with patch("readaloud.routes.tts.TtsClient") as mock_cls:
        mock_client = MagicMock()
        mock_client.generate_speech = AsyncMock(return_value=b"synth")
        mock_client.close = AsyncMock()
        mock_cls.return_value = mock_client

        response = client.post(
            "/api/tts/generate",
            json={
                "text": text,
                "known_chunks": [{"hash": "irrelevant", "audio_b64": "not-valid-base64!!"}],
            },
        )
        assert response.status_code == 200
        job_id = response.json()["job_id"]

        deadline = time_module.monotonic() + 5
        while jobs[job_id].status == "processing" and time_module.monotonic() < deadline:
            time_module.sleep(0.01)

    assert jobs[job_id].status == "complete"
    assert mock_client.generate_speech.await_count == 2


def test_tts_generate_rejects_too_many_known_chunks(client):
    known_chunks = [{"hash": str(i), "audio_b64": "ZmFrZQ=="} for i in range(501)]
    response = client.post(
        "/api/tts/generate",
        json={"text": "Short text", "known_chunks": known_chunks},
    )
    assert response.status_code == 413


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
