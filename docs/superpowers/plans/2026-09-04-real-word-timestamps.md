# Real Word-Level Timing for Reading Highlights Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the character-count timing heuristic for reading-highlight
cues with Kokoro-FastAPI's real per-word timestamps where available, falling
back to the heuristic per chunk when they aren't.

**Architecture:** `TtsClient` gains `generate_speech_with_timestamps()`,
which calls Kokoro's `/dev/captioned_speech` endpoint and falls back to the
plain `/v1/audio/speech` call (returning `None` timestamps) on a 404.
`reading_cues.compute_cues()` takes a third per-chunk argument
(`chunk_timestamps`) and, per chunk, builds cues from real timestamps when
present or the existing character-count heuristic when not — chunks are
already independent in this module, so mixing both within one job is a
natural extension, not new complexity. `routes/tts.py` threads timestamps
from synthesis through to cue computation at both call sites (the immediate
short-text path and the background long-text job).

**Tech Stack:** Python 3.13, FastAPI, httpx, pytest, pytest-asyncio.

**Spec:** `docs/superpowers/specs/2026-09-04-real-word-timestamps-design.md`

## Global Constraints

- One `TtsClient` instance per job (already true today) — the
  `_captions_supported` cache is instance-scoped, never global.
- No changes to `models/schemas.py` — `Cue`, `ChunkStatus`,
  `TtsGenerateResponse`, `TtsStatusResponse` stay as they are.
  `WordTimestamp` is backend-internal and never serialized to the frontend.
- A 404 from `/dev/captioned_speech` means "server doesn't support this" —
  fall back silently. Any other error (5xx after retries, network failure,
  malformed JSON) propagates as a real failure — never silently downgrade a
  broken server response into "no timestamps."
- Paragraph-break marker placement is best-effort: on a word-count mismatch
  between our own paragraph split and the server's (merged) timestamps,
  skip the marker for that chunk — never raise.
- Each task must leave all existing tests passing — `uv run pytest -q` from
  `backend/` after every task.

---

### Task 1: Extract shared retry helper in `TtsClient`

**Files:**
- Modify: `backend/src/readaloud/services/tts_client.py`
- Test: `backend/tests/test_tts_client.py` (no new tests — existing tests
  must pass unchanged, proving this refactor is behavior-preserving)

**Interfaces:**
- Produces: `TtsClient._post_with_retry(url: str, payload: dict) -> httpx.Response`
  — same retry/backoff/error semantics `generate_speech` has today. Later
  tasks add a `bypass_status_codes` parameter to this method.

This is a pure refactor: pull the retry loop out of `generate_speech` into
its own method, and have `generate_speech` call it. No behavior changes.

- [ ] **Step 1: Extract the retry loop**

Replace the body of `generate_speech` in
`backend/src/readaloud/services/tts_client.py`:

```python
class TtsClient:
    """Async client for OpenAI-compatible TTS servers."""

    def __init__(self) -> None:
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(120.0))

    async def _post_with_retry(self, url: str, payload: dict) -> httpx.Response:
        """POST with retry/backoff on retryable failures.

        Raises:
            RuntimeError: A non-retryable HTTP error, or every attempt was
                exhausted.
        """
        last_error: Exception | str | None = None
        for attempt in range(MAX_ATTEMPTS):
            try:
                response = await self._client.post(url, json=payload, headers=auth_headers())
                response.raise_for_status()
                return response
            except httpx.HTTPStatusError as exc:
                status = exc.response.status_code
                last_error = _error_message(exc.response)
                if status not in RETRYABLE_STATUS_CODES:
                    raise RuntimeError(last_error) from exc
                if attempt < MAX_ATTEMPTS - 1:
                    await asyncio.sleep(_retry_delay(exc.response, attempt))
            except (httpx.HTTPError, httpx.StreamError) as exc:
                last_error = exc
                if attempt < MAX_ATTEMPTS - 1:
                    await asyncio.sleep(2**attempt)

        raise RuntimeError(f"TTS generation failed after {MAX_ATTEMPTS} attempts: {last_error}")

    async def generate_speech(
        self,
        text: str,
        voice: str | None = None,
        model: str | None = None,
        speed: float = 1.0,
    ) -> bytes:
        """Generate speech audio from text via the TTS server.

        Args:
            text: The text to synthesize.
            voice: Voice ID to use. Defaults to configured voice.
            model: Model ID to use. Defaults to configured model.
            speed: Playback speed multiplier.

        Returns:
            Raw MP3 audio bytes.
        """
        url = f"{settings.TTS_BASE_URL}/v1/audio/speech"
        payload = {
            "model": model or settings.TTS_MODEL,
            "input": text,
            "voice": voice or settings.TTS_DEFAULT_VOICE,
            "speed": speed,
            "response_format": "mp3",
        }
        response = await self._post_with_retry(url, payload)
        return response.content

    async def close(self) -> None:
        await self._client.aclose()
```

- [ ] **Step 2: Run the existing test suite to confirm no behavior change**

Run: `cd backend && uv run pytest tests/test_tts_client.py -v`
Expected: All existing tests PASS unchanged (they test `generate_speech`'s
behavior, which is now delegated to `_post_with_retry` but identical).

