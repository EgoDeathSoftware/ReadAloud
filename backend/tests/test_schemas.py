from readaloud.models.schemas import (
    ChunkStatus,
    KnownChunk,
    TtsGenerateRequest,
    TtsStatusResponse,
)


def test_tts_generate_request_known_chunks_defaults_empty():
    request = TtsGenerateRequest(text="hello")
    assert request.known_chunks == []


def test_tts_generate_request_accepts_known_chunks():
    request = TtsGenerateRequest(
        text="hello",
        known_chunks=[KnownChunk(hash="abc123", audio_b64="ZmFrZQ==")],
    )
    assert request.known_chunks[0].hash == "abc123"
    assert request.known_chunks[0].audio_b64 == "ZmFrZQ=="


def test_tts_status_response_chunks_defaults_empty():
    response = TtsStatusResponse(job_id="j1", status="processing")
    assert response.chunks == []


def test_chunk_status_source_is_constrained():
    status = ChunkStatus(index=0, hash="abc123", source="client_cache")
    assert status.source == "client_cache"
