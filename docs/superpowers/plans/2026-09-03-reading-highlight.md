# Reading Position Highlight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Highlight the sentence currently being read, synced to audio playback, in the ReadAloud web frontend.

**Architecture:** The backend measures each TTS chunk's real audio duration from its MP3 frames, splits that duration across the chunk's sentences by character-count proportion, and returns the resulting `{text, start, end}` cues alongside the generation/status responses. The frontend tracks `audio.currentTime` against those cues with a `requestAnimationFrame` loop, and swaps the editable textarea for a read-only, auto-scrolling, highlighted rendering of the cues while audio plays.

**Tech Stack:** FastAPI + Pydantic (backend), React + TypeScript (frontend). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-03-reading-highlight-design.md`

## Global Constraints

- Web frontend (`frontend/`) only — the Firefox extension's playback path is not touched.
- No TTS-server-specific timestamp APIs — cue timing is derived only from audio the server already returns, so it works with any OpenAI-compatible server.
- No new frontend test tooling — the frontend has no test runner today; this feature is verified manually in the browser (final task below). Backend changes get pytest coverage as usual.
- Sentences never cross chunk boundaries, including the oversized-sentence-split-across-chunks edge case in `text_chunker._split_long_sentence`.
- Cue `start`/`end` are in the stitched audio's own timeline (seconds), unaffected by the frontend's `playbackRate` control.

---

### Task 1: Extract `split_sentences` from the chunker

**Files:**
- Modify: `backend/src/readaloud/services/text_chunker.py`
- Test: `backend/tests/test_text_chunker.py`

**Interfaces:**
- Produces: `split_sentences(text: str) -> list[str]` — splits on `.`/`!`/`?` followed by whitespace. Used by Task 3's cue computation.

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_text_chunker.py`:

```python
from readaloud.services.text_chunker import chunk_text, split_sentences


def test_split_sentences_splits_on_terminal_punctuation():
    result = split_sentences("First sentence. Second sentence! Third sentence?")
    assert result == ["First sentence.", "Second sentence!", "Third sentence?"]


def test_split_sentences_single_sentence_returns_itself():
    assert split_sentences("Only one sentence here.") == ["Only one sentence here."]


def test_split_sentences_no_terminal_punctuation_returns_whole_text():
    assert split_sentences("no punctuation at all") == ["no punctuation at all"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/test_text_chunker.py -k split_sentences -v`
Expected: FAIL with `ImportError: cannot import name 'split_sentences'`

- [ ] **Step 3: Extract the function**

In `backend/src/readaloud/services/text_chunker.py`, add a new top-level function and use it from `_split_long_paragraph`:

```python
def split_sentences(text: str) -> list[str]:
    """Split text into sentences on `.`, `!`, or `?` followed by whitespace.

    Doesn't special-case abbreviations (e.g. "Mr.") -- this is the same
    regex `_split_long_paragraph` has always used, just shared with the
    reading-cue computation in `reading_cues.py`.
    """
    return re.split(r"(?<=[.!?])\s+", text)
```

Change `_split_long_paragraph` to call it:

```python
def _split_long_paragraph(text: str, max_chars: int) -> list[str]:
    """Split a paragraph that exceeds max_chars on sentence boundaries."""
    sentences = split_sentences(text)
    chunks: list[str] = []
    current = ""
    ...  # rest unchanged
```