- [ ] **Step 3: Commit**

```bash
git add backend/src/readaloud/services/tts_client.py
git commit -m "Extract retry loop from TtsClient.generate_speech"
```

---

### Task 2: Add `WordTimestamp` and `generate_speech_with_timestamps`

**Files:**
- Modify: `backend/src/readaloud/services/reading_cues.py` (add the
  `WordTimestamp` dataclass only — no cue-building changes yet)
- Modify: `backend/src/readaloud/services/tts_client.py`
- Test: `backend/tests/test_tts_client.py`

**Interfaces:**
- Consumes: `TtsClient._post_with_retry` from Task 1.
- Produces:
  - `WordTimestamp` (frozen dataclass: `word: str, start: float, end: float`)
    in `reading_cues.py` — Task 3 builds on this.
  - `TtsClient.generate_speech_with_timestamps(text, voice=None, model=None, speed=1.0) -> tuple[bytes, list[WordTimestamp] | None]`

- [ ] **Step 1: Add `WordTimestamp` to `reading_cues.py`**

In `backend/src/readaloud/services/reading_cues.py`, add near the top
(after the imports, before `compute_cues`):

```python
from dataclasses import dataclass


@dataclass(frozen=True)
class WordTimestamp:
    """One word's real timing, as reported by the TTS server."""

    word: str
    start: float
    end: float
```

- [ ] **Step 2: Write the failing tests**

Add to `backend/tests/test_tts_client.py`, after the existing imports add:

```python
import base64

from readaloud.services.reading_cues import WordTimestamp
```

Then add these tests at the end of the file:

```python
@pytest.mark.asyncio
async def test_generate_speech_with_timestamps_success(client):
    body = json.dumps(
        {
            "audio": base64.b64encode(b"fake-mp3-data").decode(),
            "audio_format": "audio/mpeg",
            "timestamps": [
                {"word": "Hello", "start_time": 0.0, "end_time": 0.3},
                {"word": ",", "start_time": 0.3, "end_time": 0.4},
            ],
        }
    ).encode()
    mock_response = httpx.Response(200, content=body, request=httpx.Request("POST", "http://test"))
    with patch.object(client._client, "post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = mock_response
        audio, timestamps = await client.generate_speech_with_timestamps("Hello,")
    assert audio == b"fake-mp3-data"
    assert timestamps == [
        WordTimestamp(word="Hello", start=0.0, end=0.3),
        WordTimestamp(word=",", start=0.3, end=0.4),
    ]
    await client.close()


@pytest.mark.asyncio
async def test_generate_speech_with_timestamps_falls_back_on_404(client):
    not_found = httpx.Response(404, request=httpx.Request("POST", "http://test"))
    fallback_response = httpx.Response(
        200, content=b"fallback-audio", request=httpx.Request("POST", "http://test")
    )
    with patch.object(client._client, "post", new_callable=AsyncMock) as mock_post:
        mock_post.side_effect = [not_found, fallback_response]
        audio, timestamps = await client.generate_speech_with_timestamps("Hello")
    assert audio == b"fallback-audio"
    assert timestamps is None
    assert client._captions_supported is False
    assert mock_post.call_count == 2
    await client.close()


@pytest.mark.asyncio
async def test_generate_speech_with_timestamps_skips_captions_after_first_404(client):
    client._captions_supported = False
    mock_response = httpx.Response(
        200, content=b"plain-audio", request=httpx.Request("POST", "http://test")
    )
    with patch.object(client._client, "post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = mock_response
        audio, timestamps = await client.generate_speech_with_timestamps("Hello")
    assert audio == b"plain-audio"
    assert timestamps is None
    assert mock_post.call_count == 1
    called_url = mock_post.await_args.args[0]
    assert called_url.endswith("/v1/audio/speech")
    await client.close()


@pytest.mark.asyncio
async def test_generate_speech_with_timestamps_retries_on_server_error(client):
    error_response = httpx.Response(500, request=httpx.Request("POST", "http://test"))
    body = json.dumps(
        {
            "audio": base64.b64encode(b"audio-after-retry").decode(),
            "audio_format": "audio/mpeg",
            "timestamps": [{"word": "Hi", "start_time": 0.0, "end_time": 0.2}],
        }
    ).encode()
    success_response = httpx.Response(
        200, content=body, request=httpx.Request("POST", "http://test")
    )
    with patch.object(client._client, "post", new_callable=AsyncMock) as mock_post:
        mock_post.side_effect = [
            httpx.HTTPStatusError(
                "Server error", request=error_response.request, response=error_response
            ),
            success_response,
        ]
        audio, timestamps = await client.generate_speech_with_timestamps("Hi")
    assert audio == b"audio-after-retry"
    assert timestamps == [WordTimestamp(word="Hi", start=0.0, end=0.2)]
    assert mock_post.call_count == 2
    await client.close()


@pytest.mark.asyncio
async def test_generate_speech_with_timestamps_propagates_non_retryable_error(client):
    error_body = json.dumps({"error": {"message": "Invalid voice: bogus"}}).encode()
    error_response = httpx.Response(
        400, content=error_body, request=httpx.Request("POST", "http://test")
    )
    with patch.object(client._client, "post", new_callable=AsyncMock) as mock_post:
        mock_post.side_effect = httpx.HTTPStatusError(
            "Bad request", request=error_response.request, response=error_response
        )
        with pytest.raises(RuntimeError, match="Invalid voice: bogus"):
            await client.generate_speech_with_timestamps("Hello", voice="bogus")
    assert mock_post.call_count == 1
    await client.close()
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_tts_client.py -k with_timestamps -v`
Expected: FAIL with `AttributeError: 'TtsClient' object has no attribute 'generate_speech_with_timestamps'`

