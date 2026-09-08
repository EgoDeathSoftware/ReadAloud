# Session Chunk Cache for Stop/Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Avoid resynthesizing TTS audio for chunks already spoken this browser session, for both the `backend` and `direct`/openai extension adapters — most importantly the `backend` adapter, where reuse requires the server to skip its own TTS call.

**Architecture:** An in-memory, session-scoped `Map` cache (keyed by voice + SHA-256 of chunk text) lives in the extension's background page. For the `direct` adapter, which already chunks client-side, this is a direct check-before-request. For the `backend` adapter, the extension additionally pre-chunks the text locally (mirroring the server's chunker) to compute candidate hashes, uploads any cached audio it already holds for those hashes alongside the generate request, and the server substitutes that audio instead of calling the TTS backend whenever its own authoritative chunk hash matches one supplied by the client. Matching is always by hash, never by index, so any drift between client- and server-computed chunk boundaries only costs a cache miss on the affected chunk — never misaligned audio.

**Tech Stack:** Python/FastAPI (backend), vanilla JS WebExtension (extension), pytest (backend tests), vitest (extension tests).

**Spec:** `docs/superpowers/specs/2026-09-03-chunk-cache-resume-design.md`

## Global Constraints

- Cache is session-only (in-memory `Map`), not persisted — nothing survives a background-page restart.
- Cache granularity is whole chunks, never sub-chunk offsets.
- Hash algorithm is SHA-256, hex-encoded, of the UTF-8 chunk text — must produce byte-identical output between the extension (`crypto.subtle.digest`) and the backend (`hashlib.sha256`).
- Default cache byte budget: 50MB, LRU-evicted.
- `known_chunks` request field is capped at 500 entries; over that, the backend responds 413.
- All new backend response/request fields are additive with safe defaults — the web frontend, which never sends `known_chunks`, must be unaffected.
- Wire format uses snake_case field names (`known_chunks`, `audio_b64`, `chunks_completed`, etc.), matching the existing API convention; JS-internal variables stay camelCase and translate at the adapter boundary, matching the existing `chunksCompleted`/`chunks_completed` pattern in `backend.js`.

---

## Task 1: Backend — expose `max_chunk_chars` in `/api/settings`

**Files:**
- Modify: `backend/src/readaloud/models/schemas.py` (`SettingsResponse`)
- Modify: `backend/src/readaloud/routes/settings.py`
- Modify: `backend/tests/test_routes.py:116-119` (`test_settings_get_returns_config`)

**Interfaces:**
- Produces: `SettingsResponse.max_chunk_chars: int`, returned by `GET /api/settings`. The extension will fetch this in Task 9 so its local chunking matches the server's `MAX_CHUNK_CHARS`.

- [ ] **Step 1: Update the existing settings test to expect the new field**

In `backend/tests/test_routes.py`, change `test_settings_get_returns_config`:

```python
def test_settings_get_returns_config(client):
    response = client.get("/api/settings")
    assert response.status_code == 200
    assert set(response.json()) == {
        "tts_base_url",
        "tts_model",
        "tts_default_voice",
        "max_chunk_chars",
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && uv run pytest tests/test_routes.py::test_settings_get_returns_config -v`
Expected: FAIL — actual response set is missing `max_chunk_chars`.

- [ ] **Step 3: Add the field to `SettingsResponse`**

In `backend/src/readaloud/models/schemas.py`, change:

```python
class SettingsResponse(BaseModel):
    tts_base_url: str
    tts_model: str
    tts_default_voice: str
```

to:

```python
class SettingsResponse(BaseModel):
    tts_base_url: str
    tts_model: str
    tts_default_voice: str
    max_chunk_chars: int
```

- [ ] **Step 4: Populate it in the route**

In `backend/src/readaloud/routes/settings.py`, change the return statement to:

```python
    return SettingsResponse(
        tts_base_url=settings.TTS_BASE_URL,
        tts_model=settings.TTS_MODEL,
        tts_default_voice=settings.TTS_DEFAULT_VOICE,
        max_chunk_chars=settings.MAX_CHUNK_CHARS,
    )
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd backend && uv run pytest tests/test_routes.py::test_settings_get_returns_config tests/test_routes.py::test_settings_get_never_leaks_api_key -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add backend/src/readaloud/models/schemas.py backend/src/readaloud/routes/settings.py backend/tests/test_routes.py
git commit -m "Expose max_chunk_chars in /api/settings"
```

