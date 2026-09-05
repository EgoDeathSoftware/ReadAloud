import asyncio
import base64
import hashlib
import logging
import time
import uuid
from dataclasses import dataclass, field

from fastapi import APIRouter, BackgroundTasks, HTTPException
from fastapi.responses import FileResponse, Response

from readaloud.config import settings
from readaloud.models.schemas import (
    ChunkStatus,
    Cue,
    KnownChunk,
    TtsGenerateRequest,
    TtsGenerateResponse,
    TtsStatusResponse,
)
from readaloud.services.job_store import job_store
from readaloud.services.mp3_frames import frame_duration_seconds, real_audio_frames
from readaloud.services.reading_cues import compute_cues
from readaloud.services.text_chunker import chunk_text
from readaloud.services.tts_client import TtsClient

router = APIRouter()
logger = logging.getLogger(__name__)

MAX_KNOWN_CHUNKS = 500


@dataclass
class JobState:
    """Metadata for one generation job.

    Deliberately holds no audio: the bytes live in `job_store` on disk so a long
    article does not pin its audio in memory for the life of the process.
    """

    id: str
    status: str = "processing"
    progress: float = 0.0
    chunks_completed: int = 0
    chunks_total: int = 0
    error: str | None = None
    created_at: float = field(default_factory=time.time)
    chunks: list[ChunkStatus] = field(default_factory=list)
    cues: list[Cue] = field(default_factory=list)


jobs: dict[str, JobState] = {}

JOB_TTL_SECONDS = 3600
SWEEP_INTERVAL_SECONDS = 300


def _cleanup_old_jobs() -> None:
    """Drop jobs past their TTL, along with their audio on disk."""
    now = time.time()
    expired = [jid for jid, job in jobs.items() if now - job.created_at > JOB_TTL_SECONDS]
    for jid in expired:
        job_store.delete(jid)
        del jobs[jid]


async def sweep_jobs_forever() -> None:
    """Enforce the TTL on a timer.

    Sweeping only on incoming generate requests meant an idle server held every
    finished job's audio indefinitely.
    """
    while True:
        _cleanup_old_jobs()
        await asyncio.sleep(SWEEP_INTERVAL_SECONDS)


def shutdown_job_storage() -> None:
    """Drop all job audio. Called on application shutdown."""
    jobs.clear()
    job_store.purge()


async def _process_long_text(
    job_id: str,
    chunks: list[str],
    voice: str,
    model: str,
    speed: float,
    known_by_hash: dict[str, bytes] | None = None,
) -> None:
    """Background task to generate and stitch audio for chunked text.

    Each chunk is written straight to disk and dropped from memory. Once every
    chunk has landed they are stitched into the final file and the chunk files are
    removed, so a finished job costs one copy of the audio rather than two. The
    per-chunk endpoints keep working against that single copy.

    A chunk whose hash is already in `known_by_hash` uses those bytes instead of
    calling the TTS server -- the client already has this audio from a prior
    session and uploaded it rather than asking for it to be resynthesized.
    """
    job = jobs[job_id]
    client = TtsClient()
    known_by_hash = known_by_hash or {}

    try:
        for i, chunk in enumerate(chunks):
            chunk_hash = hashlib.sha256(chunk.encode("utf-8")).hexdigest()
            cached_audio = known_by_hash.get(chunk_hash)
            if cached_audio is not None:
                audio = cached_audio
                source = "client_cache"
            else:
                audio = await client.generate_speech(chunk, voice, model, speed)
                source = "synthesized"

            job_store.write_chunk(job_id, i, audio)
            job.chunks.append(ChunkStatus(index=i, hash=chunk_hash, source=source))
            job.chunks_completed = i + 1
            job.progress = job.chunks_completed / job.chunks_total

        job_store.finalize_from_chunks(job_id, len(chunks))
        try:
            job.cues = _job_cues(job_id, chunks)
        except Exception:
            logger.warning("Failed to compute reading cues for job %s", job_id, exc_info=True)
        job.status = "complete"
    except Exception as exc:
        job.status = "failed"
        job.error = str(exc)
    finally:
        await client.close()