- [ ] **Step 4: Implement**

In `backend/src/readaloud/services/tts_client.py`:

1. Add imports at the top:

```python
import base64
```

and

```python
from readaloud.services.reading_cues import WordTimestamp
```

2. Change `_post_with_retry` to accept a `bypass_status_codes` parameter —
   replace the whole method with:

```python
    async def _post_with_retry(
        self,
        url: str,
        payload: dict,
        bypass_status_codes: frozenset[int] = frozenset(),
    ) -> httpx.Response:
        """POST with retry/backoff on retryable failures.

        A response whose status is in `bypass_status_codes` is returned
        as-is without raising -- for callers that need to inspect it (e.g.
        a 404 meaning "this endpoint isn't implemented," not a failure).

        Raises:
            RuntimeError: A non-retryable, non-bypassed HTTP error, or
                every attempt was exhausted.
        """
        last_error: Exception | str | None = None
        for attempt in range(MAX_ATTEMPTS):
            try:
                response = await self._client.post(url, json=payload, headers=auth_headers())
                if response.status_code in bypass_status_codes:
                    return response
                response.raise_for_status()
                return response
            except httpx.HTTPStatusError as exc:
                status = exc.response.status_code
                last_error = _error_message(exc.response)
                if status not in RETRYABLE_STATUS_CODES:
                    raise RuntimeError(last_error) from exc
                if attempt < MAX_ATTEMPTS - 1:
                    await asyncio.sleep(_retry_delay(exc.response, attempt))
            except (httpx.HTTPError, httpx.StreamError) as exc:
                last_error = exc
                if attempt < MAX_ATTEMPTS - 1:
                    await asyncio.sleep(2**attempt)

        raise RuntimeError(f"TTS generation failed after {MAX_ATTEMPTS} attempts: {last_error}")
```

3. Add `self._captions_supported: bool | None = None` to `__init__`:

```python
    def __init__(self) -> None:
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(120.0))
        self._captions_supported: bool | None = None
```

4. Add the new method after `generate_speech`:

```python
    async def generate_speech_with_timestamps(
        self,
        text: str,
        voice: str | None = None,
        model: str | None = None,
        speed: float = 1.0,
    ) -> tuple[bytes, list[WordTimestamp] | None]:
        """Generate speech with real per-word timestamps, when supported.

        Tries Kokoro-FastAPI's `/dev/captioned_speech` endpoint. A 404 means
        the configured server doesn't implement it -- cached on this
        instance (one `TtsClient` per job) so later calls this job skip
        straight to `generate_speech` instead of repeating a request that
        will only fail again. Any other error propagates like
        `generate_speech`'s does.

        Returns:
            The audio bytes, and either the server's real per-word
            timestamps or None if the server doesn't support them.
        """
        if self._captions_supported is False:
            audio = await self.generate_speech(text, voice, model, speed)
            return audio, None

        url = f"{settings.TTS_BASE_URL}/dev/captioned_speech"
        payload = {
            "model": model or settings.TTS_MODEL,
            "input": text,
            "voice": voice or settings.TTS_DEFAULT_VOICE,
            "speed": speed,
            "response_format": "mp3",
            "stream": False,
        }
        response = await self._post_with_retry(url, payload, bypass_status_codes=frozenset({404}))

        if response.status_code == 404:
            self._captions_supported = False
            audio = await self.generate_speech(text, voice, model, speed)
            return audio, None

        self._captions_supported = True
        data = response.json()
        audio = base64.b64decode(data["audio"])
        timestamps = [
            WordTimestamp(word=item["word"], start=item["start_time"], end=item["end_time"])
            for item in data["timestamps"]
        ]
        return audio, timestamps
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_tts_client.py -v`
Expected: All PASS, including the 5 new tests.

- [ ] **Step 6: Lint**

Run: `cd backend && uv run ruff check src/ tests/`
Expected: All checks passed.

- [ ] **Step 7: Commit**

```bash
git add backend/src/readaloud/services/tts_client.py backend/src/readaloud/services/reading_cues.py backend/tests/test_tts_client.py
git commit -m "Add TtsClient.generate_speech_with_timestamps"
```

---

### Task 3: Build cues from real timestamps

**Files:**
- Modify: `backend/src/readaloud/services/reading_cues.py`
- Test: `backend/tests/test_reading_cues.py`

**Interfaces:**
- Consumes: `WordTimestamp` from Task 2.
- Produces:
  - `_merge_punctuation(timestamps: list[WordTimestamp]) -> list[WordTimestamp]`
  - `_cues_from_timestamps(text: str, timestamps: list[WordTimestamp], offset: float) -> list[Cue]`
    — Task 4 wires this into `compute_cues`.

