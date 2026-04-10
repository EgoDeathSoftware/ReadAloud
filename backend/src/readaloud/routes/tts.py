import time
import uuid
from dataclasses import dataclass, field

from fastapi import APIRouter, BackgroundTasks, HTTPException
from fastapi.responses import Response

from readaloud.config import settings
from readaloud.models.schemas import (
    TtsGenerateRequest,
    TtsGenerateResponse,
    TtsStatusResponse,
)
from readaloud.services.audio_stitcher import stitch_mp3
from readaloud.services.text_chunker import chunk_text
from readaloud.services.tts_client import TtsClient

router = APIRouter()


@dataclass
class JobState:
    id: str
    status: str = "processing"
    progress: float = 0.0
    chunks_completed: int = 0
    chunks_total: int = 0
    audio_data: bytes | None = None
    chunk_audio: dict[int, bytes] = field(default_factory=dict)
    error: str | None = None
    created_at: float = field(default_factory=time.time)


jobs: dict[str, JobState] = {}

JOB_TTL_SECONDS = 3600


def _cleanup_old_jobs() -> None:
    now = time.time()
    expired = [
        jid for jid, job in jobs.items()
        if now - job.created_at > JOB_TTL_SECONDS
    ]
    for jid in expired:
        del jobs[jid]


async def _process_long_text(
    job_id: str,
    chunks: list[str],
    voice: str,
    model: str,
    speed: float,
) -> None:
    """Background task to generate and stitch audio for chunked text."""
    job = jobs[job_id]
    client = TtsClient()
    audio_chunks: list[bytes] = []

    try:
        for i, chunk in enumerate(chunks):
            audio = await client.generate_speech(chunk, voice, model, speed)
            audio_chunks.append(audio)
            job.chunk_audio[i] = audio
            job.chunks_completed = i + 1
            job.progress = job.chunks_completed / job.chunks_total

        job.audio_data = stitch_mp3(audio_chunks)
        job.status = "complete"
    except Exception as exc:
        job.status = "failed"
        job.error = str(exc)
    finally:
        await client.close()


@router.post("/tts/generate")
async def generate_tts(
    request: TtsGenerateRequest,
    background_tasks: BackgroundTasks,
) -> TtsGenerateResponse:
    """Generate TTS audio from text."""
    _cleanup_old_jobs()

    job_id = str(uuid.uuid4())
    voice = request.voice or settings.TTS_DEFAULT_VOICE
    model = request.model or settings.TTS_MODEL

    if len(request.text) <= settings.MAX_CHUNK_CHARS:
        client = TtsClient()
        try:
            audio = await client.generate_speech(
                request.text, voice, model, request.speed
            )
        finally:
            await client.close()

        jobs[job_id] = JobState(
            id=job_id,
            status="complete",
            progress=1.0,
            chunks_completed=1,
            chunks_total=1,
            audio_data=audio,
        )
        return TtsGenerateResponse(
            job_id=job_id,
            status="complete",
            audio_url=f"/api/tts/audio/{job_id}",
        )

    chunks = chunk_text(request.text, settings.MAX_CHUNK_CHARS)
    jobs[job_id] = JobState(
        id=job_id,
        status="processing",
        chunks_total=len(chunks),
    )
    background_tasks.add_task(
        _process_long_text, job_id, chunks, voice, model, request.speed
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
    )


@router.get("/tts/audio/{job_id}")
async def get_tts_audio(job_id: str) -> Response:
    """Download the generated audio for a completed job."""
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.status != "complete" or job.audio_data is None:
        raise HTTPException(
            status_code=400, detail=f"Job not ready: {job.status}"
        )
    return Response(content=job.audio_data, media_type="audio/mpeg")


@router.get("/tts/audio/{job_id}/{chunk_index}")
async def get_tts_chunk_audio(job_id: str, chunk_index: int) -> Response:
    """Download audio for a single completed chunk."""
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    audio = job.chunk_audio.get(chunk_index)
    if audio is None:
        raise HTTPException(
            status_code=503, detail=f"Chunk {chunk_index} not ready"
        )
    return Response(content=audio, media_type="audio/mpeg")