def _job_cues(job_id: str, chunks: list[str]) -> list[Cue]:
    """Compute reading cues from each chunk's finalized audio.

    Reads chunks back from `job_store` rather than the bytes just
    synthesized, since a `client_cache`-sourced chunk was never held in
    memory here to begin with.
    """
    durations = []
    for index in range(len(chunks)):
        audio = job_store.read_chunk(job_id, index) or b""
        durations.append(frame_duration_seconds(real_audio_frames(audio)))
    return compute_cues(chunks, durations)


def _decode_known_chunks(known_chunks: list[KnownChunk]) -> dict[str, bytes]:
    """Decode client-supplied cached chunk audio, dropping unreadable entries.

    A malformed entry must never fail the whole request -- it just means that
    one chunk gets resynthesized instead of reused.
    """
    decoded: dict[str, bytes] = {}
    for entry in known_chunks:
        try:
            decoded[entry.hash] = base64.b64decode(entry.audio_b64, validate=True)
        except ValueError:
            logger.warning("Dropping known_chunk with unreadable audio_b64 (hash=%s)", entry.hash)
    return decoded


@router.post("/tts/generate")
async def generate_tts(
    request: TtsGenerateRequest,
    background_tasks: BackgroundTasks,
) -> TtsGenerateResponse:
    """Generate TTS audio from text."""
    _cleanup_old_jobs()

    if len(request.known_chunks) > MAX_KNOWN_CHUNKS:
        raise HTTPException(
            status_code=413,
            detail=f"Too many known_chunks (max {MAX_KNOWN_CHUNKS})",
        )

    job_id = str(uuid.uuid4())
    voice = request.voice or settings.TTS_DEFAULT_VOICE
    model = request.model or settings.TTS_MODEL

    if len(request.text) <= settings.MAX_CHUNK_CHARS:
        client = TtsClient()
        try:
            audio = await client.generate_speech(request.text, voice, model, request.speed)
        finally:
            await client.close()

        job_store.write_final(job_id, audio)
        cues = compute_cues([request.text], [frame_duration_seconds(real_audio_frames(audio))])
        jobs[job_id] = JobState(
            id=job_id,
            status="complete",
            progress=1.0,
            chunks_completed=1,
            chunks_total=1,
            cues=cues,
        )
        return TtsGenerateResponse(
            job_id=job_id,
            status="complete",
            audio_url=f"/api/tts/audio/{job_id}",
            cues=cues,
        )

    known_by_hash = _decode_known_chunks(request.known_chunks)
    chunks = chunk_text(request.text, settings.MAX_CHUNK_CHARS)
    jobs[job_id] = JobState(
        id=job_id,
        status="processing",
        chunks_total=len(chunks),
    )
    background_tasks.add_task(
        _process_long_text, job_id, chunks, voice, model, request.speed, known_by_hash
    )
    return TtsGenerateResponse(
        job_id=job_id,
        status="processing",
        audio_url=f"/api/tts/audio/{job_id}",
    )


@router.get("/tts/status/{job_id}")
async def get_tts_status(job_id: str) -> TtsStatusResponse:
    """Get the status of a TTS generation job."""
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return TtsStatusResponse(
        job_id=job.id,
        status=job.status,
        progress=job.progress,
        chunks_completed=job.chunks_completed,
        chunks_total=job.chunks_total,
        error=job.error,
        chunks=job.chunks,
        cues=job.cues,
    )


@router.get("/tts/audio/{job_id}")
async def get_tts_audio(job_id: str) -> FileResponse:
    """Download the generated audio for a completed job."""
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    path = job_store.final_path(job_id) if job.status == "complete" else None
    if path is None:
        raise HTTPException(status_code=400, detail=f"Job not ready: {job.status}")
    return FileResponse(path, media_type="audio/mpeg")


@router.get("/tts/audio/{job_id}/{chunk_index}")
async def get_tts_chunk_audio(job_id: str, chunk_index: int) -> Response:
    """Download audio for a single chunk.

    Stays available after the job completes: clients pull chunks lazily and are
    routinely still behind when generation finishes.
    """
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")

    audio = job_store.read_chunk(job_id, chunk_index)
    if audio is None:
        raise HTTPException(status_code=503, detail=f"Chunk {chunk_index} not ready")
    return Response(content=audio, media_type="audio/mpeg")