These are new private functions alongside the existing heuristic path;
`compute_cues`'s public signature doesn't change until Task 4, so these are
tested directly by importing them.

- [ ] **Step 1: Write the failing tests**

In `backend/tests/test_reading_cues.py`, change the existing import line:

```python
from readaloud.services.reading_cues import compute_cues
```

to:

```python
from readaloud.services.reading_cues import (
    WordTimestamp,
    _cues_from_timestamps,
    _merge_punctuation,
    compute_cues,
)
```

Then add these tests at the end of the file:

```python
def test_merge_punctuation_folds_trailing_punctuation_into_previous_word():
    merged = _merge_punctuation(
        [
            WordTimestamp(word="test", start=1.0, end=1.6),
            WordTimestamp(word=".", start=1.6, end=1.8),
        ]
    )
    assert merged == [WordTimestamp(word="test.", start=1.0, end=1.8)]


def test_merge_punctuation_keeps_leading_punctuation_standalone():
    merged = _merge_punctuation([WordTimestamp(word="“", start=0.0, end=0.05)])
    assert merged == [WordTimestamp(word="“", start=0.0, end=0.05)]


def test_merge_punctuation_leaves_plain_words_untouched():
    merged = _merge_punctuation(
        [
            WordTimestamp(word="Hello", start=0.0, end=0.3),
            WordTimestamp(word="there", start=0.3, end=0.6),
        ]
    )
    assert merged == [
        WordTimestamp(word="Hello", start=0.0, end=0.3),
        WordTimestamp(word="there", start=0.3, end=0.6),
    ]


def test_cues_from_timestamps_offsets_by_chunk_start():
    timestamps = [
        WordTimestamp(word="Hi", start=0.0, end=0.2),
        WordTimestamp(word="!", start=0.2, end=0.3),
    ]
    cues = _cues_from_timestamps("Hi!", timestamps, offset=5.0)
    assert [(c.text, c.start, c.end) for c in cues] == [("Hi!", 5.0, 5.3)]


def test_cues_from_timestamps_attaches_paragraph_break():
    timestamps = [
        WordTimestamp(word="First", start=0.0, end=0.3),
        WordTimestamp(word="para", start=0.3, end=0.6),
        WordTimestamp(word=".", start=0.6, end=0.7),
        WordTimestamp(word="Second", start=0.7, end=1.0),
        WordTimestamp(word="para", start=1.0, end=1.3),
        WordTimestamp(word=".", start=1.3, end=1.4),
    ]
    cues = _cues_from_timestamps("First para.\n\nSecond para.", timestamps, offset=0.0)
    assert [c.text for c in cues] == ["First", "para.\n\n", "Second", "para."]


def test_cues_from_timestamps_skips_paragraph_marker_on_word_count_mismatch():
    # Simulates the server's text normalizer dropping a word: only 3 merged
    # tokens come back for text that naively splits into 4 words.
    timestamps = [
        WordTimestamp(word="First", start=0.0, end=0.3),
        WordTimestamp(word="para", start=0.3, end=0.6),
        WordTimestamp(word=".", start=0.6, end=0.7),
        WordTimestamp(word="para", start=0.7, end=1.0),
        WordTimestamp(word=".", start=1.0, end=1.1),
    ]
    cues = _cues_from_timestamps("First para.\n\nSecond para.", timestamps, offset=0.0)
    assert all("\n\n" not in c.text for c in cues)


def test_cues_from_timestamps_empty_timestamps_yields_no_cues():
    assert _cues_from_timestamps("text", [], offset=0.0) == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_reading_cues.py -k "merge_punctuation or cues_from_timestamps" -v`
Expected: FAIL with `ImportError: cannot import name '_cues_from_timestamps'`

- [ ] **Step 3: Implement**

Add to `backend/src/readaloud/services/reading_cues.py`, after the
`WordTimestamp` dataclass and before `compute_cues`:

```python
_PUNCTUATION_ONLY = re.compile(r"[^\w\s]+")
```

Add after `_cues_for_sentence` (end of file):