(Only the first line of the function body changes — the loop below it stays as-is.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_text_chunker.py -v`
Expected: PASS, all tests including the pre-existing ones

- [ ] **Step 5: Commit**

```bash
git add backend/src/readaloud/services/text_chunker.py backend/tests/test_text_chunker.py
git commit -m "Extract split_sentences from the text chunker"
```

---

### Task 2: Add `frame_duration_seconds` to the MP3 frame parser

**Files:**
- Modify: `backend/src/readaloud/services/mp3_frames.py`
- Test: `backend/tests/test_mp3_frames.py`

**Interfaces:**
- Consumes: `FrameHeader` (existing, has `samples_per_frame: int`, `sample_rate: int`)
- Produces: `frame_duration_seconds(frames: list[tuple[FrameHeader, bytes]]) -> float`. Used by Task 4's cue wiring.

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_mp3_frames.py`:

```python
from readaloud.services.mp3_frames import (
    build_xing_header_frame,
    frame_duration_seconds,
    is_xing_or_info_header,
    parse_frame_header,
    real_audio_frames,
)


def test_frame_duration_seconds_sums_sample_counts():
    audio1 = build_frame(bitrate_index=1, samplerate_index=0, mode=0)  # 44100Hz, 1152 samples/frame
    audio2 = build_frame(bitrate_index=1, samplerate_index=0, mode=0)
    frames = real_audio_frames(audio1 + audio2)

    duration = frame_duration_seconds(frames)

    assert duration == (1152 / 44100) * 2


def test_frame_duration_seconds_empty_list_is_zero():
    assert frame_duration_seconds([]) == 0.0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/test_mp3_frames.py -k frame_duration_seconds -v`
Expected: FAIL with `ImportError: cannot import name 'frame_duration_seconds'`

- [ ] **Step 3: Implement it**

Add to `backend/src/readaloud/services/mp3_frames.py`, after `real_audio_frames`:

```python
def frame_duration_seconds(frames: list[tuple[FrameHeader, bytes]]) -> float:
    """Total playback duration of a sequence of real audio frames, in seconds."""
    return sum(header.samples_per_frame / header.sample_rate for header, _raw in frames)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_mp3_frames.py -v`
Expected: PASS, all tests including the pre-existing ones

- [ ] **Step 5: Commit**

```bash
git add backend/src/readaloud/services/mp3_frames.py backend/tests/test_mp3_frames.py
git commit -m "Add frame_duration_seconds to the MP3 frame parser"
```

---

### Task 3: Add the `Cue` model and `compute_cues`

**Files:**
- Modify: `backend/src/readaloud/models/schemas.py`
- Create: `backend/src/readaloud/services/reading_cues.py`
- Test: `backend/tests/test_reading_cues.py`

**Interfaces:**
- Consumes: `split_sentences` from Task 1 (`readaloud.services.text_chunker`)
- Produces:
  - `Cue(BaseModel)` with fields `text: str`, `start: float`, `end: float` (in `models/schemas.py`)
  - `compute_cues(chunk_texts: list[str], chunk_durations: list[float]) -> list[Cue]`
  Both consumed by Task 4 (route wiring) and Task 5 (frontend types mirror this shape).

- [ ] **Step 1: Add the `Cue` model**

In `backend/src/readaloud/models/schemas.py`, add near the other small models (e.g. after `ChunkStatus`):

```python
class Cue(BaseModel):
    text: str
    start: float
    end: float
```

- [ ] **Step 2: Write the failing tests**

Create `backend/tests/test_reading_cues.py`:

```python
import pytest

from readaloud.services.reading_cues import compute_cues


def test_single_chunk_single_sentence_spans_full_duration():
    cues = compute_cues(["One sentence."], [2.0])

    assert len(cues) == 1
    assert cues[0].text == "One sentence."
    assert cues[0].start == 0.0
    assert cues[0].end == 2.0


def test_single_chunk_splits_duration_by_character_count():
    # "Short." (6 chars) + "A much longer sentence here." (28 chars) = 34 chars
    cues = compute_cues(["Short. A much longer sentence here."], [3.4])

    assert [c.text for c in cues] == ["Short.", "A much longer sentence here."]
    assert cues[0].start == pytest.approx(0.0)
    assert cues[0].end == pytest.approx(3.4 * 6 / 34)
    assert cues[1].start == cues[0].end
    assert cues[1].end == pytest.approx(3.4)


def test_multiple_chunks_offset_by_cumulative_duration():
    cues = compute_cues(["First chunk.", "Second chunk."], [1.0, 2.0])

    assert cues[0].start == 0.0
    assert cues[0].end == 1.0
    assert cues[1].start == 1.0
    assert cues[1].end == 3.0


def test_oversized_sentence_split_across_chunks_yields_one_cue_per_piece():
    # Simulates text_chunker._split_long_sentence breaking one long sentence
    # into multiple TTS chunks -- each piece has no terminal punctuation of
    # its own, so it becomes exactly one cue, never merged across chunks.
    cues = compute_cues(["word word word", "word word done."], [1.0, 1.0])

    assert [c.text for c in cues] == ["word word word", "word word done."]
    assert cues[0].start == 0.0
    assert cues[0].end == 1.0
    assert cues[1].start == 1.0
    assert cues[1].end == 2.0


def test_empty_chunk_text_yields_no_cues():
    assert compute_cues([""], [1.0]) == []


def test_mismatched_lengths_raises():
    with pytest.raises(ValueError):
        compute_cues(["a", "b"], [1.0])
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_reading_cues.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'readaloud.services.reading_cues'`

- [ ] **Step 4: Implement `reading_cues.py`**

Create `backend/src/readaloud/services/reading_cues.py`:

```python
"""Sentence-level timing cues for synced reading highlights.

Cue times live in the stitched audio's own timeline, so they are
unaffected by playback-rate changes the frontend applies at playback time.
"""

from readaloud.models.schemas import Cue
from readaloud.services.text_chunker import split_sentences


def compute_cues(chunk_texts: list[str], chunk_durations: list[float]) -> list[Cue]:
    """Build sentence-level playback cues for a sequence of TTS chunks.

    Each chunk's real audio duration is split across its own sentences,
    proportional to sentence character length. Sentences never cross chunk
    boundaries, so a chunk produced by splitting an oversized sentence
    across multiple TTS calls (see `text_chunker._split_long_sentence`)
    yields one cue per chunk piece rather than trying to recombine them.

    Args:
        chunk_texts: Chunk text, in playback order -- the same list passed
            to the TTS server for synthesis.
        chunk_durations: Each chunk's real audio duration in seconds, same
            order and length as `chunk_texts`.

    Returns:
        Cues in playback order, with `start`/`end` in the stitched audio's
        timeline (seconds).

    Raises:
        ValueError: If `chunk_texts` and `chunk_durations` differ in length.
    """
    if len(chunk_texts) != len(chunk_durations):
        raise ValueError("chunk_texts and chunk_durations must be the same length")

    cues: list[Cue] = []
    offset = 0.0
    for text, duration in zip(chunk_texts, chunk_durations, strict=True):
        cues.extend(_cues_for_chunk(text, duration, offset))
        offset += duration
    return cues


def _cues_for_chunk(text: str, duration: float, offset: float) -> list[Cue]:
    sentences = [s for s in split_sentences(text) if s.strip()]
    total_chars = sum(len(s) for s in sentences)
    if not sentences or total_chars == 0:
        return []

    cues: list[Cue] = []
    start = offset
    for sentence in sentences:
        end = start + duration * (len(sentence) / total_chars)
        cues.append(Cue(text=sentence, start=start, end=end))
        start = end
    return cues
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_reading_cues.py -v`
Expected: PASS, all 6 tests

- [ ] **Step 6: Commit**

```bash
git add backend/src/readaloud/models/schemas.py backend/src/readaloud/services/reading_cues.py backend/tests/test_reading_cues.py
git commit -m "Add Cue model and sentence-level cue computation"
```

---

### Task 4: Wire cues into the TTS routes

**Files:**
- Modify: `backend/src/readaloud/models/schemas.py`
- Modify: `backend/src/readaloud/routes/tts.py`
- Test: `backend/tests/test_routes.py`

**Interfaces:**
- Consumes: `Cue`, `compute_cues` (Task 3); `real_audio_frames`, `frame_duration_seconds` (Task 2, existing import already present for `real_audio_frames` via `mp3_frames`)
- Produces: `TtsGenerateResponse.cues: list[Cue]`, `TtsStatusResponse.cues: list[Cue]`, `JobState.cues: list[Cue]`. Consumed by Task 5 (frontend types).

- [ ] **Step 1: Add `cues` to both response schemas**

In `backend/src/readaloud/models/schemas.py`, add `cues: list[Cue] = Field(default_factory=list)` to both `TtsGenerateResponse` and `TtsStatusResponse`:

```python
class TtsGenerateResponse(BaseModel):
    job_id: str
    status: str
    audio_url: str | None = None
    cues: list[Cue] = Field(default_factory=list)


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
    cues: list[Cue] = Field(default_factory=list)
```

(`Cue` must be defined above both of these in the file, per Task 3.)

- [ ] **Step 2: Write the failing tests**

Add to `backend/tests/test_routes.py`, near `test_tts_generate_short_text`:

```python
def test_tts_generate_short_text_includes_cues(client, temp_job_store):
    with patch("readaloud.routes.tts.TtsClient") as mock_cls:
        mock_client = MagicMock()
        mock_client.generate_speech = AsyncMock(return_value=b"mp3data")
        mock_client.close = AsyncMock()
        mock_cls.return_value = mock_client

        response = client.post(
            "/api/tts/generate",
            json={"text": "First sentence. Second sentence."},
        )

    data = response.json()
    assert [cue["text"] for cue in data["cues"]] == [
        "First sentence.",
        "Second sentence.",
    ]
```

And near the `_process_long_text` tests:

```python
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
    assert [cue.text for cue in job.cues] == ["Chunk one.", "Chunk two."]
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_routes.py -k cues -v`
Expected: FAIL — `KeyError: 'cues'` for the first, `AttributeError: 'JobState' object has no attribute 'cues'` for the second

- [ ] **Step 4: Wire cues into `routes/tts.py`**

Update imports at the top of `backend/src/readaloud/routes/tts.py`:

```python
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
```

Add `cues` to `JobState`:

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
    cues: list[Cue] = field(default_factory=list)
```

Add a helper and call it at the end of `_process_long_text`, replacing the two lines after the loop:

```python
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
```

In `_process_long_text`, change:

```python
        job_store.finalize_from_chunks(job_id, len(chunks))
        job.status = "complete"
```

to:

```python
        job_store.finalize_from_chunks(job_id, len(chunks))
        job.cues = _job_cues(job_id, chunks)
        job.status = "complete"
```

In `generate_tts`'s short-text branch, change:

```python
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
```

to:

```python
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
```

In `get_tts_status`, change the return to include cues:

```python
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_routes.py -v`
Expected: PASS, all tests including the pre-existing ones

- [ ] **Step 6: Run the full backend suite and lints**

Run: `cd backend && uv run pytest tests/ -q && uv run ruff check src/ && uv run ruff format --check src/`
Expected: all pass with zero warnings

- [ ] **Step 7: Commit**

```bash
git add backend/src/readaloud/models/schemas.py backend/src/readaloud/routes/tts.py backend/tests/test_routes.py
git commit -m "Wire reading cues into the TTS generate/status responses"
```

---

### Task 5: Add `Cue` to the frontend API layer and `useTts`

**Files:**
- Modify: `frontend/src/api/types.ts`
- Modify: `frontend/src/hooks/useTts.ts`

**Interfaces:**
- Produces: `Cue` type (`{text: string; start: number; end: number}`), `UseTtsResult.cues: Cue[]`. Consumed by Task 6 (AudioPlayer) and Task 8 (App/ReadingText).

- [ ] **Step 1: Add the `Cue` type and wire it into the response types**

In `frontend/src/api/types.ts`:

```typescript
export interface Cue {
  text: string;
  start: number;
  end: number;
}

export interface TtsGenerateRequest {
  text: string;
  voice?: string | undefined;
  model?: string | undefined;
}

export interface TtsGenerateResponse {
  job_id: string;
  status: "complete" | "processing" | "failed";
  audio_url: string | null;
  cues: Cue[];
}

export interface TtsStatusResponse {
  job_id: string;
  status: "complete" | "processing" | "failed" | "pending";
  progress: number;
  chunks_completed: number;
  chunks_total: number;
  error: string | null;
  cues: Cue[];
}
```

- [ ] **Step 2: Expose `cues` from `useTts`**

In `frontend/src/hooks/useTts.ts`, add the import and state:

```typescript
import type { Cue } from "src/api/types.ts";
```

```typescript
interface UseTtsResult {
  state: TtsState;
  progress: number;
  chunksCompleted: number;
  chunksTotal: number;
  audioUrl: string | null;
  cues: Cue[];
  error: string | null;
  generate: (text: string, voice?: string, model?: string) => void;
  reset: () => void;
}
```

```typescript
  const [cues, setCues] = useState<Cue[]>([]);
```

In `reset`, clear it:

```typescript
  const reset = useCallback(() => {
    clearTimer();
    revokeBlobUrl();
    setState("idle");
    setProgress(0);
    setChunksCompleted(0);
    setChunksTotal(0);
    setAudioUrl(null);
    setCues([]);
    setError(null);
  }, [clearTimer, revokeBlobUrl]);
```

In `startPolling`'s success branch, set cues from the status response:

```typescript
            if (status.status === "complete") {
              clearTimer();
              setCues(status.cues);
              setAudioBlobUrl(getTtsAudioUrl(jobId), () =>
                setState("complete"),
              );
            } else if (status.status === "failed") {
```

In `generate`'s synchronous-complete branch, set cues from the generate response:

```typescript
      generateTts({ text, voice, model })
        .then((resp) => {
          if (resp.status === "complete") {
            setCues(resp.cues);
            setAudioBlobUrl(getTtsAudioUrl(resp.job_id), () =>
              setState("complete"),
            );
          } else if (resp.status === "processing") {
```

Add `cues` to the returned object:

```typescript
  return {
    state,
    progress,
    chunksCompleted,
    chunksTotal,
    audioUrl,
    cues,
    error,
    generate,
    reset,
  };
```

- [ ] **Step 3: Type-check**

Run: `cd frontend && pnpm build`
Expected: succeeds (this also catches any consumer of `useTts`/`api/types.ts` that needs updating — none should exist yet before Task 8)

- [ ] **Step 4: Commit**

```bash
git add frontend/src/api/types.ts frontend/src/hooks/useTts.ts
git commit -m "Expose reading cues from the TTS API layer and useTts"
```

---

### Task 6: Track the active cue in `AudioPlayer`

**Files:**
- Create: `frontend/src/lib/cues.ts`
- Modify: `frontend/src/components/AudioPlayer.tsx`

**Interfaces:**
- Consumes: `Cue` (Task 5)
- Produces: `findActiveCueIndex(cues: Cue[], time: number): number | null`; `AudioPlayerProps.cues`, `.onCueChange`, `.onPlayingChange`. Consumed by Task 8 (App).

- [ ] **Step 1: Implement the binary-search lookup**

Create `frontend/src/lib/cues.ts`:

```typescript
import type { Cue } from "src/api/types.ts";

/**
 * Binary-search `cues` (sorted, non-overlapping, ascending by start) for
 * the one containing `time`. Returns null if `time` falls before the
 * first cue, after the last cue, or in a gap between two cues.
 */
export function findActiveCueIndex(cues: Cue[], time: number): number | null {
  let low = 0;
  let high = cues.length - 1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    const cue = cues[mid];
    if (cue === undefined) break;
    if (time < cue.start) {
      high = mid - 1;
    } else if (time >= cue.end) {
      low = mid + 1;
    } else {
      return mid;
    }
  }

  return null;
}
```

- [ ] **Step 2: Add cue tracking to `AudioPlayer`**

In `frontend/src/components/AudioPlayer.tsx`, update the imports and props:

```typescript
import { useEffect, useRef, useState } from "react";
import { findActiveCueIndex } from "src/lib/cues.ts";
import type { Cue } from "src/api/types.ts";

interface AudioPlayerProps {
  audioUrl: string | null;
  cues?: Cue[];
  onCueChange?: (index: number | null) => void;
  onPlayingChange?: (isPlaying: boolean) => void;
}
```

Update the function signature and add the tracking effect (placed after the existing `playbackRate` effect):

```typescript
export function AudioPlayer({
  audioUrl,
  cues = [],
  onCueChange,
  onPlayingChange,
}: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const [isPlaying, setIsPlaying] = useState(false);
  const activeCueRef = useRef<number | null>(null);

  useEffect(() => {
    if (audioUrl && audioRef.current) {
      audioRef.current.load();
      audioRef.current.play().catch(() => {
        // Autoplay may be blocked by browser policy
      });
    }
  }, [audioUrl]);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate]);

  useEffect(() => {
    if (!isPlaying) {
      if (activeCueRef.current !== null) {
        activeCueRef.current = null;
        onCueChange?.(null);
      }
      return;
    }

    let rafId: number;
    const tick = () => {
      const audio = audioRef.current;
      if (audio) {
        const index = findActiveCueIndex(cues, audio.currentTime);
        if (index !== activeCueRef.current) {
          activeCueRef.current = index;
          onCueChange?.(index);
        }
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(rafId);
  }, [isPlaying, cues, onCueChange]);
```

Update the `<audio>` element's handlers to report `isPlaying` upward:

```tsx
      <audio
        ref={audioRef}
        className="audio-player__element"
        controls
        src={audioUrl}
        onPlay={() => {
          setIsPlaying(true);
          onPlayingChange?.(true);
        }}
        onPause={() => {
          setIsPlaying(false);
          onPlayingChange?.(false);
        }}
        onEnded={() => {
          setIsPlaying(false);
          onPlayingChange?.(false);
        }}
      />
```

- [ ] **Step 3: Type-check**

Run: `cd frontend && pnpm build`
Expected: succeeds

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/cues.ts frontend/src/components/AudioPlayer.tsx
git commit -m "Track the active reading cue during playback"
```

---

### Task 7: Add the `ReadingText` component

**Files:**
- Create: `frontend/src/components/ReadingText.tsx`
- Modify: `frontend/src/App.css`

**Interfaces:**
- Consumes: `Cue` (Task 5)
- Produces: `ReadingText` component, props `{cues: Cue[]; activeCueIndex: number | null}`. Consumed by Task 8 (App).

- [ ] **Step 1: Implement the component**

Create `frontend/src/components/ReadingText.tsx`:

```tsx
import { useEffect, useRef } from "react";
import type { Cue } from "src/api/types.ts";

interface ReadingTextProps {
  cues: Cue[];
  activeCueIndex: number | null;
}

export function ReadingText({ cues, activeCueIndex }: ReadingTextProps) {
  const activeRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeCueIndex]);

  return (
    <div className="reading-text">
      {cues.map((cue, index) => (
        <span
          key={index}
          ref={index === activeCueIndex ? activeRef : null}
          className={
            index === activeCueIndex
              ? "reading-text__sentence reading-text__sentence--active"
              : "reading-text__sentence"
          }
        >
          {cue.text}{" "}
        </span>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Add matching styles**

In `frontend/src/App.css`, after the `.text-input__count` rule, add:

```css
/* Reading Text */
.reading-text {
  width: 100%;
  min-height: 200px;
  max-height: 400px;
  overflow-y: auto;
  padding: 0.75rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-surface);
  color: var(--text);
  font-family: var(--font);
  font-size: 0.9375rem;
  line-height: 1.6;
}

.reading-text__sentence--active {
  background: var(--primary);
  color: #fff;
  border-radius: 3px;
}
```

- [ ] **Step 3: Type-check**

Run: `cd frontend && pnpm build`
Expected: succeeds

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/ReadingText.tsx frontend/src/App.css
git commit -m "Add ReadingText component for highlighted playback view"
```

---

### Task 8: Swap `TextInput` for `ReadingText` while playing

**Files:**
- Modify: `frontend/src/App.tsx`

**Interfaces:**
- Consumes: `ReadingText` (Task 7), `AudioPlayer.onPlayingChange`/`.onCueChange`/`.cues` (Task 6), `useTts().cues` (Task 5)

- [ ] **Step 1: Wire the swap**

In `frontend/src/App.tsx`, add the import and state, and pass the new props through:

```tsx
import { useState } from "react";
import { Layout } from "src/components/Layout.tsx";
import { TextInput } from "src/components/TextInput.tsx";
import { UrlInput } from "src/components/UrlInput.tsx";
import { VoiceSelector } from "src/components/VoiceSelector.tsx";
import { AudioPlayer } from "src/components/AudioPlayer.tsx";
import { ReadingText } from "src/components/ReadingText.tsx";
import { SettingsPanel } from "src/components/SettingsPanel.tsx";
import {
  GenerationProgress,
} from "src/components/GenerationProgress.tsx";
import { useTts } from "src/hooks/useTts.ts";
import { useSettingsStore } from "src/stores/settings.ts";
import "src/App.css";

export function App() {
  const [text, setText] = useState("");
  const [voice, setVoice] = useState("af_heart");
  const [isPlaying, setIsPlaying] = useState(false);
  const [activeCueIndex, setActiveCueIndex] = useState<number | null>(null);
  const tts = useTts();
  const settings = useSettingsStore();

  const isGenerating =
    tts.state === "generating" || tts.state === "polling";

  function handleExtracted(
    extractedText: string,
    _title: string | null,
  ) {
    setText(extractedText);
  }

  function handleGenerate() {
    if (!text.trim()) return;
    // Speed is applied by the player via playbackRate, never at generation time --
    // sending it here too would multiply the two rates together.
    tts.generate(
      text,
      voice || undefined,
      settings.tts_model || undefined,
    );
  }

  return (
    <Layout>
      <UrlInput
        onExtracted={handleExtracted}
        disabled={isGenerating}
      />

      {isPlaying ? (
        <ReadingText cues={tts.cues} activeCueIndex={activeCueIndex} />
      ) : (
        <TextInput
          value={text}
          onChange={setText}
          disabled={isGenerating}
        />
      )}

      <div className="controls">
        <VoiceSelector
          value={voice}
          onChange={setVoice}
          disabled={isGenerating}
        />

        <button
          className="btn btn--primary btn--generate"
          onClick={handleGenerate}
          disabled={isGenerating || !text.trim()}
        >
          {isGenerating ? "Generating..." : "Generate"}
        </button>
      </div>

      <GenerationProgress
        progress={tts.progress}
        chunksCompleted={tts.chunksCompleted}
        chunksTotal={tts.chunksTotal}
        visible={isGenerating}
      />

      {tts.error !== null && (
        <div className="error-message">{tts.error}</div>
      )}

      <AudioPlayer
        audioUrl={tts.audioUrl}
        cues={tts.cues}
        onPlayingChange={setIsPlaying}
        onCueChange={setActiveCueIndex}
      />

      <SettingsPanel />
    </Layout>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `cd frontend && pnpm build`
Expected: succeeds

- [ ] **Step 3: Commit**

```bash
git add frontend/src/App.tsx
git commit -m "Swap in the highlighted reading view during playback"
```

---

### Task 9: Manual verification

No automated frontend tests exist for this feature (see Global Constraints) — verify by hand.

**Files:** none (verification only)

- [ ] **Step 1: Start both servers**

Run in one terminal: `cd backend && uv run uvicorn readaloud.main:app --host 0.0.0.0 --port 8055`
Run in another: `cd frontend && pnpm dev`

- [ ] **Step 2: Verify short-text playback highlighting**

Open `http://localhost:8056`. Paste a short multi-sentence text (under 4000 characters, e.g. 3-4 sentences). Click Generate, then Play. Confirm:
- The textarea is replaced by a read-only view once playback starts.
- The current sentence is highlighted and the highlight advances roughly in sync with the audio.
- Pausing (native audio controls) or hitting the stop button reverts to the editable textarea.

- [ ] **Step 3: Verify long-text (multi-chunk) playback highlighting**

Paste a much longer text (several paragraphs, comfortably over 4000 characters) so it goes through the chunked background job path. Click Generate, wait for completion, then Play. Confirm:
- Highlighting still tracks correctly across chunk boundaries (no dead zones or stuck highlights at a chunk seam).
- Scrolling: as playback proceeds past the visible area, the view auto-scrolls to keep the current sentence visible.

- [ ] **Step 4: Verify seeking and speed changes**

While playing the long text: drag the native audio scrubber to a new position — confirm the highlight jumps to match. Use the `«15`/`15»` skip buttons — confirm the highlight updates accordingly. Change the speed control — confirm highlighting still advances correctly (it should track real audio position, not wall-clock time).

- [ ] **Step 5: Verify playback end**

Let audio play to the end (or seek near the end). Confirm `onEnded` fires, the view reverts to the editable textarea, and no errors appear in the browser console throughout all of the above.
