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
separately from words. `return_timestamps` defaults to true but is sent
explicitly, since the whole request depends on it. This is not part of the
OpenAI-compatible contract the rest of the app targets — it 404s on any
server that doesn't implement it (confirmed via Context7 docs for
`/remsky/kokoro-fastapi`).

### The timestamps describe the spoken audio, not the source text

Two behaviors measured against the running container decide the design
below. Both make the server's `word` strings unusable as display text.

**Kokoro reports post-normalization words.** Its text normalizer rewrites
the input before synthesis, and timestamps describe what it actually said:

| input text | timestamp words |
|---|---|
| `Dr. Smith met Mr. Jones at 3 p.m.` | `Doctor`, `Smith`, `met`, `Mister`, `Jones`, `at`, `three`, `p-m.` |
| `It costs $5.00 today, about 1,234 units.` | `It`, `costs`, `five`, `dollars`, `today`, `,`, `about`, `one`, `thousand`, … |
| `Visit https://example.com or mail bob@example.com now.` | `Visit`, `https`, `example`, `dot`, `com`, `or`, … |
| `He said "hello there" (quietly) to the crowd.` | punctuation split off, so merging yields `said"`, `there"(`, `quietly)` |

Rendering those in the reading view would show the user words they never
wrote — "five dollars" where their article says "$5.00" — and mangled
tokens around quotes and parentheses.

**Timestamps can silently stop short of the audio.** For
`The plan - a good one - worked well.` the server returned 2.136s of audio
but only six tokens ending at 1.091s: "worked well" is spoken with no
timestamps covering it. Consuming that list unguarded freezes the highlight
for the last half of the clip. Well-formed responses leave only a small
trailing-silence gap (26-76ms measured), so the shortfall is detectable.

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
async def generate_speech_with_timestamps(
    self, text: str, voice: str | None, model: str | None, speed: float,
) -> tuple[bytes, list[WordTimestamp] | None]
```

`WordTimestamp` (frozen dataclass: `word`, `start`, `end`) lives in
`services/reading_cues.py`, not here — that module is pure logic with no
HTTP dependency, and the client mapping a response into a domain type is
the normal direction. Importing it the other way would drag `httpx` into
the cue module's import graph and its tests.

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
- Empty decoded audio raises, matching the guard `generate_speech` already
  has. A GPU-context failure inside Kokoro returns HTTP 200 with an empty
  body rather than a 5xx (observed in production), so both synthesis paths
  have to catch it or the job "succeeds" with silence.
- Any other error (5xx after retries exhausted, network failure, malformed
  JSON) propagates as today's `generate_speech` does — it does not fall
  back silently, since that would hide a real synthesis failure behind a
  degraded-but-successful-looking response.

The short-text path in `generate_tts` builds a fresh `TtsClient` per
request, so against a non-Kokoro server every short generation pays one
wasted 404 round-trip. Accepted: it's one extra local request against a
server that's about to do far more expensive synthesis work, and a
process-wide cache would need invalidating when `TTS_BASE_URL` changes.

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
takes).

**Timestamps supply timing only. Cue text always comes from the user's own
text.** Given the normalization and truncation behavior measured above,
the server's `word` strings are used to *count and time* tokens, never to
render them. This keeps the invariant the reading view depends on: what it
displays is exactly the text that was submitted, whatever the TTS server
did to it internally.

Per chunk, the real-timestamp path is:

1. **Merge punctuation-only tokens** (`re.fullmatch(r"[^\w\s]+", word)`)
   into the adjacent word's span: backward into the preceding token
   normally (extending its `end`), forward into the following token when
   there is no predecessor (extending its `start`). Forward-merging the
   leading case matters — a paragraph opening on a quotation mark is
   common in articles, and leaving that token standalone would fail the
   alignment check below for the whole chunk.
2. **Align by index against the chunk's own words.** Split the chunk text
   the way the heuristic path already does — paragraphs on `\n\n+`, then
   `.split()` — into a flat list of original word tokens, with `"\n\n"`
   appended to each paragraph's last token exactly as today. Kokoro splits
   punctuation off a word and step 1 puts it back, so a well-behaved
   response has one merged token per original word.
3. **Reject unusable timestamps**, falling back to the heuristic for this
   chunk, when either:
   - the merged token count differs from the original word count — the
     normalizer rewrote something ("$5.00" → "five dollars") or dropped
     it, so no index mapping is trustworthy; or
   - the last timestamp ends before 80% of the chunk's real audio
     duration — the truncation case, where a count match alone would not
     save us and the highlight would freeze mid-chunk.
4. Otherwise emit one cue per original word: text from the original token
   (paragraph marker included), `start`/`end` from the merged timestamp,
   offset by the chunk's start.

`chunk_timestamps[i] is None` — the server doesn't support captions, or
this chunk's audio came from `known_chunks`/client cache and was never
synthesized this request — takes the same heuristic path as a rejection,
running today's `_cues_for_chunk`/`_cues_for_sentence` character-count
split unchanged.

Two consequences worth stating plainly. A chunk containing a price, a URL,
or an abbreviation Kokoro expands falls back to heuristic timing for that
whole chunk — correct text with today's approximate timing, which is the
right trade against showing words the user never wrote. And the paragraph
marker needs no separate boundary-matching logic or best-effort skipping:
it rides along on the original tokens, so it is either exactly right or
the chunk fell back to the heuristic that already handles it.

This mixes real and heuristic cues within a single job — the per-chunk
offset architecture already treats chunks independently, so this isn't new
complexity, just using the seam that's already there.

Validated against the running container before writing the plan: a
three-paragraph article containing quoted dialogue (one paragraph opening
on a quotation mark) and a parenthetical produced 41 aligned cues, text
identical to the input, paragraph markers on the right words, and coverage
to 14.15s of 14.21s of audio. The `$5.00` and truncating-em-dash cases both
rejected into the heuristic as intended.

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
- Timestamps that don't align with the chunk's words, or that stop short of
  its audio, degrade that chunk to heuristic cues — never a crash or job
  failure, matching the "best-effort" cue handling already in place for the
  whole feature. The user sees today's approximate timing for that chunk,
  which is strictly no worse than the current behavior.
- Empty audio on the captioned path raises, exactly as on the plain path.

## Testing

- `test_tts_client.py`: success path parses audio + timestamps correctly;
  404 falls back to `generate_speech` and marks the instance so the next
  call skips straight to it; a non-404 error still retries and then
  propagates, matching `generate_speech`'s existing contract; empty audio
  raises.
- `test_reading_cues.py`: trailing punctuation merges into the previous
  word's span and a leading punctuation token merges into the next;
  timing comes from the timestamps while text comes from the original
  words (asserted with a normalization-style case where the two differ);
  the paragraph-break marker rides on the original tokens; a count
  mismatch and a truncated timestamp list each fall back to heuristic cues
  rather than raising; a chunk with `None` timestamps still produces the
  existing heuristic cues; a job mixing one real-timestamp chunk and one
  heuristic chunk offsets correctly across the boundary.
- `test_routes.py`: existing mocks of `TtsClient.generate_speech` update to
  `generate_speech_with_timestamps` (returning `(audio, None)` where the
  test doesn't care about timestamps, so heuristic cue assertions stay
  valid unchanged); one new test exercises a `client_cache` chunk
  alongside a synthesized one to confirm the mixed path.