```python
def _merge_punctuation(timestamps: list[WordTimestamp]) -> list[WordTimestamp]:
    """Fold punctuation-only tokens into the preceding word.

    Kokoro tokenizes punctuation separately from the word before it (e.g.
    "test" then "."). A lone punctuation highlight isn't useful, so its text
    and duration join the previous word's cue. A leading punctuation-only
    token with no predecessor is kept standalone.
    """
    merged: list[WordTimestamp] = []
    for ts in timestamps:
        if merged and _PUNCTUATION_ONLY.fullmatch(ts.word):
            previous = merged[-1]
            merged[-1] = WordTimestamp(
                word=previous.word + ts.word, start=previous.start, end=ts.end
            )
        else:
            merged.append(ts)
    return merged


def _paragraph_boundary_indices(paragraph_word_counts: list[int], word_total: int) -> set[int]:
    """Indices into a flat word list marking the last word of every paragraph but the last.

    Returns an empty set if the paragraph word counts don't add up to
    `word_total` -- the TTS server's text normalization can drop or alter
    words, and a misaligned split is worse than none: best-effort, like the
    rest of cue computation.
    """
    if len(paragraph_word_counts) < 2 or sum(paragraph_word_counts) != word_total:
        return set()

    boundaries: set[int] = set()
    cumulative = 0
    for count in paragraph_word_counts[:-1]:
        cumulative += count
        boundaries.add(cumulative - 1)
    return boundaries


def _cues_from_timestamps(text: str, timestamps: list[WordTimestamp], offset: float) -> list[Cue]:
    """Build cues for one chunk from the TTS server's real per-word timestamps."""
    merged = _merge_punctuation(timestamps)
    if not merged:
        return []

    paragraph_word_counts = [len(p.split()) for p in re.split(r"\n\n+", text) if p.strip()]
    boundary_indices = _paragraph_boundary_indices(paragraph_word_counts, len(merged))

    cues: list[Cue] = []
    for index, ts in enumerate(merged):
        cue_text = ts.word + "\n\n" if index in boundary_indices else ts.word
        cues.append(Cue(text=cue_text, start=offset + ts.start, end=offset + ts.end))
    return cues
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_reading_cues.py -v`
Expected: All PASS.

- [ ] **Step 5: Lint**

Run: `cd backend && uv run ruff check src/ tests/`
Expected: All checks passed.

- [ ] **Step 6: Commit**

```bash
git add backend/src/readaloud/services/reading_cues.py backend/tests/test_reading_cues.py
git commit -m "Add cue building from real per-word timestamps"
```

---

### Task 4: Wire real-timestamp path into `compute_cues`

**Files:**
- Modify: `backend/src/readaloud/services/reading_cues.py`
- Modify: `backend/src/readaloud/routes/tts.py` (stop-gap call-site fix only
  — still calls `generate_speech`, not yet `generate_speech_with_timestamps`)
- Test: `backend/tests/test_reading_cues.py`

**Interfaces:**
- Consumes: `_cues_from_timestamps` from Task 3.
- Produces: `compute_cues(chunk_texts: list[str], chunk_durations: list[float], chunk_timestamps: list[list[WordTimestamp] | None]) -> list[Cue]`
  — the third parameter is new and required. Tasks 5 and 6 pass real
  timestamps here instead of `None`.

- [ ] **Step 1: Update existing tests for the new required parameter**

In `backend/tests/test_reading_cues.py`, update every existing `compute_cues`
call (these currently pass 2 args) to pass a matching-length list of `None`
as the third argument, and add two new tests. Replace the whole file's
content above the `_merge_punctuation`/`_cues_from_timestamps` tests added
in Task 3 with:

```python
import pytest

from readaloud.services.reading_cues import (
    WordTimestamp,
    _cues_from_timestamps,
    _merge_punctuation,
    compute_cues,
)


def test_single_chunk_single_sentence_splits_duration_by_word_length():
    # "One" (3 chars) + "sentence." (9 chars) = 12 chars
    cues = compute_cues(["One sentence."], [2.0], [None])

    assert [c.text for c in cues] == ["One", "sentence."]
    assert cues[0].start == pytest.approx(0.0)
    assert cues[0].end == pytest.approx(2.0 * 3 / 12)
    assert cues[1].start == cues[0].end
    assert cues[1].end == pytest.approx(2.0)


def test_single_chunk_splits_duration_across_words_by_character_count():
    # "Short." (6 chars) + "A much longer sentence here." (28 chars) = 34 chars total
    cues = compute_cues(["Short. A much longer sentence here."], [3.4], [None])

    assert [c.text for c in cues] == [
        "Short.",
        "A",
        "much",
        "longer",
        "sentence",
        "here.",
    ]

    sentence_one_end = 3.4 * 6 / 34
    assert cues[0].start == pytest.approx(0.0)
    assert cues[0].end == pytest.approx(sentence_one_end)

    sentence_two_duration = 3.4 - sentence_one_end
    word_chars = [1, 4, 6, 8, 5]  # A, much, longer, sentence, here.
    total_word_chars = sum(word_chars)
    assert cues[1].start == pytest.approx(sentence_one_end)
    assert cues[2].start == pytest.approx(
        sentence_one_end + sentence_two_duration * word_chars[0] / total_word_chars
    )
    assert cues[-1].end == pytest.approx(3.4)


def test_cues_are_contiguous():
    cues = compute_cues(["Short. A much longer sentence here."], [3.4], [None])

    for earlier, later in zip(cues, cues[1:], strict=False):
        assert earlier.end == later.start


def test_multiple_chunks_offset_by_cumulative_duration():
    cues = compute_cues(["First chunk.", "Second chunk."], [1.0, 2.0], [None, None])

    assert [c.text for c in cues] == ["First", "chunk.", "Second", "chunk."]
    assert cues[0].start == 0.0
    assert cues[1].end == pytest.approx(1.0)
    assert cues[2].start == pytest.approx(1.0)
    assert cues[-1].end == pytest.approx(3.0)


def test_oversized_sentence_piece_still_splits_into_words():
    # Simulates text_chunker._split_long_sentence breaking one long sentence
    # into multiple TTS chunks -- each piece has no terminal punctuation of
    # its own, but is still split word by word like any other sentence.
    cues = compute_cues(["word word word", "word word done."], [1.0, 1.0], [None, None])

    assert [c.text for c in cues] == ["word", "word", "word", "word", "word", "done."]
    assert cues[0].start == 0.0
    assert cues[2].end == pytest.approx(1.0)
    assert cues[3].start == pytest.approx(1.0)
    assert cues[-1].end == pytest.approx(2.0)


def test_paragraph_break_marker_attaches_to_last_word_of_paragraph():
    cues = compute_cues(["First para. Still first.\n\nSecond para."], [3.0], [None])

    assert [c.text for c in cues] == [
        "First",
        "para.",
        "Still",
        "first.\n\n",
        "Second",
        "para.",
    ]


def test_empty_chunk_text_yields_no_cues():
    assert compute_cues([""], [1.0], [None]) == []


def test_mismatched_lengths_raises():
    with pytest.raises(ValueError):
        compute_cues(["a", "b"], [1.0], [None, None])


def test_mismatched_timestamps_length_raises():
    with pytest.raises(ValueError):
        compute_cues(["a"], [1.0], [None, None])


def test_mixes_real_timestamps_and_heuristic_across_chunks():
    real_timestamps = [
        WordTimestamp(word="Real", start=0.0, end=0.4),
        WordTimestamp(word="words.", start=0.4, end=1.0),
    ]
    cues = compute_cues(
        ["Real words.", "Heuristic words."],
        [1.0, 2.0],
        [real_timestamps, None],
    )

    assert [c.text for c in cues] == ["Real", "words.", "Heuristic", "words."]
    assert cues[0].start == pytest.approx(0.0)
    assert cues[1].end == pytest.approx(1.0)
    assert cues[2].start == pytest.approx(1.0)
    assert cues[-1].end == pytest.approx(3.0)
```

