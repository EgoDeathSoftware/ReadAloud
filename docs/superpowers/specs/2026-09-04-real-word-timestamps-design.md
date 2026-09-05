# Real word-level timing for reading highlights — design

## Problem

Reading-highlight cues (`services/reading_cues.py`) currently estimate each
word's `start`/`end` by splitting a chunk's real audio duration
proportionally by character count. This was accurate enough for
sentence-level highlighting (`docs/superpowers/specs/2026-09-03-reading-highlight-design.md`),
but after switching to word-level granularity the error is directly
visible: character count doesn't track speech duration. Measured against
Kokoro-FastAPI's actual per-word timestamps for "this is a short test.":

| word | actual duration | chars |
|---|---|---|
| "this" | 200ms | 4 |
| "test" | 613ms | 4 |
| "," | 75ms | 1 |
| "." | 175ms | 1 |

Punctuation alone carries 75-175ms of real pause that the heuristic assigns
zero time. The result is highlighting that visibly lags the audio.

## Reversed decision

The prior spec explicitly rejected real per-word timestamps to avoid tying
the backend to a Kokoro-specific endpoint. That tradeoff no longer holds:
this deployment only ever runs Kokoro-FastAPI (`docker-compose.yml` wires up
`kokoro-gpu`/`kokoro-cpu` exclusively), and the accuracy gap at word
granularity is large enough to make the feature feel broken. This spec
adopts real timestamps where available and falls back to the existing
heuristic per chunk otherwise, so a non-Kokoro `READALOUD_TTS_BASE_URL`
still gets approximate highlighting instead of none.

## Kokoro's captioned-speech endpoint

`POST {TTS_BASE_URL}/dev/captioned_speech`, same payload shape as
`/v1/audio/speech` plus `"stream": false`, returns:

```json
{
  "audio": "<base64 mp3>",
  "audio_format": "audio/mpeg",
  "timestamps": [
    {"word": "Hello", "start_time": 0.016, "end_time": 0.316},
    {"word": ",", "start_time": 0.566, "end_time": 0.641}
  ]
}
```

Verified against the running container. Punctuation is tokenized
separately from words. This is not part of the OpenAI-compatible contract
the rest of the app targets — it 404s on any server that doesn't implement
it (confirmed via Context7 docs for `/remsky/kokoro-fastapi`).

## Backend

### `services/tts_client.py`

Extract the existing retry/backoff loop (currently inlined in
`generate_speech`) into a shared helper:

```python
async def _post_with_retry(self, url: str, payload: dict) -> httpx.Response
```

Same retry semantics as today (`MAX_ATTEMPTS`, `RETRYABLE_STATUS_CODES`,
`Retry-After` handling) — `generate_speech` calls it and keeps its current
behavior unchanged.

Add:

```python
@dataclass(frozen=True)
class WordTimestamp:
    word: str
    start: float
    end: float

async def generate_speech_with_timestamps(
    self, text: str, voice: str | None, model: str | None, speed: float,
) -> tuple[bytes, list[WordTimestamp] | None]
```

Behavior:
- If a prior call on this instance already got a 404 from
  `/dev/captioned_speech`, skip straight to `generate_speech` and return
  `(audio, None)`. One `TtsClient` is constructed per job (`routes/tts.py`),
  so this cache is job-scoped, not global — no cross-job or cross-server
  staleness.
- Otherwise POST to `/dev/captioned_speech` via `_post_with_retry`. A 404
  response sets the instance flag and falls back to `generate_speech` for
  *this* call too, so the first chunk of an unsupported-server job still
  succeeds normally.
- On success, base64-decode `audio`, map `timestamps` entries to
  `WordTimestamp` (`start`/`end`, not the server's `start_time`/`end_time`
  names — kept short since this is an internal type, never serialized).
- Any other error (5xx after retries exhausted, network failure, malformed
  JSON) propagates as today's `generate_speech` does — it does not fall
  back silently, since that would hide a real synthesis failure behind a
  degraded-but-successful-looking response.

### `services/reading_cues.py`

Cue computation moves from whole-job to per-chunk, since a chunk's audio
source now varies independently of its neighbors:

```python
def compute_cues(
    chunk_texts: list[str],
    chunk_durations: list[float],
    chunk_timestamps: list[list[WordTimestamp] | None],
) -> list[Cue]
```

All three lists are the same length and order as today's `chunk_texts`.
For each chunk, offset accumulates exactly as before (`frame_duration_seconds`
still determines cross-chunk offsets regardless of which path a chunk
takes). Per chunk:

- **`chunk_timestamps[i]` is not `None`** (real timestamps, from a chunk
  Kokoro just synthesized): build cues from them directly.
  1. Merge punctuation-only tokens (`re.fullmatch(r"[^\w\s]+", token.word)`)
     into the preceding word's cue: append the punctuation text and extend
     the cue's `end` to the punctuation's `end_time`. A leading
     punctuation-only token with no predecessor is kept standalone (rare,
     harmless).
  2. Attach the paragraph-break marker: split the chunk's original text on
     `\n\n+` as today, count words per paragraph with `.split()`, and walk
     the merged-cue list to find the ordinal boundary after each paragraph
     but the last. If the merged-cue count doesn't match the total naive
     word count (Kokoro's text normalizer can drop or alter words per its
     own docs), skip attaching markers for this chunk — best-effort,
     consistent with the existing "Make cue computation best-effort"
     handling in `routes/tts.py`. A skipped marker means that one chunk's
     paragraph break renders as a run-on in the reading view; it does not
     affect timing or highlighting.
- **`chunk_timestamps[i]` is `None`** (heuristic fallback — either the
  server doesn't support captions, or this chunk's audio came from
  `known_chunks`/client cache and was never synthesized this request):
  run today's existing `_cues_for_chunk`/`_cues_for_sentence` character-count
  split, unchanged.

This mixes real and heuristic cues within a single job when some chunks are
cache hits and others are freshly synthesized — the per-chunk offset
architecture already treats chunks independently, so this isn't new
complexity, just using the seam that's already there.

### `routes/tts.py`

Both call sites switch from `generate_speech` to
`generate_speech_with_timestamps`:

- `generate_tts`'s short-text path (`len(text) <= MAX_CHUNK_CHARS`): call
  once, pass the single chunk's `(text, duration, timestamps)` triple to
  `compute_cues`.
- `_process_long_text`: for each chunk, if it's a `client_cache` hit, its
  timestamps are `None` (no synthesis call happens); otherwise call
  `generate_speech_with_timestamps` and keep the returned timestamps
  alongside the existing per-chunk audio write. `JobState` gains nothing
  new on the wire — `_job_cues` (still reading audio back from
  `job_store` for duration) now also has the in-memory timestamps list to
  pass through. Timestamps are not persisted to disk or exposed in any
  response schema; only the resulting `Cue` objects are.

No changes to `models/schemas.py` — `Cue`, `ChunkStatus`, `TtsGenerateResponse`,
`TtsStatusResponse` are unchanged. `WordTimestamp` is backend-internal.

## Frontend

No changes. `findActiveCueIndex`, `AudioPlayer`, and `ReadingText` already
operate on `Cue.start`/`end`/`text` regardless of how those were computed.

## Error handling

- Captions-endpoint failure other than 404 (network error, 5xx after
  retries, malformed JSON body) is treated as a real synthesis failure for
  that chunk and propagates like any other `generate_speech` error today —
  it fails the job rather than silently downgrading, since a broken TTS
  server response shouldn't be masked as "just no timestamps."
- 404 specifically means "this server doesn't implement captions," which is
  an expected, permanent condition for the life of the job — cached after
  the first occurrence to avoid a wasted round-trip per chunk.
- Paragraph-marker misalignment within a chunk degrades to no marker for
  that chunk, never a crash or job failure — matches the "best-effort" cue
  handling already in place for the whole feature.

## Testing

- `test_tts_client.py`: success path parses audio + timestamps correctly;
  404 falls back to `generate_speech` and marks the instance so the next
  call skips straight to it; a non-404 error still retries and then
  propagates, matching `generate_speech`'s existing contract.
- `test_reading_cues.py`: real-timestamp cues merge trailing punctuation
  into the previous word; paragraph-break marker attaches correctly when
  word counts align and is omitted (without raising) when they don't; a
  chunk with `None` timestamps still produces the existing heuristic cues;
  a job mixing one real-timestamp chunk and one heuristic chunk offsets
  correctly across the boundary.
- `test_routes.py`: existing mocks of `TtsClient.generate_speech` update to
  `generate_speech_with_timestamps` (returning `(audio, None)` where the
  test doesn't care about timestamps, so heuristic cue assertions stay
  valid unchanged); one new test exercises a `client_cache` chunk
  alongside a synthesized one to confirm the mixed path.