---

## Task 2: Backend — add `KnownChunk`/`ChunkStatus` schemas

**Files:**
- Modify: `backend/src/readaloud/models/schemas.py`
- Test: `backend/tests/test_schemas.py` (new)

**Interfaces:**
- Produces: `KnownChunk(hash: str, audio_b64: str)`, `ChunkStatus(index: int, hash: str, source: Literal["synthesized", "client_cache"])`, `TtsGenerateRequest.known_chunks: list[KnownChunk] = []`, `TtsStatusResponse.chunks: list[ChunkStatus] = []`. Task 3 and Task 4 consume these.

- [ ] **Step 1: Write a failing test for the new request/response shapes**

Create `backend/tests/test_schemas.py`:

```python
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && uv run pytest tests/test_schemas.py -v`
Expected: FAIL with `ImportError: cannot import name 'KnownChunk'`

- [ ] **Step 3: Add the schemas**

In `backend/src/readaloud/models/schemas.py`, add `Literal` to the imports and add the new models. The file becomes:

```python
from typing import Literal

from pydantic import BaseModel, Field


class KnownChunk(BaseModel):
    hash: str
    audio_b64: str


class TtsGenerateRequest(BaseModel):
    text: str
    voice: str | None = None
    model: str | None = None
    speed: float = 1.0
    known_chunks: list[KnownChunk] = Field(default_factory=list)


class TtsGenerateResponse(BaseModel):
    job_id: str
    status: str
    audio_url: str | None = None


class ChunkStatus(BaseModel):
    index: int
    hash: str
    source: Literal["synthesized", "client_cache"]


class TtsStatusResponse(BaseModel):
    job_id: str
    status: str
    progress: float = Field(default=0.0, ge=0.0, le=1.0)
    chunks_completed: int = 0
    chunks_total: int = 0
    error: str | None = None
    chunks: list[ChunkStatus] = Field(default_factory=list)


class ExtractRequest(BaseModel):
    url: str


class ExtractResponse(BaseModel):
    title: str | None = None
    text: str
    word_count: int


class VoiceInfo(BaseModel):
    id: str
    name: str | None = None


class SettingsResponse(BaseModel):
    tts_base_url: str
    tts_model: str
    tts_default_voice: str
    max_chunk_chars: int
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && uv run pytest tests/test_schemas.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/readaloud/models/schemas.py backend/tests/test_schemas.py
git commit -m "Add KnownChunk and ChunkStatus schemas"
```

---

## Task 3: Backend — `_process_long_text` skips synthesis for known chunk hashes

**Files:**
- Modify: `backend/src/readaloud/routes/tts.py`
- Modify: `backend/tests/test_routes.py`

**Interfaces:**
- Consumes: `ChunkStatus` from `readaloud.models.schemas` (Task 2).
- Produces: `_process_long_text(job_id, chunks, voice, model, speed, known_by_hash=None)` — new optional 6th param, `dict[str, bytes]`. `JobState.chunks: list[ChunkStatus]`. Task 4 builds `known_by_hash` from the request and passes it through.

- [ ] **Step 1: Write a failing test**

Add to `backend/tests/test_routes.py` (near `test_long_text_streams_chunks_and_keeps_them_readable`):

```python
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && uv run pytest tests/test_routes.py::test_known_chunk_hash_skips_synthesis -v`
Expected: FAIL — `_process_long_text() takes 5 positional arguments but 6 were given` (or `AttributeError: 'JobState' object has no attribute 'chunks'`).

- [ ] **Step 3: Implement**

In `backend/src/readaloud/routes/tts.py`, add imports and update `JobState` and `_process_long_text`:

```python
import hashlib
```
(add alongside the existing `import asyncio`, `import time`, `import uuid`, `from dataclasses import dataclass, field`)

```python
from readaloud.models.schemas import (
    ChunkStatus,
    TtsGenerateRequest,
    TtsGenerateResponse,
    TtsStatusResponse,
)
```

```python
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
```