Leave the `test_merge_punctuation_*` and `test_cues_from_timestamps_*` tests
from Task 3 as-is below this.

- [ ] **Step 2: Run tests to verify the updated ones fail**

Run: `cd backend && uv run pytest tests/test_reading_cues.py -v`
Expected: The tests updated in Step 1 FAIL with
`TypeError: compute_cues() missing 1 required positional argument: 'chunk_timestamps'`

- [ ] **Step 3: Implement the signature change and branching**

Replace `compute_cues` in `backend/src/readaloud/services/reading_cues.py`:

```python
def compute_cues(
    chunk_texts: list[str],
    chunk_durations: list[float],
    chunk_timestamps: list[list[WordTimestamp] | None],
) -> list[Cue]:
    """Build word-level playback cues for a sequence of TTS chunks.

    Each chunk uses real per-word timestamps from the TTS server when
    available (`chunk_timestamps[i]` is not None). Otherwise its real audio
    duration is split across its own words, proportional to character
    length, since there's no per-word timing to fall back on. Chunks are
    independent, so a job can mix both -- e.g. a chunk whose audio came from
    the client's local cache was never sent to the TTS server this request
    and has no timestamps.

    Args:
        chunk_texts: Chunk text, in playback order -- the same list passed
            to the TTS server for synthesis.
        chunk_durations: Each chunk's real audio duration in seconds, same
            order and length as `chunk_texts`.
        chunk_timestamps: Each chunk's real word timestamps from the TTS
            server, or None if unavailable for that chunk. Same order and
            length as `chunk_texts`.

    Returns:
        Cues in playback order, with `start`/`end` in the stitched audio's
        timeline (seconds).

    Raises:
        ValueError: If the three lists differ in length.
    """
    if not (len(chunk_texts) == len(chunk_durations) == len(chunk_timestamps)):
        raise ValueError(
            "chunk_texts, chunk_durations, and chunk_timestamps must be the same length"
        )

    cues: list[Cue] = []
    offset = 0.0
    for text, duration, timestamps in zip(
        chunk_texts, chunk_durations, chunk_timestamps, strict=True
    ):
        if timestamps is not None:
            cues.extend(_cues_from_timestamps(text, timestamps, offset))
        else:
            cues.extend(_cues_for_chunk(text, duration, offset))
        offset += duration
    return cues
```

- [ ] **Step 4: Fix the two production call sites (stop-gap, still heuristic)**

In `backend/src/readaloud/routes/tts.py`, this keeps behavior identical
(still 100% heuristic) while matching the new required signature —
Tasks 5 and 6 replace the `None`s with real timestamps.

In `generate_tts`, change:

```python
        cues = compute_cues([request.text], [frame_duration_seconds(real_audio_frames(audio))])
```

to:

```python
        cues = compute_cues(
            [request.text], [frame_duration_seconds(real_audio_frames(audio))], [None]
        )
```

In `_job_cues`, change:

```python
    return compute_cues(chunks, durations)
```

to:

```python
    return compute_cues(chunks, durations, [None] * len(chunks))
```

- [ ] **Step 5: Run the full backend test suite**

Run: `cd backend && uv run pytest -q`
Expected: All PASS (this proves the stop-gap didn't change route behavior).

- [ ] **Step 6: Lint**

Run: `cd backend && uv run ruff check src/ tests/`
Expected: All checks passed.

- [ ] **Step 7: Commit**

```bash
git add backend/src/readaloud/services/reading_cues.py backend/src/readaloud/routes/tts.py backend/tests/test_reading_cues.py
git commit -m "Add chunk_timestamps parameter to compute_cues"
```

---

### Task 5: Wire the short-text generation path to real timestamps

**Files:**
- Modify: `backend/src/readaloud/routes/tts.py`
- Test: `backend/tests/test_routes.py`

**Interfaces:**
- Consumes: `TtsClient.generate_speech_with_timestamps` (Task 2),
  `compute_cues` (Task 4).

- [ ] **Step 1: Update the three affected tests**

In `backend/tests/test_routes.py`, in `test_tts_generate_short_text`
(around line 139-142), change:

```python
        mock_client.generate_speech = AsyncMock(return_value=b"mp3data")
```

to:

```python
        mock_client.generate_speech_with_timestamps = AsyncMock(return_value=(b"mp3data", None))
```

Make the identical change in `test_tts_generate_short_text_includes_cues`
(around line 162) and `test_job_state_holds_no_audio_bytes` (around line
184) — all three currently have this exact line.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_routes.py -k short_text -v`
Expected: FAIL — the route still calls `generate_speech`, which the mock no
longer defines as an `AsyncMock`, so calling it returns a plain `MagicMock`
and `await`-ing it raises `TypeError`.

- [ ] **Step 3: Implement**

In `backend/src/readaloud/routes/tts.py`, inside `generate_tts`, replace:

```python
    if len(request.text) <= settings.MAX_CHUNK_CHARS:
        client = TtsClient()
        try:
            audio = await client.generate_speech(request.text, voice, model, request.speed)
        finally:
            await client.close()

        job_store.write_final(job_id, audio)
        cues = compute_cues(
            [request.text], [frame_duration_seconds(real_audio_frames(audio))], [None]
        )
```

with:

```python
    if len(request.text) <= settings.MAX_CHUNK_CHARS:
        client = TtsClient()
        try:
            audio, timestamps = await client.generate_speech_with_timestamps(
                request.text, voice, model, request.speed
            )
        finally:
            await client.close()

        job_store.write_final(job_id, audio)
        cues = compute_cues(
            [request.text], [frame_duration_seconds(real_audio_frames(audio))], [timestamps]
        )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_routes.py -v`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/readaloud/routes/tts.py backend/tests/test_routes.py
git commit -m "Use real timestamps for the short-text generation path"
```

---

### Task 6: Wire the long-text background job to real timestamps

**Files:**
- Modify: `backend/src/readaloud/routes/tts.py`
- Test: `backend/tests/test_routes.py`

**Interfaces:**
- Consumes: `TtsClient.generate_speech_with_timestamps` (Task 2),
  `compute_cues` (Task 4).
- Produces: `_job_cues(job_id: str, chunks: list[str], timestamps_by_chunk: list[list[WordTimestamp] | None]) -> list[Cue]`
  — signature change from today's `_job_cues(job_id, chunks)`.

A `client_cache` chunk's audio was never sent to the TTS server this
request, so it has no timestamps (`None`) — only chunks this request
actually synthesized can have real ones.

- [ ] **Step 1: Update the affected tests**

In `backend/tests/test_routes.py`:

**`test_long_text_streams_chunks_and_keeps_them_readable`** (~line 264),
change:

```python
        mock_client.generate_speech = AsyncMock(side_effect=[b"one", b"two", b"three"])
```

to:

```python
        mock_client.generate_speech_with_timestamps = AsyncMock(
            side_effect=[(b"one", None), (b"two", None), (b"three", None)]
        )
```

**`test_long_text_job_status_includes_cues`** (~line 283), change:

```python
        mock_client.generate_speech = AsyncMock(return_value=b"mp3data")
```

to:

```python
        mock_client.generate_speech_with_timestamps = AsyncMock(return_value=(b"mp3data", None))
```

**`test_long_text_job_status_cues_have_nonzero_duration`** (~line 306),
change:

```python
        mock_client.generate_speech = AsyncMock(return_value=audio)
```

to:

```python
        mock_client.generate_speech_with_timestamps = AsyncMock(return_value=(audio, None))
```

**`test_known_chunk_hash_skips_synthesis`** (~lines 329, 337-338), change:

```python
        mock_client.generate_speech = AsyncMock(return_value=b"synth-b")
```

to:

```python
        mock_client.generate_speech_with_timestamps = AsyncMock(return_value=(b"synth-b", None))
```

and change:

```python
    assert mock_client.generate_speech.await_count == 1
    assert mock_client.generate_speech.await_args.args[0] == "b"
```

to:

```python
    assert mock_client.generate_speech_with_timestamps.await_count == 1
    assert mock_client.generate_speech_with_timestamps.await_args.args[0] == "b"
```

**`test_process_long_text_without_known_chunks_synthesizes_everything`**
(~lines 353, 359), change:

```python
        mock_client.generate_speech = AsyncMock(return_value=b"synth-only")
```

to:

```python
        mock_client.generate_speech_with_timestamps = AsyncMock(return_value=(b"synth-only", None))
```

and change:

```python
    assert mock_client.generate_speech.await_count == 1
```

to:

```python
    assert mock_client.generate_speech_with_timestamps.await_count == 1
```

**`test_tts_generate_known_chunk_skips_synthesis_end_to_end`** (~lines 377,
396), change:

```python
        mock_client.generate_speech = AsyncMock(return_value=b"synth-audio")
```

to:

```python
        mock_client.generate_speech_with_timestamps = AsyncMock(return_value=(b"synth-audio", None))
```

and change:

```python
    assert mock_client.generate_speech.await_count == 1
```

to:

```python
    assert mock_client.generate_speech_with_timestamps.await_count == 1
```

**`test_tts_generate_drops_malformed_known_chunk_audio`** (~lines 416, 435),
change:

```python
        mock_client.generate_speech = AsyncMock(return_value=b"synth")
```

to:

```python
        mock_client.generate_speech_with_timestamps = AsyncMock(return_value=(b"synth", None))
```

and change:

```python
    assert mock_client.generate_speech.await_count == 2
```

to:

```python
    assert mock_client.generate_speech_with_timestamps.await_count == 2
```

**`test_chunk_endpoint_serves_a_completed_job`** (~line 454), change:

```python
        mock_client.generate_speech = AsyncMock(side_effect=[b"one", b"two"])
```

to:

```python
        mock_client.generate_speech_with_timestamps = AsyncMock(
            side_effect=[(b"one", None), (b"two", None)]
        )
```

**`test_failed_long_job_records_the_error`** (~line 470), change:

```python
        mock_client.generate_speech = AsyncMock(side_effect=RuntimeError("tts exploded"))
```

to:

```python
        mock_client.generate_speech_with_timestamps = AsyncMock(
            side_effect=RuntimeError("tts exploded")
        )
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_routes.py -v`
Expected: The 9 tests above FAIL (route still calls the old method name).

- [ ] **Step 3: Implement**

In `backend/src/readaloud/routes/tts.py`:

1. Change the import:

```python
from readaloud.services.reading_cues import compute_cues
```

to:

```python
from readaloud.services.reading_cues import WordTimestamp, compute_cues
```

2. Replace `_process_long_text`:

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
    calling the TTS server -- the client already has this audio from a prior
    session and uploaded it rather than asking for it to be resynthesized. Such
    a chunk has no real timestamps, since it was never sent to the TTS server
    this request.
    """
    job = jobs[job_id]
    client = TtsClient()
    known_by_hash = known_by_hash or {}
    timestamps_by_chunk: list[list[WordTimestamp] | None] = []

    try:
        for i, chunk in enumerate(chunks):
            chunk_hash = hashlib.sha256(chunk.encode("utf-8")).hexdigest()
            cached_audio = known_by_hash.get(chunk_hash)
            if cached_audio is not None:
                audio = cached_audio
                source = "client_cache"
                timestamps_by_chunk.append(None)
            else:
                audio, timestamps = await client.generate_speech_with_timestamps(
                    chunk, voice, model, speed
                )
                source = "synthesized"
                timestamps_by_chunk.append(timestamps)

            job_store.write_chunk(job_id, i, audio)
            job.chunks.append(ChunkStatus(index=i, hash=chunk_hash, source=source))
            job.chunks_completed = i + 1
            job.progress = job.chunks_completed / job.chunks_total

        job_store.finalize_from_chunks(job_id, len(chunks))
        try:
            job.cues = _job_cues(job_id, chunks, timestamps_by_chunk)
        except Exception:
            logger.warning("Failed to compute reading cues for job %s", job_id, exc_info=True)
        job.status = "complete"
    except Exception as exc:
        job.status = "failed"
        job.error = str(exc)
    finally:
        await client.close()
```

3. Replace `_job_cues`:

```python
def _job_cues(
    job_id: str,
    chunks: list[str],
    timestamps_by_chunk: list[list[WordTimestamp] | None],
) -> list[Cue]:
    """Compute reading cues from each chunk's finalized audio.

    Reads chunks back from `job_store` rather than the bytes just
    synthesized, since a `client_cache`-sourced chunk was never held in
    memory here to begin with.
    """
    durations = []
    for index in range(len(chunks)):
        audio = job_store.read_chunk(job_id, index) or b""
        durations.append(frame_duration_seconds(real_audio_frames(audio)))
    return compute_cues(chunks, durations, timestamps_by_chunk)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_routes.py -v`
Expected: All PASS.

- [ ] **Step 5: Run the full backend test suite**

Run: `cd backend && uv run pytest -q`
Expected: All PASS.

- [ ] **Step 6: Lint**

Run: `cd backend && uv run ruff check src/ tests/`
Expected: All checks passed.

- [ ] **Step 7: Manual verification**

With the GPU Kokoro container running (`docker compose ps` shows
`kokoro-gpu` healthy), start the backend dev server and generate speech for
a multi-paragraph piece of text in the web app. Confirm in the browser that
word-by-word highlighting now tracks the audio noticeably tighter than
before, including across a paragraph break.

- [ ] **Step 8: Commit**

```bash
git add backend/src/readaloud/routes/tts.py backend/tests/test_routes.py
git commit -m "Use real timestamps for the long-text background job"
```