```python
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
    calling the TTS server — the client already has this audio from a prior
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
        job.status = "complete"
    except Exception as exc:
        job.status = "failed"
        job.error = str(exc)
    finally:
        await client.close()
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_routes.py -v`
Expected: PASS (all tests, including the pre-existing ones — `test_job_state_holds_no_audio_bytes` must still pass since `ChunkStatus` entries hold no bytes).

- [ ] **Step 5: Commit**

```bash
git add backend/src/readaloud/routes/tts.py backend/tests/test_routes.py
git commit -m "Skip TTS synthesis for chunks the client already has"
```

---

## Task 4: Backend — wire `known_chunks` through the route, cap payload size, report `chunks` in status

**Files:**
- Modify: `backend/src/readaloud/routes/tts.py`
- Modify: `backend/tests/test_routes.py`

**Interfaces:**
- Consumes: `_process_long_text(..., known_by_hash)` (Task 3), `TtsGenerateRequest.known_chunks`, `ChunkStatus` (Task 2).
- Produces: `POST /api/tts/generate` accepts `known_chunks`, rejects payloads over 500 entries with 413. `GET /api/tts/status/{job_id}` returns `chunks`.

- [ ] **Step 1: Write failing tests**

Add to `backend/tests/test_routes.py`:

```python
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
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd backend && uv run pytest tests/test_routes.py::test_tts_generate_known_chunk_skips_synthesis_end_to_end tests/test_routes.py::test_tts_generate_drops_malformed_known_chunk_audio tests/test_routes.py::test_tts_generate_rejects_too_many_known_chunks -v`
Expected: FAIL — `known_chunks` is accepted but ignored (synthesis count and `413` assertions fail); `status["chunks"]` is `[]`.

- [ ] **Step 3: Implement**

In `backend/src/readaloud/routes/tts.py`, add near the top (after the existing constants):

```python
import base64
import logging

logger = logging.getLogger(__name__)

MAX_KNOWN_CHUNKS = 500
```

Add a decode helper above `generate_tts`:

```python
def _decode_known_chunks(known_chunks: list) -> dict[str, bytes]:
    """Decode client-supplied cached chunk audio, dropping unreadable entries.

    A malformed entry must never fail the whole request — it just means that
    one chunk gets resynthesized instead of reused.
    """
    decoded: dict[str, bytes] = {}
    for entry in known_chunks:
        try:
            decoded[entry.hash] = base64.b64decode(entry.audio_b64, validate=True)
        except ValueError:
            logger.warning("Dropping known_chunk with unreadable audio_b64 (hash=%s)", entry.hash)
    return decoded
```

Update `generate_tts`:

```python
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
        jobs[job_id] = JobState(
            id=job_id,
            status="complete",
            progress=1.0,
            chunks_completed=1,
            chunks_total=1,
        )
        return TtsGenerateResponse(
            job_id=job_id,
            status="complete",
            audio_url=f"/api/tts/audio/{job_id}",
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
```

Update `get_tts_status` to return the new field:

```python
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
    )
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && uv run pytest tests/ -v`
Expected: PASS (full backend suite, including all pre-existing tests).

- [ ] **Step 5: Lint and type-check**

Run: `cd backend && uv run ruff check src/ && uv run ruff format --check src/`
Expected: no errors. Fix any reported issues before continuing.

- [ ] **Step 6: Commit**

```bash
git add backend/src/readaloud/routes/tts.py backend/tests/test_routes.py
git commit -m "Accept known_chunks on /api/tts/generate and report chunk source in status"
```

---

## Task 5: Extension — session chunk cache and hashing primitives

**Files:**
- Create: `extension/lib/chunk-cache.js`
- Create: `extension/lib/chunk-cache.test.js`
- Create: `extension/lib/hash.js`
- Create: `extension/lib/hash.test.js`

**Interfaces:**
- Produces: `createChunkCache({maxBytes?}) -> {get(voice, hash), set(voice, hash, blob), clear(), size}`, a shared singleton `chunkCache` (same shape). `sha256Hex(text) -> Promise<string>`. Tasks 7, 8, and 9 consume both.

- [ ] **Step 1: Write the failing cache tests**

Create `extension/lib/chunk-cache.test.js`:

```js
import { beforeEach, describe, expect, it } from "vitest";

import { createChunkCache } from "./chunk-cache.js";

function blob(bytes) {
  return new Blob([new Uint8Array(bytes)], { type: "audio/mpeg" });
}

describe("createChunkCache", () => {
  it("returns null for a miss", () => {
    const cache = createChunkCache();
    expect(cache.get("af_heart", "hash-1")).toBeNull();
  });

  it("returns what was set for the same voice and hash", () => {
    const cache = createChunkCache();
    const b = blob(10);
    cache.set("af_heart", "hash-1", b);
    expect(cache.get("af_heart", "hash-1")).toBe(b);
  });

  it("keeps entries separate per voice for the same hash", () => {
    const cache = createChunkCache();
    const a = blob(10);
    const b = blob(10);
    cache.set("af_heart", "hash-1", a);
    cache.set("am_adam", "hash-1", b);
    expect(cache.get("af_heart", "hash-1")).toBe(a);
    expect(cache.get("am_adam", "hash-1")).toBe(b);
  });

  it("evicts the oldest entry once the byte budget is exceeded", () => {
    const cache = createChunkCache({ maxBytes: 15 });
    cache.set("af_heart", "hash-1", blob(10));
    cache.set("af_heart", "hash-2", blob(10));
    expect(cache.get("af_heart", "hash-1")).toBeNull();
    expect(cache.get("af_heart", "hash-2")).not.toBeNull();
  });

  it("refreshes an entry's recency on get, protecting it from eviction", () => {
    const cache = createChunkCache({ maxBytes: 15 });
    cache.set("af_heart", "hash-1", blob(10));
    cache.get("af_heart", "hash-1");
    cache.set("af_heart", "hash-2", blob(10));
    expect(cache.get("af_heart", "hash-1")).not.toBeNull();
    expect(cache.get("af_heart", "hash-2")).toBeNull();
  });

  it("clear() empties the cache", () => {
    const cache = createChunkCache();
    cache.set("af_heart", "hash-1", blob(10));
    cache.clear();
    expect(cache.get("af_heart", "hash-1")).toBeNull();
    expect(cache.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd extension && npx vitest run lib/chunk-cache.test.js`
Expected: FAIL — `Cannot find module './chunk-cache.js'`

- [ ] **Step 3: Implement `chunk-cache.js`**

Create `extension/lib/chunk-cache.js`:

```js
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Session-scoped LRU cache of synthesized chunk audio, keyed by (voice, chunk
 * hash). Lives only as long as the background page does -- no persistence.
 */
export function createChunkCache({ maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const store = new Map();
  let totalBytes = 0;

  function key(voice, hash) {
    return `${voice} ${hash}`;
  }

  function evict(bytesNeeded) {
    while (totalBytes + bytesNeeded > maxBytes && store.size > 0) {
      const oldestKey = store.keys().next().value;
      totalBytes -= store.get(oldestKey).bytes;
      store.delete(oldestKey);
    }
  }

  return {
    get(voice, hash) {
      const k = key(voice, hash);
      const entry = store.get(k);
      if (!entry) return null;
      store.delete(k);
      store.set(k, entry);
      return entry.blob;
    },

    set(voice, hash, blob) {
      const k = key(voice, hash);
      const existing = store.get(k);
      if (existing) {
        totalBytes -= existing.bytes;
        store.delete(k);
      }
      evict(blob.size);
      store.set(k, { blob, bytes: blob.size });
      totalBytes += blob.size;
    },

    clear() {
      store.clear();
      totalBytes = 0;
    },

    get size() {
      return store.size;
    },
  };
}

/** Shared cache instance used by the adapters and background.js. */
export const chunkCache = createChunkCache();
```

- [ ] **Step 4: Run the cache tests to verify they pass**

Run: `cd extension && npx vitest run lib/chunk-cache.test.js`
Expected: PASS

- [ ] **Step 5: Write the failing hash test**

Create `extension/lib/hash.test.js`:

```js
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { sha256Hex } from "./hash.js";

describe("sha256Hex", () => {
  it("matches Node's own SHA-256 for arbitrary text", async () => {
    const text = "The quick brown fox jumps over the lazy dog";
    const expected = createHash("sha256").update(text, "utf8").digest("hex");
    await expect(sha256Hex(text)).resolves.toBe(expected);
  });

  it("matches for empty text", async () => {
    const expected = createHash("sha256").update("", "utf8").digest("hex");
    await expect(sha256Hex("")).resolves.toBe(expected);
  });

  it("matches for non-ASCII text", async () => {
    const text = "Héllo wörld — café";
    const expected = createHash("sha256").update(text, "utf8").digest("hex");
    await expect(sha256Hex(text)).resolves.toBe(expected);
  });

  it("produces different hashes for different text", async () => {
    await expect(sha256Hex("a")).resolves.not.toBe(await sha256Hex("b"));
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd extension && npx vitest run lib/hash.test.js`
Expected: FAIL — `Cannot find module './hash.js'`

- [ ] **Step 7: Implement `hash.js`**

Create `extension/lib/hash.js`:

```js
/**
 * SHA-256 hex digest of UTF-8 text, matching the backend's
 * hashlib.sha256(text.encode("utf-8")).hexdigest() byte-for-byte.
 */
export async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
```

- [ ] **Step 8: Run both test files to verify they pass**

Run: `cd extension && npx vitest run lib/chunk-cache.test.js lib/hash.test.js`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add extension/lib/chunk-cache.js extension/lib/chunk-cache.test.js extension/lib/hash.js extension/lib/hash.test.js
git commit -m "Add session chunk cache and SHA-256 hashing helper"
```

---

## Task 6: Extension — `direct`/openai adapter uses the chunk cache

**Files:**
- Modify: `extension/lib/adapters/openai.js`
- Modify: `extension/lib/adapters/openai.test.js`

**Interfaces:**
- Consumes: `chunkCache` from `chunk-cache.js`, `sha256Hex` from `hash.js` (Task 5).

- [ ] **Step 1: Write failing tests**

Add to `extension/lib/adapters/openai.test.js`, inside `describe("synthesize", ...)`. First add the import at the top of the file:

```js
import { chunkCache } from "../chunk-cache.js";
```

Add a `beforeEach` (alongside the existing one) to reset the shared cache between tests:

```js
beforeEach(() => {
  vi.restoreAllMocks();
  chunkCache.clear();
});
```

Add the new tests:

```js
  it("does not re-request a chunk already in the cache", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return blobResponse("audio");
    });

    await collect(synth());
    expect(calls).toBe(1);

    await collect(synth());
    expect(calls).toBe(1);
  });

  it("caches per voice, so a different voice still requests", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return blobResponse("audio");
    });

    await collect(synth({ voice: "af_heart" }));
    await collect(synth({ voice: "am_adam" }));
    expect(calls).toBe(2);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd extension && npx vitest run lib/adapters/openai.test.js`
Expected: FAIL — the two new tests see `calls === 2` on the second `synth()` call (no caching yet).

- [ ] **Step 3: Implement**

In `extension/lib/adapters/openai.js`, add imports at the top:

```js
import { chunkCache } from "/lib/chunk-cache.js";
import { sha256Hex } from "/lib/hash.js";
```

Change the `synthesize` generator:

```js
  async *synthesize({ text, voice, settings, signal, onProgress }) {
    const chunks = chunkText(text, MAX_INPUT_CHARS);
    const total = chunks.length;
    onProgress({ chunksCompleted: 0, chunksTotal: total, progress: 0 });

    for (let index = 0; index < total; index++) {
      const hash = await sha256Hex(chunks[index]);
      let audio = chunkCache.get(voice, hash);
      if (!audio) {
        audio = await requestChunk(chunks[index], voice, settings, signal);
        chunkCache.set(voice, hash, audio);
      }
      onProgress({
        chunksCompleted: index + 1,
        chunksTotal: total,
        progress: (index + 1) / total,
      });
      yield { audio, index, total };
    }
  },
```

- [ ] **Step 4: Run the full openai adapter test file to verify everything passes**

Run: `cd extension && npx vitest run lib/adapters/openai.test.js`
Expected: PASS (new tests and all pre-existing ones — the cache is empty at the start of every test via the new `beforeEach`, so retry/error-path tests that call `fetch` once per attempt are unaffected).

- [ ] **Step 5: Commit**

```bash
git add extension/lib/adapters/openai.js extension/lib/adapters/openai.test.js
git commit -m "Cache synthesized chunk audio in the direct/openai adapter"
```

---

## Task 7: Extension — `backend` adapter accepts `knownChunks` and consumes cached chunks from job status

**Files:**
- Modify: `extension/lib/adapters/backend.js`
- Modify: `extension/lib/adapters/backend.test.js`

**Interfaces:**
- Consumes: `chunkCache` from `chunk-cache.js` (Task 5).
- Produces: `backendAdapter.synthesize({..., knownChunks = []})` — `knownChunks: {hash: string, audioB64: string}[]`, translated to `{hash, audio_b64}` on the wire. Task 9 (background.js) builds and passes this array.

- [ ] **Step 1: Write failing tests**

Add to `extension/lib/adapters/backend.test.js`. Add the import at the top:

```js
import { chunkCache } from "../chunk-cache.js";
```

Add a `beforeEach` alongside the existing one:

```js
beforeEach(() => {
  vi.restoreAllMocks();
  chunkCache.clear();
});
```

Add these tests inside `describe("synthesize", ...)`:

```js
  it("sends known_chunks in the generate request body", async () => {
    let sentBody = null;
    globalThis.fetch = vi.fn(async (url, options) => {
      if (url.endsWith("/api/tts/generate")) {
        sentBody = JSON.parse(options.body);
        return jsonResponse({ job_id: "j5", status: "complete" });
      }
      return blobResponse();
    });

    await run({ knownChunks: [{ hash: "abc123", audioB64: "ZmFrZQ==" }] });
    expect(sentBody.known_chunks).toEqual([{ hash: "abc123", audio_b64: "ZmFrZQ==" }]);
  });

  it("omits known_chunks from the body when there are none", async () => {
    let sentBody = null;
    globalThis.fetch = vi.fn(async (url, options) => {
      if (url.endsWith("/api/tts/generate")) {
        sentBody = JSON.parse(options.body);
        return jsonResponse({ job_id: "j6", status: "complete" });
      }
      return blobResponse();
    });

    await run();
    expect(sentBody.known_chunks).toBeUndefined();
  });

  it("plays a client_cache-sourced chunk from the local cache without fetching its audio", async () => {
    const cachedBlob = new Blob(["cached"], { type: "audio/mpeg" });
    chunkCache.set("af_heart", "hash-a", cachedBlob);

    const fetchedAudioUrls = [];
    globalThis.fetch = vi.fn(async (url) => {
      fetchedAudioUrls.push(url);
      if (url.endsWith("/api/tts/generate")) {
        return jsonResponse({ job_id: "j7", status: "processing" });
      }
      if (url.includes("/api/tts/status/")) {
        return jsonResponse({
          status: "complete",
          progress: 1,
          chunks_completed: 1,
          chunks_total: 1,
          chunks: [{ index: 0, hash: "hash-a", source: "client_cache" }],
        });
      }
      return blobResponse();
    });

    const results = await run({ voice: "af_heart" });
    expect(results[0].audio).toBe(cachedBlob);
    expect(fetchedAudioUrls.some((u) => u.includes("/api/tts/audio/"))).toBe(false);
  });

  it("fetches and caches a synthesized chunk under its reported hash", async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (url.endsWith("/api/tts/generate")) {
        return jsonResponse({ job_id: "j8", status: "processing" });
      }
      if (url.includes("/api/tts/status/")) {
        return jsonResponse({
          status: "complete",
          progress: 1,
          chunks_completed: 1,
          chunks_total: 1,
          chunks: [{ index: 0, hash: "hash-b", source: "synthesized" }],
        });
      }
      return blobResponse();
    });

    await run({ voice: "af_heart" });
    expect(chunkCache.get("af_heart", "hash-b")).not.toBeNull();
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd extension && npx vitest run lib/adapters/backend.test.js`
Expected: FAIL — `known_chunks` is never sent; `client_cache`-sourced chunks still hit `/api/tts/audio/...`; nothing is written into `chunkCache`.

- [ ] **Step 3: Implement**

In `extension/lib/adapters/backend.js`, add the import at the top:

```js
import { chunkCache } from "/lib/chunk-cache.js";
```

Replace the `synthesize` generator:

```js
  async *synthesize({ text, voice, settings, signal, onProgress, knownChunks = [] }) {
    const body = { text: text.trim() };
    if (voice) body.voice = voice;
    if (knownChunks.length > 0) {
      body.known_chunks = knownChunks.map(({ hash, audioB64 }) => ({
        hash,
        audio_b64: audioB64,
      }));
    }

    const job = await backendJson(settings, "/api/tts/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });

    if (job.status === "complete") {
      onProgress({ chunksCompleted: 1, chunksTotal: 1, progress: 1 });
      yield {
        audio: await fetchAudio(settings, `/api/tts/audio/${job.job_id}`, signal),
        index: 0,
        total: 1,
      };
      return;
    }

    let nextChunk = 0;
    for (;;) {
      const status = await backendJson(settings, `/api/tts/status/${job.job_id}`, { signal });
      onProgress({
        chunksCompleted: status.chunks_completed,
        chunksTotal: status.chunks_total,
        progress: status.progress,
      });

      if (status.status === "failed") {
        throw new Error(status.error || "TTS generation failed");
      }

      while (nextChunk < status.chunks_completed) {
        const info = status.chunks?.find((c) => c.index === nextChunk);
        const cached = info ? chunkCache.get(voice, info.hash) : null;
        let audio;
        if (info?.source === "client_cache" && cached) {
          audio = cached;
        } else {
          audio = await fetchAudio(settings, `/api/tts/audio/${job.job_id}/${nextChunk}`, signal);
          if (info) chunkCache.set(voice, info.hash, audio);
        }
        yield { audio, index: nextChunk, total: status.chunks_total };
        nextChunk += 1;
      }

      if (status.status === "complete" && nextChunk >= status.chunks_total) return;
      await sleep(POLL_INTERVAL_MS, signal);
    }
  },
```

- [ ] **Step 4: Run the full backend adapter test file to verify everything passes**

Run: `cd extension && npx vitest run lib/adapters/backend.test.js`
Expected: PASS (new tests and all pre-existing ones — pre-existing status fixtures have no `chunks` field, so `status.chunks?.find(...)` is `undefined`, `info` is `undefined`, and the loop falls through to the original fetch-every-time behavior unchanged).

- [ ] **Step 5: Commit**

```bash
git add extension/lib/adapters/backend.js extension/lib/adapters/backend.test.js
git commit -m "Accept known_chunks and consume cached chunks in the backend adapter"
```

---

## Task 8: Extension — `background.js` builds `knownChunks` before reading

**Files:**
- Modify: `extension/background.js`

**Interfaces:**
- Consumes: `backendAdapter` (identity check), `chunkText` from `chunker.js`, `chunkCache` from `chunk-cache.js`, `sha256Hex` from `hash.js` (Task 5), `backendAdapter.synthesize({..., knownChunks})` (Task 7).
- No new exports — `background.js` is orchestration, not imported elsewhere. No dedicated test file: the existing codebase has no `background.test.js` (it is wired directly to `browser.*` APIs), so this task is verified manually — see Step 5.

- [ ] **Step 1: Add the new imports**

In `extension/background.js`, change the top imports:

```js
import { pickAdapter } from "/lib/adapters/index.js";
import { backendAdapter } from "/lib/adapters/backend.js";
import { chunkCache } from "/lib/chunk-cache.js";
import { chunkText } from "/lib/chunker.js";
import { createPlayer } from "/lib/player.js";
import { sha256Hex } from "/lib/hash.js";
import { loadSettings } from "/lib/settings.js";
import { isPdfTab, resolvePdfSourceUrl } from "/lib/pdf.js";
import { sliceFromArticle } from "/lib/read-from-here.js";
```

- [ ] **Step 2: Add `buildKnownChunks`**

Add this function above `handleReadRequest` in `extension/background.js`:

```js
function blobToBase64(blob) {
  return blob.arrayBuffer().then((buffer) => {
    let binary = "";
    for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
    return btoa(binary);
  });
}

/**
 * Chunk `text` the same way the backend will, and offer back the audio for any
 * chunk already cached this session -- lets the server skip resynthesizing it.
 * Best-effort: any failure (unreachable backend, aborted read) just means no
 * chunks are offered, falling back to full synthesis.
 */
async function buildKnownChunks(text, voice, settings, signal) {
  try {
    const response = await fetch(`${settings.backendUrl}/api/settings`, { signal });
    if (!response.ok) return [];
    const { max_chunk_chars: maxChunkChars } = await response.json();

    const knownChunks = [];
    for (const chunk of chunkText(text, maxChunkChars)) {
      const hash = await sha256Hex(chunk);
      const blob = chunkCache.get(voice, hash);
      if (blob) knownChunks.push({ hash, audioB64: await blobToBase64(blob) });
    }
    return knownChunks;
  } catch {
    return [];
  }
}
```

- [ ] **Step 3: Use it in `handleReadRequest`**

Change `handleReadRequest`:

```js
async function handleReadRequest(text, voice, speed) {
  stopAll();

  if (!text || text.trim().length === 0) {
    setError("No text to read");
    return;
  }

  const settings = await loadSettings();
  const adapter = pickAdapter(settings);
  const resolvedVoice = voice || settings.defaultVoice;
  abortController = new AbortController();

  player.setSpeed(speed || settings.defaultSpeed);
  setPhase("generating");

  const knownChunks =
    adapter === backendAdapter
      ? await buildKnownChunks(text, resolvedVoice, settings, abortController.signal)
      : [];

  const generator = adapter.synthesize({
    text,
    voice: resolvedVoice,
    settings,
    signal: abortController.signal,
    knownChunks,
    onProgress: ({ chunksCompleted, chunksTotal, progress }) => {
      state.chunksCompleted = chunksCompleted;
      state.chunksTotal = chunksTotal;
      state.progress = progress;
      if (state.phase === "generating" || state.phase === "playing") broadcastState();
    },
  });

  try {
    setPhase("playing");
    await player.play(generator);
    if (state.phase !== "error") {
      resetState();
      broadcastState();
    }
  } catch (err) {
    if (err.name === "AbortError") return;
    setError(err.message);
  } finally {
    abortController = null;
  }
}
```

- [ ] **Step 4: Run the full extension test suite to verify nothing else broke**

Run: `cd extension && npm test`
Expected: PASS — `background.js` has no dedicated test file, but this confirms the modules it imports (`chunk-cache.js`, `hash.js`, both adapters) still pass all their own tests.

- [ ] **Step 5: Manually verify in Firefox**

1. Load the extension via `about:debugging` → "This Firefox" → "Load Temporary Add-on" → `extension/manifest.json`.
2. Set `ttsTarget` to `backend` in the extension's settings popup, pointed at a running local backend (`cd backend && uv run uvicorn readaloud.main:app --port 8000`) with a reachable TTS server.
3. Open a long article, click "Read Page," let it play for 15-20 seconds, then click Stop.
4. Watch the backend's terminal output (or add a temporary `print` in `TtsClient.generate_speech`) and click "Read Page" again on the same article.
5. Confirm the chunks already spoken are **not** resent to the TTS server — only chunks at/after the stop point trigger a new `generate_speech` call.
6. Select a later paragraph and use "Read From Here" — confirm chunks overlapping what was already read in step 3 also skip synthesis.

- [ ] **Step 6: Commit**

```bash
git add extension/background.js
git commit -m "Offer cached chunk audio to the backend before reading"
```

---

## Self-Review Notes

- **Spec coverage:** `max_chunk_chars` exposure (Task 1), `KnownChunk`/`ChunkStatus` schemas (Task 2), server-side skip-on-hash-match (Task 3), request wiring + size cap + status reporting (Task 4), client-side cache primitives (Task 5), `direct` adapter caching (Task 6), `backend` adapter caching (Task 7), `background.js` orchestration (Task 8) — every component in the spec has a task. Non-goals (persistence, sub-chunk offsets, web frontend changes, server-side cross-user cache) are deliberately not implemented anywhere in this plan.
- **Type consistency checked:** `knownChunks` (camelCase, `{hash, audioB64}`) is used consistently in `background.js` (Task 8) and `backend.js` (Task 7); the wire translation to `{hash, audio_b64}` happens only inside `backend.js`, matching the existing `chunksCompleted`/`chunks_completed` boundary pattern. `ChunkStatus.source` values (`"synthesized"` / `"client_cache"`) match between Task 2's schema, Task 3's `_process_long_text`, and Task 7's adapter check. `chunkCache`'s `get`/`set`/`clear` signature is identical everywhere it's consumed (Tasks 6, 7, 8).
- **No placeholders:** every step has runnable code and exact commands.
