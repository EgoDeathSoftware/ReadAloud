# Extension Reading Highlight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Highlight the word currently being spoken directly on the live web page while the Firefox extension reads an article aloud.

**Architecture:** Extraction and DOM mapping become a single pass over the live document ("stamp-and-walk"), so cue *n* maps to word *n* by construction rather than by fuzzy text matching. The backend gains per-chunk cues so timings stream alongside audio instead of arriving only when the whole job finishes; the direct adapter computes its own cues from Kokoro's `/dev/captioned_speech`. The background page polls playback position and messages the tab, which paints one `Range` via the CSS Custom Highlight API.

**Tech Stack:** Python 3.13 / FastAPI / pytest (backend); vanilla ES modules + vitest + jsdom (extension); Firefox WebExtension Manifest V2.

**Spec:** `docs/superpowers/specs/2026-09-08-extension-reading-highlight-design.md`

## Global Constraints

- Firefox `strict_min_version` moves from `109` to `140` (CSS Custom Highlight API is Baseline June 2025). Do not add a span-wrapping fallback for older versions.
- Extension imports are extension-root-absolute (`/lib/foo.js`), which resolves both in the browser and under vitest.
- `content-reader.js` and `Readability.js` are **plain scripts, not ES modules** — `tabs.executeScript` cannot inject modules. They must contain no `import`/`export`.
- Cue times on `ChunkStatus.cues` and in every extension code path are **chunk-relative**: each chunk's first cue starts at `0.0`. Job-level `TtsStatusResponse.cues` and `TtsGenerateResponse.cues` stay in the stitched timeline, unchanged.
- Extractor character cap stays 50,000, but must now truncate on a word boundary.
- No settings toggle for the highlight.
- Highlighting is best-effort: any failure disables the highlight for that read and never interrupts audio.
- Python: `uv run ruff check src/`, `uv run ruff format src/`, `uv run pytest tests/` from `backend/`. Extension: `npm test` from `extension/`.
- Line length 100 chars; functions ≤100 lines; Google-style docstrings on non-trivial public APIs.

---

### Task 1: Probe background-page timer resolution

The whole orchestration design rests on a 100 ms `setInterval` staying near 100 ms in a persistent background page. `requestAnimationFrame` is not an option there (the page is never visible). This is a throwaway spike — nothing from it is committed.

**Files:**
- Temporarily modify: `extension/background.js` (reverted in Step 4)

- [ ] **Step 1: Add a temporary timing logger**

Append to `extension/background.js`:

```js
// TEMPORARY PROBE — do not commit.
let probeLast = Date.now();
setInterval(() => {
  const now = Date.now();
  console.log("probe delta", now - probeLast);
  probeLast = now;
}, 100);
```

- [ ] **Step 2: Load the extension and observe**

Run Firefox, open `about:debugging#/runtime/this-firefox`, "Load Temporary Add-on", select `extension/manifest.json`, then "Inspect" the ReadAloud background page and watch the console.

Observe for at least 30 seconds in each of these states:
1. Firefox focused.
2. Firefox window minimized.
3. Another application focused, with a tab playing ReadAloud audio.

- [ ] **Step 3: Record the decision**

Expected: deltas stay roughly 100-120 ms in all three states.

- If deltas stay near 100 ms → the plan proceeds exactly as written.
- If deltas jump to ~1000 ms in any state → **stop and report before continuing.** The fix is to move the tick into the content script (where `rAF` runs normally in a visible tab), driven by a ~2 Hz `{chunkIndex, currentTime}` sync message from the background page. That changes Tasks 10 and 11 and needs re-planning, not improvisation.

- [ ] **Step 4: Revert the probe**

```bash
git checkout extension/background.js
```

Nothing is committed by this task.

---

### Task 2: Backend per-chunk cues, replacing `_job_cues`

**Files:**
- Modify: `backend/src/readaloud/models/schemas.py:19-22`
- Modify: `backend/src/readaloud/routes/tts.py:84-158`
- Test: `backend/tests/test_routes.py`

**Interfaces:**
- Produces: `ChunkStatus.cues: list[Cue]` — chunk-relative cues, exposed on `TtsStatusResponse.chunks[i].cues`. Task 6 consumes it.
- Produces: `_offset_cues(chunk_cues: list[list[Cue]], durations: list[float]) -> list[Cue]`.

- [ ] **Step 1: Write the failing tests**

Add to `backend/tests/test_routes.py`:

```python
async def test_chunk_status_cues_are_chunk_relative(temp_job_store):
    from tests.mp3_test_helpers import build_frame

    job_id = "chunk-cues-job"
    jobs[job_id] = JobState(id=job_id, chunks_total=2)
    frame = build_frame(bitrate_index=1, samplerate_index=0, mode=0)
    audio = frame + frame

    with patch("readaloud.routes.tts.TtsClient") as mock_cls:
        mock_client = MagicMock()
        mock_client.generate_speech_with_timestamps = AsyncMock(return_value=(audio, None))
        mock_client.close = AsyncMock()
        mock_cls.return_value = mock_client

        await tts_routes._process_long_text(
            job_id, ["Chunk one.", "Chunk two."], "af_heart", "kokoro", 1.0
        )

    job = jobs[job_id]
    assert [c.text for c in job.chunks[0].cues] == ["Chunk", "one."]
    assert [c.text for c in job.chunks[1].cues] == ["Chunk", "two."]
    assert job.chunks[0].cues[0].start == 0.0
    assert job.chunks[1].cues[0].start == 0.0


async def test_chunk_cues_land_before_the_job_completes(temp_job_store):
    import asyncio

    from tests.mp3_test_helpers import build_frame

    job_id = "streaming-cues-job"
    jobs[job_id] = JobState(id=job_id, chunks_total=2)
    frame = build_frame(bitrate_index=1, samplerate_index=0, mode=0)
    audio = frame + frame
    release_second = asyncio.Event()

    async def generate(chunk, *args, **kwargs):
        if chunk == "Chunk two.":
            await release_second.wait()
        return audio, None

    with patch("readaloud.routes.tts.TtsClient") as mock_cls:
        mock_client = MagicMock()
        mock_client.generate_speech_with_timestamps = AsyncMock(side_effect=generate)
        mock_client.close = AsyncMock()
        mock_cls.return_value = mock_client

        task = asyncio.create_task(
            tts_routes._process_long_text(
                job_id, ["Chunk one.", "Chunk two."], "af_heart", "kokoro", 1.0
            )
        )
        while jobs[job_id].chunks_completed < 1:
            await asyncio.sleep(0)

        job = jobs[job_id]
        assert job.status == "processing"
        assert job.cues == []
        assert [c.text for c in job.chunks[0].cues] == ["Chunk", "one."]

        release_second.set()
        await task


async def test_job_cues_stay_in_the_stitched_timeline(temp_job_store):
    from tests.mp3_test_helpers import build_frame

    job_id = "offset-cues-job"
    jobs[job_id] = JobState(id=job_id, chunks_total=2)
    frame = build_frame(bitrate_index=1, samplerate_index=0, mode=0)
    audio = frame + frame
    chunk_duration = (1152 / 44100) * 2

    with patch("readaloud.routes.tts.TtsClient") as mock_cls:
        mock_client = MagicMock()
        mock_client.generate_speech_with_timestamps = AsyncMock(return_value=(audio, None))
        mock_client.close = AsyncMock()
        mock_cls.return_value = mock_client

        await tts_routes._process_long_text(
            job_id, ["Chunk one.", "Chunk two."], "af_heart", "kokoro", 1.0
        )

    job = jobs[job_id]
    assert [c.text for c in job.cues] == ["Chunk", "one.", "Chunk", "two."]
    assert job.cues[2].start == pytest.approx(chunk_duration)
    assert job.cues[-1].end == pytest.approx(2 * chunk_duration)
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd backend && uv run pytest tests/test_routes.py -k "chunk_status_cues or chunk_cues_land or stitched_timeline" -v`
Expected: FAIL — `ChunkStatus` has no attribute `cues`.

- [ ] **Step 3: Add `cues` to `ChunkStatus`**

In `backend/src/readaloud/models/schemas.py`, move `Cue` above `ChunkStatus` and add the field:

```python
class Cue(BaseModel):
    text: str
    start: float
    end: float


class ChunkStatus(BaseModel):
    index: int
    hash: str
    source: Literal["synthesized", "client_cache"]
    cues: list[Cue] = Field(default_factory=list)
```

- [ ] **Step 4: Compute cues per chunk and offset them for the job**

In `backend/src/readaloud/routes/tts.py`, replace the body of `_process_long_text` (from `job = jobs[job_id]` through `job.status = "complete"`) with:

```python
    job = jobs[job_id]
    client = TtsClient()
    known_by_hash = known_by_hash or {}
    durations: list[float] = []
    chunk_cues: list[list[Cue]] = []

    try:
        for i, chunk in enumerate(chunks):
            chunk_hash = hashlib.sha256(chunk.encode("utf-8")).hexdigest()
            cached_audio = known_by_hash.get(chunk_hash)
            if cached_audio is not None:
                audio = cached_audio
                source = "client_cache"
                timestamps = None
            else:
                audio, timestamps = await client.generate_speech_with_timestamps(
                    chunk, voice, model, speed
                )
                source = "synthesized"

            duration = frame_duration_seconds(real_audio_frames(audio))
            durations.append(duration)
            chunk_cues.append(_chunk_cues(job_id, i, chunk, duration, timestamps))

            job_store.write_chunk(job_id, i, audio)
            job.chunks.append(
                ChunkStatus(index=i, hash=chunk_hash, source=source, cues=chunk_cues[i])
            )
            job.chunks_completed = i + 1
            job.progress = job.chunks_completed / job.chunks_total

        job_store.finalize_from_chunks(job_id, len(chunks))
        job.cues = _offset_cues(chunk_cues, durations)
        job.status = "complete"
```

Update its docstring's last paragraph to read:

```
    Each chunk's cues are computed from its own audio as soon as it lands, so
    a client that plays chunks individually has word timings for chunk 0 while
    chunk 5 is still synthesizing. A chunk whose hash is already in
    `known_by_hash` has no real timestamps, since it was never sent to the TTS
    server this request, so its cues come from the character-count heuristic.
```

Replace `_job_cues` entirely with these two functions:

```python
def _chunk_cues(
    job_id: str,
    index: int,
    chunk: str,
    duration: float,
    timestamps: list[WordTimestamp] | None,
) -> list[Cue]:
    """One chunk's cues, timed from 0.

    A cue failure must not fail the job -- the audio is still good, and the
    caller's alignment check will disable highlighting when a chunk comes
    back empty.
    """
    try:
        return compute_cues([chunk], [duration], [timestamps])
    except Exception:
        logger.warning("Failed to compute cues for job %s chunk %s", job_id, index, exc_info=True)
        return []


def _offset_cues(chunk_cues: list[list[Cue]], durations: list[float]) -> list[Cue]:
    """Shift chunk-relative cues into the stitched audio's timeline.

    Equivalent to one `compute_cues` call over the whole job, because chunks
    are timed independently of each other. Clients that play chunks
    individually need the chunk-relative form; the web frontend plays the
    stitched file and needs this one.
    """
    cues: list[Cue] = []
    offset = 0.0
    for cues_for_chunk, duration in zip(chunk_cues, durations, strict=True):
        cues.extend(
            Cue(text=cue.text, start=cue.start + offset, end=cue.end + offset)
            for cue in cues_for_chunk
        )
        offset += duration
    return cues
```

- [ ] **Step 5: Run the full backend suite**

Run: `cd backend && uv run pytest tests/ -q`
Expected: PASS, including the pre-existing `test_long_text_job_status_includes_cues`, `test_long_text_job_status_cues_have_nonzero_duration`, and the mixed cached/fresh cue test at `tests/test_routes.py:528` — those are the regression guard proving `_offset_cues` reproduces `_job_cues`'s output.

- [ ] **Step 6: Lint, format, commit**

```bash
cd backend && uv run ruff check src/ && uv run ruff format src/
git add backend/src/readaloud/models/schemas.py backend/src/readaloud/routes/tts.py backend/tests/test_routes.py
git commit -m "Add per-chunk reading cues to job status"
```

---

### Task 3: Share the sentence splitter and prove the chunk word round-trip

The global word index rests on chunking never altering the word sequence. That assumption gets a test before anything depends on it.

**Files:**
- Modify: `extension/lib/chunker.js:18-22`
- Test: `extension/lib/chunker.test.js`

**Interfaces:**
- Produces: `splitSentences(text: string) => string[]` exported from `/lib/chunker.js`. Task 4 consumes it.

- [ ] **Step 1: Write the failing tests**

Add to `extension/lib/chunker.test.js`:

```js
import { chunkText, splitSentences } from "./chunker.js";

describe("splitSentences", () => {
  it("splits on sentence-ending punctuation followed by whitespace", () => {
    expect(splitSentences("One. Two! Three?")).toEqual(["One.", "Two!", "Three?"]);
  });

  it("returns a single sentence unchanged", () => {
    expect(splitSentences("No terminator here")).toEqual(["No terminator here"]);
  });
});

describe("chunk word round trip", () => {
  it("preserves the word sequence across chunk boundaries", () => {
    const paragraph = "Alpha beta gamma delta epsilon zeta eta theta iota kappa.";
    const text = [paragraph, paragraph, paragraph, paragraph].join("\n\n");
    const words = text.split(/\s+/).filter(Boolean);

    const chunked = chunkText(text, 80).flatMap((chunk) => chunk.split(/\s+/).filter(Boolean));

    expect(chunked).toEqual(words);
  });

  it("preserves the word sequence when a single sentence exceeds the chunk size", () => {
    const text = "one two three four five six seven eight nine ten eleven twelve";
    const words = text.split(" ");

    const chunked = chunkText(text, 20).flatMap((chunk) => chunk.split(/\s+/).filter(Boolean));

    expect(chunked).toEqual(words);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd extension && npm test -- chunker`
Expected: FAIL — `splitSentences` is not exported.

- [ ] **Step 3: Export the splitter and use it internally**

In `extension/lib/chunker.js`, add the export and call it from `splitLongParagraph`:

```js
/**
 * Split text into sentences on `.`, `!`, or `?` followed by whitespace.
 *
 * Mirrors `split_sentences` in backend/src/readaloud/services/text_chunker.py.
 * Shared with reading-cues.js so cue sentence boundaries match the chunker's.
 */
export function splitSentences(text) {
  return text.split(/(?<=[.!?])\s+/);
}

function splitLongParagraph(text, maxChars) {
  return packSegments(splitSentences(text), maxChars, " ", (sentence) =>
    splitLongSentence(sentence, maxChars),
  );
}
```

- [ ] **Step 4: Run to verify passing**

Run: `cd extension && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/lib/chunker.js extension/lib/chunker.test.js
git commit -m "Export splitSentences and test the chunk word round trip"
```

---

### Task 4: JS cue computation and lookup

**Files:**
- Create: `extension/lib/reading-cues.js`
- Create: `extension/lib/cues.js`
- Test: `extension/lib/reading-cues.test.js`
- Test: `extension/lib/cues.test.js`

**Interfaces:**
- Consumes: `splitSentences` from `/lib/chunker.js` (Task 3).
- Produces: `cuesForChunk(text: string, duration: number, timestamps: {word, start, end}[] | null) => {text, start, end}[]` — chunk-relative. Task 7 consumes it.
- Produces: `findActiveCueIndex(cues, time: number) => number | null`. Task 11 consumes it.

- [ ] **Step 1: Write the failing cue-computation tests**

Create `extension/lib/reading-cues.test.js`:

```js
import { describe, expect, it } from "vitest";

import { cuesForChunk } from "/lib/reading-cues.js";

describe("cuesForChunk with real timestamps", () => {
  it("uses server timings and keeps the submitted text", () => {
    const cues = cuesForChunk("Five dollars please.", 3, [
      { word: "Five", start: 0, end: 1 },
      { word: "dollars", start: 1, end: 2 },
      { word: "please", start: 2, end: 2.9 },
      { word: ".", start: 2.9, end: 3 },
    ]);

    expect(cues.map((c) => c.text)).toEqual(["Five", "dollars", "please."]);
    expect(cues[0].start).toBe(0);
    expect(cues[2].end).toBe(3);
  });

  it("snaps each cue's end to the next cue's start", () => {
    const cues = cuesForChunk("one two", 2, [
      { word: "one", start: 0, end: 0.8 },
      { word: "two", start: 1.0, end: 1.9 },
    ]);

    expect(cues[0].end).toBe(1.0);
    expect(cues[1].end).toBe(2);
  });

  it("clamps a negative first-word start to zero", () => {
    const cues = cuesForChunk("one two", 2, [
      { word: "one", start: -0.3, end: 0.9 },
      { word: "two", start: 0.9, end: 2 },
    ]);

    expect(cues[0].start).toBe(0);
  });

  it("merges a leading punctuation token forward", () => {
    const cues = cuesForChunk('"Stop there', 2, [
      { word: '"', start: 0, end: 0.1 },
      { word: "Stop", start: 0.1, end: 1 },
      { word: "there", start: 1, end: 2 },
    ]);

    expect(cues.map((c) => c.text)).toEqual(['"Stop', "there"]);
  });

  it("falls back to the heuristic when the token count does not match", () => {
    const cues = cuesForChunk("$5.00 please", 2, [
      { word: "five", start: 0, end: 0.5 },
      { word: "dollars", start: 0.5, end: 1 },
      { word: "please", start: 1, end: 2 },
    ]);

    expect(cues.map((c) => c.text)).toEqual(["$5.00", "please"]);
    expect(cues[1].end).toBe(2);
  });

  it("falls back to the heuristic when timestamps cover under 80% of the audio", () => {
    const cues = cuesForChunk("one two", 10, [
      { word: "one", start: 0, end: 1 },
      { word: "two", start: 1, end: 2 },
    ]);

    expect(cues[0].end).toBeCloseTo(5);
  });
});

describe("cuesForChunk heuristic", () => {
  it("splits the duration across words by character length", () => {
    const cues = cuesForChunk("aa bbbb", 6, null);

    expect(cues.map((c) => c.text)).toEqual(["aa", "bbbb"]);
    expect(cues[0].end).toBeCloseTo(2);
    expect(cues[1].end).toBeCloseTo(6);
  });

  it("marks the last word of a non-final paragraph with a break", () => {
    const cues = cuesForChunk("first para.\n\nsecond para.", 4, null);

    expect(cues.map((c) => c.text)).toEqual(["first", "para.\n\n", "second", "para."]);
  });

  it("returns nothing for empty text", () => {
    expect(cuesForChunk("   ", 4, null)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd extension && npm test -- reading-cues`
Expected: FAIL — cannot resolve `/lib/reading-cues.js`.

- [ ] **Step 3: Write `reading-cues.js`**

Create `extension/lib/reading-cues.js`:

```js
import { splitSentences } from "/lib/chunker.js";

/**
 * Word-level cues for one synthesized chunk.
 *
 * JS port of backend/src/readaloud/services/reading_cues.py, restricted to a
 * single chunk: times start at 0, since the extension plays each chunk as its
 * own audio element rather than one stitched file.
 */

/** Matches Python's `[^\w\s]+` against a whole token. */
const PUNCTUATION_ONLY = /^[^\p{L}\p{N}_\s]+$/u;
const MIN_TIMESTAMP_COVERAGE = 0.8;

/**
 * Build one chunk's cues, timed from 0.
 *
 * Uses the TTS server's real per-word timestamps when they line up with the
 * chunk's own words, and otherwise splits `duration` across those words
 * proportional to character length. Cue text always comes from `text`, never
 * from the timestamps -- the server reports what it spoke, which its text
 * normalizer may have rewritten.
 */
export function cuesForChunk(text, duration, timestamps) {
  if (timestamps && timestamps.length) {
    const cues = cuesFromTimestamps(text, timestamps, duration);
    if (cues) return cues;
  }
  return heuristicCues(text, duration);
}

function paragraphsOf(text) {
  return text.split(/\n\n+/).filter((paragraph) => paragraph.trim());
}

function wordsOf(text) {
  return text.split(/\s+/).filter(Boolean);
}

function heuristicCues(text, duration) {
  const sentencesByParagraph = paragraphsOf(text).map((paragraph) =>
    splitSentences(paragraph).filter((sentence) => sentence.trim()),
  );
  const allSentences = sentencesByParagraph.flat();
  const totalChars = allSentences.reduce((sum, sentence) => sum + sentence.length, 0);
  if (!allSentences.length || totalChars === 0) return [];

  const cues = [];
  let start = 0;
  sentencesByParagraph.forEach((paragraphSentences, paragraphIndex) => {
    paragraphSentences.forEach((sentence, sentenceIndex) => {
      const end = start + duration * (sentence.length / totalChars);
      const lastInParagraph = sentenceIndex === paragraphSentences.length - 1;
      const lastParagraph = paragraphIndex === sentencesByParagraph.length - 1;
      const suffix = lastInParagraph && !lastParagraph ? "\n\n" : "";
      cues.push(...sentenceCues(sentence, start, end, suffix));
      start = end;
    });
  });
  return cues;
}

function sentenceCues(sentence, start, end, suffix) {
  const words = wordsOf(sentence);
  const totalChars = words.reduce((sum, word) => sum + word.length, 0);
  if (!words.length || totalChars === 0) return [];

  const duration = end - start;
  const cues = [];
  let cursor = start;
  words.forEach((word, index) => {
    const wordEnd = cursor + duration * (word.length / totalChars);
    const isLast = index === words.length - 1;
    cues.push({ text: isLast ? word + suffix : word, start: cursor, end: wordEnd });
    cursor = wordEnd;
  });
  return cues;
}

/**
 * Fold punctuation-only tokens into the adjacent word's span.
 *
 * Kokoro tokenizes punctuation separately ("test" then "."), while the source
 * text attaches it ("test."). Punctuation merges backward, or forward when it
 * opens the chunk -- a paragraph starting on a quotation mark is common enough
 * that leaving it standalone would fail alignment for the whole chunk.
 */
function mergePunctuation(timestamps) {
  const merged = [];
  let leading = [];

  for (const stamp of timestamps) {
    const isPunctuation = PUNCTUATION_ONLY.test(stamp.word);
    if (isPunctuation && merged.length) {
      const previous = merged[merged.length - 1];
      merged[merged.length - 1] = {
        word: previous.word + stamp.word,
        start: previous.start,
        end: stamp.end,
      };
    } else if (isPunctuation) {
      leading.push(stamp);
    } else if (leading.length) {
      merged.push({
        word: leading.map((entry) => entry.word).join("") + stamp.word,
        start: leading[0].start,
        end: stamp.end,
      });
      leading = [];
    } else {
      merged.push(stamp);
    }
  }

  if (leading.length) {
    merged.push({
      word: leading.map((entry) => entry.word).join(""),
      start: leading[0].start,
      end: leading[leading.length - 1].end,
    });
  }
  return merged;
}

/** The chunk's own words in order, each paragraph's last word carrying "\n\n". */
function chunkWords(text) {
  const paragraphs = paragraphsOf(text);
  const words = [];
  paragraphs.forEach((paragraph, index) => {
    const paragraphWords = wordsOf(paragraph);
    if (index < paragraphs.length - 1 && paragraphWords.length) {
      paragraphWords[paragraphWords.length - 1] += "\n\n";
    }
    words.push(...paragraphWords);
  });
  return words;
}

/** Kokoro can report a negative start for a chunk's first word. */
function clampStart(start, duration) {
  const clamped = Math.max(0, start);
  return duration > 0 ? Math.min(clamped, duration) : clamped;
}

/**
 * Returns the chunk's cues, or null when the timestamps can't be trusted: a
 * token count that doesn't match the chunk's own words (the normalizer
 * rewrote something, so no positional mapping holds), or timestamps ending
 * well before the audio does (which would freeze the highlight).
 */
function cuesFromTimestamps(text, timestamps, duration) {
  const merged = mergePunctuation(timestamps);
  const words = chunkWords(text);
  if (!merged.length || merged.length !== words.length) return null;
  if (duration > 0 && merged[merged.length - 1].end < duration * MIN_TIMESTAMP_COVERAGE) {
    return null;
  }

  const cues = words.map((word, index) => ({
    text: word,
    start: clampStart(merged[index].start, duration),
    end: merged[index].end,
  }));
  for (let index = 0; index < cues.length - 1; index++) {
    cues[index].end = cues[index + 1].start;
  }
  if (duration > 0) cues[cues.length - 1].end = duration;
  return cues;
}
```

- [ ] **Step 4: Run to verify passing**

Run: `cd extension && npm test -- reading-cues`
Expected: PASS.

- [ ] **Step 5: Write the failing cue-lookup tests**

Create `extension/lib/cues.test.js`:

```js
import { describe, expect, it } from "vitest";

import { findActiveCueIndex } from "/lib/cues.js";

const cues = [
  { text: "one", start: 0, end: 1 },
  { text: "two", start: 1, end: 2 },
  { text: "three", start: 2, end: 3 },
];

describe("findActiveCueIndex", () => {
  it("finds the cue containing the time", () => {
    expect(findActiveCueIndex(cues, 1.5)).toBe(1);
  });

  it("treats a cue's start as inside it and its end as outside", () => {
    expect(findActiveCueIndex(cues, 1)).toBe(1);
    expect(findActiveCueIndex(cues, 2)).toBe(2);
  });

  it("returns null past the last cue", () => {
    expect(findActiveCueIndex(cues, 3)).toBeNull();
  });

  it("returns null in a gap between cues", () => {
    const gapped = [
      { text: "one", start: 0, end: 1 },
      { text: "two", start: 2, end: 3 },
    ];
    expect(findActiveCueIndex(gapped, 1.5)).toBeNull();
  });

  it("returns null for an empty cue list", () => {
    expect(findActiveCueIndex([], 0)).toBeNull();
  });
});
```

- [ ] **Step 6: Run to verify failure**

Run: `cd extension && npm test -- cues.test`
Expected: FAIL — cannot resolve `/lib/cues.js`.

- [ ] **Step 7: Write `cues.js`**

Create `extension/lib/cues.js`:

```js
/**
 * Binary-search `cues` (sorted, non-overlapping, ascending by start) for the
 * one containing `time`. Returns null if `time` falls before the first cue,
 * after the last cue, or in a gap between two cues.
 *
 * Mirrors frontend/src/lib/cues.ts.
 */
export function findActiveCueIndex(cues, time) {
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

- [ ] **Step 8: Run the full extension suite and commit**

Run: `cd extension && npm test`
Expected: PASS.

```bash
git add extension/lib/reading-cues.js extension/lib/reading-cues.test.js extension/lib/cues.js extension/lib/cues.test.js
git commit -m "Add JS reading-cue computation and lookup to the extension"
```

---

### Task 5: Cache cues alongside chunk audio

Without this, replaying a cached chunk silently downgrades it from real Kokoro timings to the heuristic.

**Files:**
- Modify: `extension/lib/chunk-cache.js:23-53`
- Test: `extension/lib/chunk-cache.test.js`

**Interfaces:**
- Produces: `chunkCache.get(voice, hash) => {blob, cues} | null` and `chunkCache.set(voice, hash, blob, cues)`. Tasks 6 and 7 consume it.

- [ ] **Step 1: Write the failing test**

Add to `extension/lib/chunk-cache.test.js`:

```js
it("returns the cues stored with the audio", () => {
  const cache = createChunkCache();
  const blob = new Blob(["audio"]);
  const cues = [{ text: "hi", start: 0, end: 1 }];

  cache.set("af_heart", "hash1", blob, cues);

  expect(cache.get("af_heart", "hash1")).toEqual({ blob, cues });
});

it("stores an empty cue list when none is given", () => {
  const cache = createChunkCache();
  cache.set("af_heart", "hash1", new Blob(["audio"]));

  expect(cache.get("af_heart", "hash1").cues).toEqual([]);
});
```

Update the existing tests in that file that assert `cache.get(...)` returns the blob directly — they now read `cache.get(...).blob`.

- [ ] **Step 2: Run to verify failure**

Run: `cd extension && npm test -- chunk-cache`
Expected: FAIL — `get` returns a Blob, not `{blob, cues}`.

- [ ] **Step 3: Store cues in the entry**

In `extension/lib/chunk-cache.js`, update the docstring and the two methods:

```js
/**
 * Session-scoped LRU cache of synthesized chunk audio and its word cues,
 * keyed by (voice, chunk hash). Cues travel with the audio so a cache hit
 * keeps the server's real word timings instead of falling back to the
 * character-count heuristic on replay. Lives only as long as the background
 * page does -- no persistence.
 */
```

```js
    get(voice, hash) {
      const k = key(voice, hash);
      const entry = store.get(k);
      if (!entry) return null;
      store.delete(k);
      store.set(k, entry);
      return { blob: entry.blob, cues: entry.cues };
    },

    set(voice, hash, blob, cues = []) {
      const k = key(voice, hash);
      const existing = store.get(k);
      if (existing) {
        totalBytes -= existing.bytes;
        store.delete(k);
      }
      evict(blob.size);
      store.set(k, { blob, cues, bytes: blob.size });
      totalBytes += blob.size;
    },
```

- [ ] **Step 4: Update the two existing call sites**

`extension/background.js:76` in `buildKnownChunks`:

```js
      const entry = chunkCache.get(voice, hash);
      if (entry) knownChunks.push({ hash, audioB64: await blobToBase64(entry.blob) });
```

Both adapters are rewritten in Tasks 6 and 7, but they must keep working now so the tree stays green. Apply the mechanical change to each.

`extension/lib/adapters/backend.js:99-102`:

```js
        const cached = info ? chunkCache.get(voice, info.hash) : null;
        let audio;
        if (info?.source === "client_cache" && cached) {
          audio = cached.blob;
```

`extension/lib/adapters/openai.js:124-128`:

```js
      const cached = chunkCache.get(voice, hash);
      let audio = cached ? cached.blob : null;
      if (!audio) {
        audio = await requestChunk(chunks[index], voice, settings, signal);
        chunkCache.set(voice, hash, audio);
      }
```

- [ ] **Step 5: Run the full suite and commit**

Run: `cd extension && npm test`
Expected: PASS.

```bash
git add extension/lib/chunk-cache.js extension/lib/chunk-cache.test.js extension/background.js extension/lib/adapters/
git commit -m "Store word cues alongside cached chunk audio"
```

---

### Task 6: Backend adapter yields per-chunk cues

**Files:**
- Modify: `extension/lib/adapters/backend.js:57-114`
- Test: `extension/lib/adapters/backend.test.js`

**Interfaces:**
- Consumes: `ChunkStatus.cues` (Task 2), `chunkCache.get/set` (Task 5).
- Produces: `backendAdapter.synthesize()` yields `{audio, index, total, cues}` with chunk-relative cues. Task 11 consumes it.

- [ ] **Step 1: Write the failing tests**

Add to `extension/lib/adapters/backend.test.js`:

```js
it("yields the cues from the generate response on the short-text path", async () => {
  const cues = [{ text: "Hello.", start: 0, end: 1 }];
  globalThis.fetch = vi.fn(async (url) => {
    if (url.endsWith("/api/tts/generate")) {
      return jsonResponse({ job_id: "j1", status: "complete", cues });
    }
    return blobResponse();
  });

  const items = await run();

  expect(items[0].cues).toEqual(cues);
});

it("yields each chunk's cues from the status response", async () => {
  const chunkCues = [
    [{ text: "one", start: 0, end: 1 }],
    [{ text: "two", start: 0, end: 1 }],
  ];
  globalThis.fetch = vi.fn(async (url) => {
    if (url.endsWith("/api/tts/generate")) {
      return jsonResponse({ job_id: "j1", status: "processing" });
    }
    if (url.includes("/api/tts/status/")) {
      return jsonResponse({
        status: "complete",
        progress: 1,
        chunks_completed: 2,
        chunks_total: 2,
        chunks: [
          { index: 0, hash: "h0", source: "synthesized", cues: chunkCues[0] },
          { index: 1, hash: "h1", source: "synthesized", cues: chunkCues[1] },
        ],
      });
    }
    return blobResponse();
  });

  const items = await run();

  expect(items.map((item) => item.cues)).toEqual(chunkCues);
});

it("restores cues from the chunk cache on a client_cache hit", async () => {
  const cues = [{ text: "cached", start: 0, end: 1 }];
  chunkCache.set("af_heart", "h0", new Blob(["audio"]), cues);
  globalThis.fetch = vi.fn(async (url) => {
    if (url.endsWith("/api/tts/generate")) {
      return jsonResponse({ job_id: "j1", status: "processing" });
    }
    if (url.includes("/api/tts/status/")) {
      return jsonResponse({
        status: "complete",
        progress: 1,
        chunks_completed: 1,
        chunks_total: 1,
        chunks: [{ index: 0, hash: "h0", source: "client_cache", cues: [] }],
      });
    }
    return blobResponse();
  });

  const items = await run();

  expect(items[0].cues).toEqual(cues);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd extension && npm test -- adapters/backend`
Expected: FAIL — yielded items have no `cues` property.

- [ ] **Step 3: Plumb cues through both paths**

In `extension/lib/adapters/backend.js`, in `synthesize`, replace the short-text branch:

```js
    if (job.status === "complete") {
      onProgress({ chunksCompleted: 1, chunksTotal: 1, progress: 1 });
      yield {
        audio: await fetchAudio(settings, `/api/tts/audio/${job.job_id}`, signal),
        index: 0,
        total: 1,
        cues: job.cues || [],
      };
      return;
    }
```

and the streaming inner loop:

```js
      while (nextChunk < status.chunks_completed) {
        const info = status.chunks?.find((c) => c.index === nextChunk);
        const cached = info ? chunkCache.get(voice, info.hash) : null;
        let audio;
        let cues = info?.cues || [];
        if (info?.source === "client_cache" && cached) {
          audio = cached.blob;
          // The server never synthesized this chunk, so its cues came from the
          // heuristic. The cached ones may be the server's real timings.
          if (cached.cues.length) cues = cached.cues;
        } else {
          audio = await fetchAudio(settings, `/api/tts/audio/${job.job_id}/${nextChunk}`, signal);
          if (info) chunkCache.set(voice, info.hash, audio, cues);
        }
        yield { audio, index: nextChunk, total: status.chunks_total, cues };
        nextChunk += 1;
      }
```

- [ ] **Step 4: Run to verify passing**

Run: `cd extension && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/lib/adapters/backend.js extension/lib/adapters/backend.test.js
git commit -m "Yield per-chunk cues from the backend adapter"
```

---

### Task 7: Direct adapter cues via captioned speech

**Files:**
- Create: `extension/lib/audio-duration.js`
- Modify: `extension/lib/adapters/openai.js:117-176`
- Test: `extension/lib/adapters/openai.test.js`

**Interfaces:**
- Consumes: `cuesForChunk` (Task 4), `chunkCache.get/set` (Task 5).
- Produces: `openaiAdapter.synthesize()` yields `{audio, index, total, cues}`.
- Produces: `measureDuration(blob: Blob) => Promise<number>` from `/lib/audio-duration.js`.

- [ ] **Step 1: Write the failing tests**

Add to `extension/lib/adapters/openai.test.js`:

```js
const directSettings = { directUrl: "http://localhost:8880", directModel: "kokoro" };

function captionedResponse(timestamps) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ audio: btoa("audio"), timestamps }),
  };
}

it("uses captioned speech timestamps for cues", async () => {
  globalThis.fetch = vi.fn(async (url) => {
    expect(url).toContain("/dev/captioned_speech");
    return captionedResponse([
      { word: "Hello", start_time: 0, end_time: 0.5 },
      { word: "there", start_time: 0.5, end_time: 1 },
    ]);
  });

  const items = await collect(
    openaiAdapter.synthesize({
      text: "Hello there",
      voice: "af_heart",
      settings: directSettings,
      signal: new AbortController().signal,
      onProgress: () => {},
    }),
  );

  expect(items[0].cues.map((c) => c.text)).toEqual(["Hello", "there"]);
  expect(items[0].cues[0].start).toBe(0);
});

it("falls back to /v1/audio/speech when captioned speech is not implemented", async () => {
  const seen = [];
  globalThis.fetch = vi.fn(async (url) => {
    seen.push(url);
    if (url.includes("/dev/captioned_speech")) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, blob: async () => new Blob(["audio"], { type: "audio/mpeg" }) };
  });

  const items = await collect(
    openaiAdapter.synthesize({
      text: "Hello there",
      voice: "af_heart",
      settings: directSettings,
      signal: new AbortController().signal,
      onProgress: () => {},
    }),
  );

  expect(seen.some((url) => url.includes("/dev/captioned_speech"))).toBe(true);
  expect(seen.some((url) => url.includes("/v1/audio/speech"))).toBe(true);
  expect(items[0].cues.map((c) => c.text)).toEqual(["Hello", "there"]);
});
```

Note: the fallback path measures the blob's duration, which jsdom cannot do. Mock it at the top of the file:

```js
vi.mock("/lib/audio-duration.js", () => ({ measureDuration: async () => 2 }));
```

- [ ] **Step 2: Run to verify failure**

Run: `cd extension && npm test -- adapters/openai`
Expected: FAIL — no request to `/dev/captioned_speech`, yielded items have no `cues`.

- [ ] **Step 3: Write `audio-duration.js`**

Create `extension/lib/audio-duration.js`:

```js
/**
 * Playback duration of an audio blob, in seconds.
 *
 * The direct TTS server reports no duration, but the character-count cue
 * heuristic needs one. Resolves to 0 if the metadata never loads, which makes
 * every cue in that chunk zero-length -- no highlight rather than a wrong one.
 */
export function measureDuration(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio();
    const finish = (duration) => {
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(duration) ? duration : 0);
    };
    audio.onloadedmetadata = () => finish(audio.duration);
    audio.onerror = () => finish(0);
    audio.src = url;
  });
}
```

- [ ] **Step 4: Add captioned speech to the direct adapter**

In `extension/lib/adapters/openai.js`, add imports and the session flag:

```js
import { chunkCache } from "/lib/chunk-cache.js";
import { chunkText } from "/lib/chunker.js";
import { sha256Hex } from "/lib/hash.js";
import { measureDuration } from "/lib/audio-duration.js";
import { cuesForChunk } from "/lib/reading-cues.js";

/**
 * Whether this server implements Kokoro-FastAPI's non-OpenAI
 * /dev/captioned_speech. A 404 flips it off for the rest of the session, so
 * later chunks skip a request that will only fail again. Mirrors
 * TtsClient._captions_supported in the backend.
 */
let captionsSupported = true;
```

Replace `synthesize` with:

```js
  async *synthesize({ text, voice, settings, signal, onProgress }) {
    const chunks = chunkText(text, MAX_INPUT_CHARS);
    const total = chunks.length;
    onProgress({ chunksCompleted: 0, chunksTotal: total, progress: 0 });

    for (let index = 0; index < total; index++) {
      const hash = await sha256Hex(chunks[index]);
      const cached = chunkCache.get(voice, hash);
      let audio;
      let cues;
      if (cached) {
        ({ blob: audio, cues } = cached);
      } else {
        const result = await requestChunk(chunks[index], voice, settings, signal);
        audio = result.audio;
        cues = cuesForChunk(
          chunks[index],
          result.timestamps ? result.duration : await measureDuration(audio),
          result.timestamps,
        );
        chunkCache.set(voice, hash, audio, cues);
      }
      onProgress({
        chunksCompleted: index + 1,
        chunksTotal: total,
        progress: (index + 1) / total,
      });
      yield { audio, index, total, cues };
    }
  },
```

The captioned response carries no duration either, so derive one from the last timestamp — that is what `cuesFromTimestamps` snaps the final cue's end to:

```js
/**
 * Synthesize one chunk, preferring Kokoro's /dev/captioned_speech so the cues
 * get real per-word timings. Returns the audio plus timestamps and a duration
 * derived from them, or timestamps: null when the server has no such endpoint.
 */
async function requestChunk(input, voice, settings, signal) {
  if (captionsSupported) {
    const captioned = await requestCaptioned(input, voice, settings, signal);
    if (captioned) return captioned;
  }
  return { audio: await requestSpeech(input, voice, settings, signal), timestamps: null, duration: 0 };
}

async function requestCaptioned(input, voice, settings, signal) {
  const response = await fetch(`${settings.directUrl}/dev/captioned_speech`, {
    method: "POST",
    headers: headers(settings, { "Content-Type": "application/json" }),
    body: JSON.stringify({
      model: settings.directModel || "kokoro",
      input,
      voice,
      response_format: "mp3",
      stream: false,
      return_timestamps: true,
    }),
    signal,
  });

  if (response.status === 404) {
    captionsSupported = false;
    return null;
  }
  if (!response.ok) throw new Error(await describeError(response));

  const data = await response.json();
  const timestamps = (data.timestamps || []).map((item) => ({
    word: item.word,
    start: item.start_time,
    end: item.end_time,
  }));
  if (!timestamps.length) return null;

  return {
    audio: base64ToBlob(data.audio),
    timestamps,
    duration: timestamps[timestamps.length - 1].end,
  };
}

function base64ToBlob(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: "audio/mpeg" });
}
```

Rename the existing `requestChunk` (the retrying `/v1/audio/speech` caller) to `requestSpeech`, leaving its body and retry logic unchanged.

- [ ] **Step 5: Reset the session flag between tests**

`captionsSupported` is module state, so a 404 in one test would disable captioned speech for every test after it. Reset the module registry and import the adapter per test rather than adding a production-code test hook.

Add to the `beforeEach` in `openai.test.js`:

```js
  vi.resetModules();
```

Remove the top-level `import { openaiAdapter } from "./openai.js";` and open each direct-adapter test with:

```js
  const { openaiAdapter } = await import("./openai.js");
```

The `pickAdapter` tests at the top of `backend.test.js` compare adapter identity and must keep their static import — they are in a different file and are unaffected.

- [ ] **Step 6: Run to verify passing**

Run: `cd extension && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add extension/lib/audio-duration.js extension/lib/adapters/openai.js extension/lib/adapters/openai.test.js
git commit -m "Compute direct-mode cues from Kokoro captioned speech"
```

---

### Task 8: Player exposes playback position

**Files:**
- Modify: `extension/lib/player.js:8-98`
- Test: `extension/lib/player.test.js`

**Interfaces:**
- Produces: `player.currentChunkIndex: number` (-1 when idle) and `player.currentTime: number`. Task 11 consumes both.

- [ ] **Step 1: Write the failing test**

Add to `extension/lib/player.test.js`:

```js
it("reports the index of the chunk being played", async () => {
  const audio = fakeAudio();
  const player = createPlayer({ audioElement: audio });
  expect(player.currentChunkIndex).toBe(-1);

  const seen = [];
  const generator = (async function* () {
    yield { audio: new Blob(["a"]), index: 0, total: 2, cues: [] };
    seen.push(player.currentChunkIndex);
    yield { audio: new Blob(["b"]), index: 1, total: 2, cues: [] };
    seen.push(player.currentChunkIndex);
  })();

  await player.play(generator);

  expect(seen[0]).toBe(0);
  expect(player.currentChunkIndex).toBe(-1);
});

it("reports the current time of the playing chunk", async () => {
  const audio = fakeAudio();
  audio.currentTime = 1.25;
  const player = createPlayer({ audioElement: audio });

  expect(player.currentTime).toBe(1.25);
});
```

Reuse whatever `fakeAudio()` helper `player.test.js` already defines for its existing tests; if it is inline, extract it to a helper at the top of the file first.

- [ ] **Step 2: Run to verify failure**

Run: `cd extension && npm test -- player`
Expected: FAIL — `player.currentChunkIndex` is undefined.

- [ ] **Step 3: Track and expose the position**

In `extension/lib/player.js`, add `let chunkIndex = -1;` beside the other state, set it in the play loop, reset it in `teardown`, and add the two getters:

```js
        while (!stopped) {
          const { value, done } = await pending;
          if (done || stopped) break;
          pending = iterator.next();
          chunkIndex = value.index;
          await playBlob(value.audio);
        }
```

```js
  function teardown() {
    audio.onended = null;
    audio.onerror = null;
    settleCurrent = null;
    releaseUrl();
    chunkIndex = -1;
    phase = "idle";
  }
```

```js
    /** Index of the chunk currently playing, or -1 when idle. */
    get currentChunkIndex() {
      return chunkIndex;
    },

    /** Playback position within the current chunk, in seconds. */
    get currentTime() {
      return audio.currentTime;
    },
```

- [ ] **Step 4: Run to verify passing and commit**

Run: `cd extension && npm test`
Expected: PASS.

```bash
git add extension/lib/player.js extension/lib/player.test.js
git commit -m "Expose playback position from the extension player"
```

---

### Task 9: Live-DOM word index in the content script

**Files:**
- Create: `extension/content-reader.js`
- Create: `extension/tests/load-script.js`
- Test: `extension/content-reader.test.js`
- Modify: `extension/package.json` (add `jsdom` devDependency)
- Delete: `extension/content.js`

**Interfaces:**
- Produces: `window.__readaloud.buildIndex({fromSelection}) => {title, text, wordCount, startWordIndex} | null`. Task 11 consumes it.
- Produces: `window.__readaloud.words` — internal `{text, node, start, end, breakBefore}[]`, never serialized across the messaging boundary.

- [ ] **Step 1: Add jsdom**

```bash
cd extension && npm install --save-dev --save-exact jsdom@27.0.0
```

Check the current stable version first with `npm view jsdom version` and pin that exact value rather than the one written here.

- [ ] **Step 2: Write the script loader helper**

Create `extension/tests/load-script.js`:

```js
import { readFileSync } from "node:fs";

/**
 * Evaluate a plain (non-module) extension script in the global scope, the way
 * tabs.executeScript does. Readability.js and content-reader.js cannot be
 * imported: executeScript has no module support, so neither file has ES
 * exports.
 *
 * @param {string} relativePath Path relative to the extension root.
 * @param {string[]} exposeNames Top-level names to publish on globalThis.
 */
export function loadScript(relativePath, exposeNames = []) {
  const source = readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
  const tail = exposeNames.map((name) => `globalThis[${JSON.stringify(name)}] = ${name};`).join("");
  // eslint-disable-next-line no-new-func
  new Function(`${source}\n;${tail}`).call(globalThis);
}
```

- [ ] **Step 3: Write the failing tests**

Create `extension/content-reader.test.js`:

```js
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadScript } from "/tests/load-script.js";

// Readability needs ~500 characters of article text before it will parse.
const PARAGRAPH =
  "Local text to speech has become practical on ordinary hardware in the last " +
  "year, and the models are now small enough to run beside a browser without " +
  "a dedicated graphics card or a paid API subscription of any kind at all.";

function pageWith(bodyHtml) {
  document.body.innerHTML = bodyHtml;
}

function article(extra = "") {
  return `
    <nav><a href="/">Home</a><a href="/about">About</a></nav>
    <article>
      <p id="p1">${PARAGRAPH}</p>
      <p id="p2">${PARAGRAPH}</p>
      ${extra}
    </article>
    <footer><p>Copyright notice that is not part of the article body.</p></footer>
  `;
}

beforeEach(() => {
  globalThis.browser = { runtime: { onMessage: { addListener: vi.fn() } } };
  delete window.__readaloud;
  loadScript("Readability.js", ["Readability"]);
  loadScript("content-reader.js");
});

describe("buildIndex", () => {
  it("returns the article text and a word per index entry", () => {
    pageWith(article());

    const result = window.__readaloud.buildIndex();

    expect(result.text).toContain("Local text to speech");
    expect(result.wordCount).toBe(result.text.split(/\s+/).filter(Boolean).length);
  });

  it("separates paragraphs with a blank line", () => {
    pageWith(article());

    const { text } = window.__readaloud.buildIndex();

    expect(text).toContain("at all.\n\nLocal text");
  });

  it("excludes navigation and footer text Readability dropped", () => {
    pageWith(article());

    const { text } = window.__readaloud.buildIndex();

    expect(text).not.toContain("Copyright notice");
    expect(text).not.toContain("Home");
  });

  it("leaves no stamp attributes on the page", () => {
    pageWith(article());

    window.__readaloud.buildIndex();

    expect(document.querySelectorAll("[data-ra-id]")).toHaveLength(0);
  });

  it("maps each word to a range over the live text node", () => {
    pageWith(article());

    window.__readaloud.buildIndex();
    const first = window.__readaloud.words[0];

    expect(first.text).toBe("Local");
    expect(first.node.parentElement.id).toBe("p1");
    expect(first.node.data.slice(first.start, first.end)).toBe("Local");
  });

  it("is idempotent under repeated injection", () => {
    pageWith(article());
    window.__readaloud.buildIndex();
    const before = window.__readaloud.words.length;

    loadScript("content-reader.js");

    expect(window.__readaloud.words.length).toBe(before);
  });

  it("returns null when nothing can be extracted", () => {
    pageWith("<p>too short</p>");

    expect(window.__readaloud.buildIndex()).toBeNull();
  });
});

describe("buildIndex from a selection", () => {
  it("starts at the first word the selection touches", () => {
    pageWith(article());
    window.__readaloud.buildIndex();
    const target = window.__readaloud.words.find((word) => word.node.parentElement.id === "p2");

    const range = document.createRange();
    range.setStart(target.node, target.start);
    range.setEnd(target.node, target.end);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);

    const result = window.__readaloud.buildIndex({ fromSelection: true });

    expect(result.text.startsWith("Local text to speech")).toBe(true);
    expect(result.startWordIndex).toBeGreaterThan(0);
    expect(result.wordCount).toBe(window.__readaloud.words.length - result.startWordIndex);
  });
});
```

- [ ] **Step 4: Run to verify failure**

Run: `cd extension && npm test -- content-reader`
Expected: FAIL — `extension/content-reader.js` does not exist.

- [ ] **Step 5: Write the index-building half of `content-reader.js`**

Create `extension/content-reader.js`. (Task 10 adds the highlighting half to the same file; write only what is below for now.)

```js
"use strict";

// Injected by background.js via tabs.executeScript, after Readability.js.
//
// Extraction and DOM mapping happen in one pass so cue N maps to word N by
// construction: every element is stamped, Readability runs on a clone (which
// keeps data-* attributes), and the live document is then walked keeping only
// text under elements that survived. The text sent for synthesis is built from
// that same walk, so the backend's word splitting reproduces this sequence.
(function () {
  if (window.__readaloud) return;

  const STAMP = "data-ra-id";
  const MAX_CHARS = 50_000;
  const BLOCK_TAGS = new Set([
    "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DIV", "DT", "FIGCAPTION", "H1",
    "H2", "H3", "H4", "H5", "H6", "LI", "MAIN", "P", "PRE", "SECTION", "TD",
    "TH", "TR",
  ]);

  const state = { words: [] };

  function stampAll() {
    let next = 0;
    for (const element of document.querySelectorAll("*")) {
      element.setAttribute(STAMP, String(next++));
    }
  }

  function unstampAll() {
    for (const element of document.querySelectorAll(`[${STAMP}]`)) {
      element.removeAttribute(STAMP);
    }
  }

  /**
   * Run Readability on a stamped clone and return the stamps that survived,
   * or null if the page has no extractable article.
   */
  function parseArticle() {
    const clone = document.cloneNode(true);
    const article = new Readability(clone, { serializer: (el) => el }).parse();
    if (!article || !article.content) return null;

    const ids = new Set();
    if (article.content.hasAttribute(STAMP)) ids.add(article.content.getAttribute(STAMP));
    for (const element of article.content.querySelectorAll(`[${STAMP}]`)) {
      ids.add(element.getAttribute(STAMP));
    }
    return { ids, title: article.title };
  }

  /**
   * Readability creates elements of its own (converting <br> runs to
   * paragraphs, for one), and those carry no stamp -- but their ancestors do,
   * so the nearest stamped ancestor is what decides whether text was kept.
   */
  function nearestStamped(node) {
    let element = node.parentElement;
    while (element && !element.hasAttribute(STAMP)) element = element.parentElement;
    return element;
  }

  function nearestBlock(node) {
    let element = node.parentElement;
    while (element && !BLOCK_TAGS.has(element.tagName)) element = element.parentElement;
    return element || document.body;
  }

  function collectWords(ids) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const words = [];
    let lastBlock = null;
    let chars = 0;

    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const stamped = nearestStamped(node);
      if (!stamped || !ids.has(stamped.getAttribute(STAMP))) continue;

      const block = nearestBlock(node);
      for (const match of node.data.matchAll(/\S+/g)) {
        const breakBefore = words.length > 0 && block !== lastBlock;
        const separator = words.length === 0 ? 0 : breakBefore ? 2 : 1;
        // Truncate on a word boundary: a partial last word would shift every
        // cue after it.
        if (chars + separator + match[0].length > MAX_CHARS) return words;
        chars += separator + match[0].length;
        words.push({
          text: match[0],
          node,
          start: match.index,
          end: match.index + match[0].length,
          breakBefore,
        });
        lastBlock = block;
      }
    }
    return words;
  }

  function joinWords(words, from) {
    let text = "";
    for (let index = from; index < words.length; index++) {
      if (index > from) text += words[index].breakBefore ? "\n\n" : " ";
      text += words[index].text;
    }
    return text;
  }

  function rangeFor(word) {
    if (!word || !word.node.isConnected) return null;
    const range = document.createRange();
    range.setStart(word.node, word.start);
    range.setEnd(word.node, word.end);
    return range;
  }

  /** Index of the first word the selection touches, or 0 if there is none. */
  function selectionStartIndex(words) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return 0;

    const selected = selection.getRangeAt(0);
    for (let index = 0; index < words.length; index++) {
      const range = rangeFor(words[index]);
      // END_TO_START compares the selection's start against the word's end:
      // negative means this word is still running when the selection begins.
      if (range && selected.compareBoundaryPoints(Range.END_TO_START, range) < 0) {
        return index;
      }
    }
    return 0;
  }

  window.__readaloud = {
    get words() {
      return state.words;
    },

    /**
     * Extract the article and index its words against the live DOM.
     *
     * @param {{fromSelection?: boolean}} options When fromSelection is true,
     *   the returned text starts at the first word the current selection
     *   touches.
     * @returns {{title: string, text: string, wordCount: number,
     *   startWordIndex: number} | null} Null when nothing was extractable.
     */
    buildIndex({ fromSelection = false } = {}) {
      stampAll();
      try {
        const parsed = parseArticle();
        if (!parsed) return null;

        const words = collectWords(parsed.ids);
        if (!words.length) return null;
        state.words = words;

        const startWordIndex = fromSelection ? selectionStartIndex(words) : 0;
        return {
          title: parsed.title,
          text: joinWords(words, startWordIndex),
          wordCount: words.length - startWordIndex,
          startWordIndex,
        };
      } finally {
        unstampAll();
      }
    },
  };
})();
```

- [ ] **Step 6: Run to verify passing**

Run: `cd extension && npm test -- content-reader`
Expected: PASS.

If `parseArticle` returns null for the fixtures, the fixture text is under Readability's 500-character threshold — lengthen `PARAGRAPH` rather than lowering the threshold, since production uses the default.

- [ ] **Step 7: Delete the old extractor and commit**

`content.js` is fully replaced by `content-reader.js`. Its only caller, `extractArticleText` in `background.js`, is rewritten in Task 11; delete the file now so nothing reads from two extractors.

```bash
cd /mnt/c/Users/david/Projects/CAT_AI/ReadAloud && trash extension/content.js
git add -A extension/content-reader.js extension/content-reader.test.js extension/tests/load-script.js extension/package.json extension/package-lock.json extension/content.js
git commit -m "Index article words against the live DOM in the content script"
```

---

### Task 10: Highlight rendering and the tab message API

**Files:**
- Modify: `extension/content-reader.js`
- Test: `extension/content-reader.test.js`

**Interfaces:**
- Consumes: `state.words` and `rangeFor` from Task 9.
- Produces: tab messages `{type: "readaloudHighlight", index}` and `{type: "readaloudClear"}`. Task 11 sends both.

- [ ] **Step 1: Write the failing tests**

jsdom implements neither `CSS.highlights` nor `Highlight`, so stub both and assert against the stub. Add to `extension/content-reader.test.js`:

```js
function stubHighlightApi() {
  const registry = new Map();
  globalThis.Highlight = class {
    constructor(...ranges) {
      this.ranges = ranges;
    }
  };
  globalThis.CSS = { highlights: registry };
  return registry;
}

describe("highlighting", () => {
  it("registers a range around the requested word", () => {
    const registry = stubHighlightApi();
    pageWith(article());
    window.__readaloud.buildIndex();

    window.__readaloud.highlight(1);

    const highlight = registry.get("readaloud-word");
    expect(highlight.ranges[0].toString()).toBe(window.__readaloud.words[1].text);
  });

  it("injects the highlight stylesheet once", () => {
    stubHighlightApi();
    pageWith(article());
    window.__readaloud.buildIndex();

    window.__readaloud.highlight(0);
    window.__readaloud.highlight(1);

    expect(document.querySelectorAll("#readaloud-highlight-style")).toHaveLength(1);
  });

  it("ignores a word whose node has been removed from the page", () => {
    const registry = stubHighlightApi();
    pageWith(article());
    window.__readaloud.buildIndex();
    document.getElementById("p1").remove();

    expect(() => window.__readaloud.highlight(0)).not.toThrow();
    expect(registry.has("readaloud-word")).toBe(false);
  });

  it("ignores an out-of-range index", () => {
    const registry = stubHighlightApi();
    pageWith(article());
    window.__readaloud.buildIndex();

    expect(() => window.__readaloud.highlight(99999)).not.toThrow();
    expect(registry.has("readaloud-word")).toBe(false);
  });

  it("clear removes the highlight and the stylesheet", () => {
    const registry = stubHighlightApi();
    pageWith(article());
    window.__readaloud.buildIndex();
    window.__readaloud.highlight(0);

    window.__readaloud.clear();

    expect(registry.has("readaloud-word")).toBe(false);
    expect(document.querySelector("#readaloud-highlight-style")).toBeNull();
  });
});

describe("message API", () => {
  it("registers a runtime message listener on injection", () => {
    expect(globalThis.browser.runtime.onMessage.addListener).toHaveBeenCalled();
  });

  it("highlights on a readaloudHighlight message", () => {
    const registry = stubHighlightApi();
    pageWith(article());
    window.__readaloud.buildIndex();
    const listener = globalThis.browser.runtime.onMessage.addListener.mock.calls[0][0];

    listener({ type: "readaloudHighlight", index: 2 });

    expect(registry.get("readaloud-word").ranges[0].toString()).toBe(
      window.__readaloud.words[2].text,
    );
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd extension && npm test -- content-reader`
Expected: FAIL — `window.__readaloud.highlight` is not a function.

- [ ] **Step 3: Add highlighting to `content-reader.js`**

Add the constants beside the existing ones:

```js
  const HIGHLIGHT_NAME = "readaloud-word";
  const STYLE_ID = "readaloud-highlight-style";
```

Add these functions before the `window.__readaloud` assignment:

```js
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `::highlight(${HIGHLIGHT_NAME}) { background-color: #ffd54f; color: #000; }`;
    document.head.appendChild(style);
  }

  function removeStyle() {
    document.getElementById(STYLE_ID)?.remove();
  }

  /** Scroll only when the word has left the viewport, matching ReadingText.tsx. */
  function scrollIfNeeded(range) {
    const rect = range.getBoundingClientRect();
    if (rect.top >= 0 && rect.bottom <= window.innerHeight) return;
    range.startContainer.parentElement?.scrollIntoView({ block: "nearest" });
  }
```

and the two new methods on `window.__readaloud`:

```js
    /** Highlight word `index` of the current index, if it is still on the page. */
    highlight(index) {
      const range = rangeFor(state.words[index]);
      if (!range) return;
      ensureStyle();
      CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(range));
      scrollIfNeeded(range);
    },

    /** Remove the highlight and the stylesheet it needed. */
    clear() {
      CSS.highlights.delete(HIGHLIGHT_NAME);
      removeStyle();
    },
```

Register the listener at the end of the IIFE, after the assignment:

```js
  browser.runtime.onMessage.addListener((message) => {
    if (message.type === "readaloudHighlight") window.__readaloud.highlight(message.index);
    else if (message.type === "readaloudClear") window.__readaloud.clear();
  });
```

- [ ] **Step 4: Run to verify passing and commit**

Run: `cd extension && npm test`
Expected: PASS.

```bash
git add extension/content-reader.js extension/content-reader.test.js
git commit -m "Highlight the spoken word in the page via CSS.highlights"
```

---

### Task 11: Background orchestration

**Files:**
- Modify: `extension/background.js:1-9, 45-51, 67-83, 85-133, 135-189, 268-277`
- Delete: `extension/lib/read-from-here.js`, `extension/lib/read-from-here.test.js`
- Test: `extension/background.test.js` (new)

**Interfaces:**
- Consumes: `findActiveCueIndex` (Task 4), `chunkCache.get().blob` (Task 5), adapter `{audio, index, total, cues}` (Tasks 6-7), `player.currentChunkIndex` / `player.currentTime` (Task 8), `window.__readaloud.buildIndex` (Task 9), the tab message types (Task 10).

- [ ] **Step 1: Write the failing tests**

`background.js` runs on import and needs `browser` globals. Create `extension/background.test.js`:

```js
import { beforeEach, describe, expect, it, vi } from "vitest";

import { chunkCache } from "/lib/chunk-cache.js";

function fakeBrowser() {
  return {
    runtime: { sendMessage: vi.fn(async () => {}), onMessage: { addListener: vi.fn() } },
    contextMenus: { create: vi.fn(), onClicked: { addListener: vi.fn() } },
    tabs: {
      query: vi.fn(async () => [{ id: 7, url: "https://example.com" }]),
      executeScript: vi.fn(),
      sendMessage: vi.fn(async () => {}),
    },
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  chunkCache.clear();
  globalThis.browser = fakeBrowser();
  globalThis.Audio = class {
    constructor() {
      this.currentTime = 0;
      this.playbackRate = 1;
    }
    play() {
      return Promise.resolve();
    }
    pause() {}
  };
});

describe("highlight orchestration", () => {
  it("sends the global word index for the active cue", async () => {
    const { __testing } = await import("/background.js");
    __testing.startHighlighting({ tabId: 7, wordOffset: 0, wordCount: 4 });
    __testing.recordChunkCues({ index: 0, cues: [
      { text: "one", start: 0, end: 1 },
      { text: "two", start: 1, end: 2 },
    ] });
    __testing.recordChunkCues({ index: 1, cues: [
      { text: "three", start: 0, end: 1 },
      { text: "four", start: 1, end: 2 },
    ] });

    __testing.setPosition(1, 1.5);
    __testing.highlightTick();

    expect(browser.tabs.sendMessage).toHaveBeenCalledWith(7, {
      type: "readaloudHighlight",
      index: 3,
    });
  });

  it("sends nothing when the active word has not changed", async () => {
    const { __testing } = await import("/background.js");
    __testing.startHighlighting({ tabId: 7, wordOffset: 0, wordCount: 2 });
    __testing.recordChunkCues({ index: 0, cues: [{ text: "one", start: 0, end: 1 }] });

    __testing.setPosition(0, 0.5);
    __testing.highlightTick();
    __testing.highlightTick();

    expect(browser.tabs.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("offsets by the read-from-here start word", async () => {
    const { __testing } = await import("/background.js");
    __testing.startHighlighting({ tabId: 7, wordOffset: 10, wordCount: 1 });
    __testing.recordChunkCues({ index: 0, cues: [{ text: "one", start: 0, end: 1 }] });

    __testing.setPosition(0, 0.5);
    __testing.highlightTick();

    expect(browser.tabs.sendMessage).toHaveBeenCalledWith(7, {
      type: "readaloudHighlight",
      index: 10,
    });
  });

  it("disables highlighting when a chunk yields no cues", async () => {
    const { __testing } = await import("/background.js");
    __testing.startHighlighting({ tabId: 7, wordOffset: 0, wordCount: 2 });
    __testing.recordChunkCues({ index: 0, cues: [] });

    __testing.setPosition(0, 0.5);
    __testing.highlightTick();

    expect(browser.tabs.sendMessage).not.toHaveBeenCalledWith(
      7,
      expect.objectContaining({ type: "readaloudHighlight" }),
    );
  });

  it("disables highlighting when the cue count overruns the word count", async () => {
    const { __testing } = await import("/background.js");
    __testing.startHighlighting({ tabId: 7, wordOffset: 0, wordCount: 1 });
    __testing.recordChunkCues({ index: 0, cues: [
      { text: "one", start: 0, end: 1 },
      { text: "two", start: 1, end: 2 },
    ] });

    __testing.setPosition(0, 0.5);
    __testing.highlightTick();

    expect(browser.tabs.sendMessage).not.toHaveBeenCalledWith(
      7,
      expect.objectContaining({ type: "readaloudHighlight" }),
    );
  });

  it("clears the highlight when stopping", async () => {
    const { __testing } = await import("/background.js");
    __testing.startHighlighting({ tabId: 7, wordOffset: 0, wordCount: 1 });

    __testing.stopHighlighting();

    expect(browser.tabs.sendMessage).toHaveBeenCalledWith(7, { type: "readaloudClear" });
  });
});
```

`__testing.setPosition(chunkIndex, time)` swaps in a stub standing in for the player's two position getters; Step 3 implements it along with the rest of the `__testing` export.

- [ ] **Step 2: Run to verify failure**

Run: `cd extension && npm test -- background`
Expected: FAIL — `/background.js` exports no `__testing`.

- [ ] **Step 3: Add the highlight state and tick**

In `extension/background.js`, replace the `sliceFromArticle` import with the cue lookup:

```js
import { findActiveCueIndex } from "/lib/cues.js";
```

Add beside the existing `state` object:

```js
const HIGHLIGHT_INTERVAL_MS = 100;

/**
 * Word-highlight state for the current read. `cueChunks[i]` holds chunk i's
 * chunk-relative cues and `chunkOffsets[i]` how many words precede it, so a
 * (chunk, time) position resolves to one index into the tab's word list.
 * `enabled` goes false the moment the cues stop lining up with the indexed
 * words -- audio keeps playing, the highlight just stops.
 */
const highlight = {
  tabId: null,
  enabled: false,
  wordOffset: 0,
  wordCount: 0,
  cueChunks: [],
  chunkOffsets: [],
  activeIndex: null,
  timer: null,
};
let activePlayer = player;
```

Add the orchestration functions:

```js
function startHighlighting({ tabId, wordOffset, wordCount }) {
  highlight.tabId = tabId;
  highlight.enabled = true;
  highlight.wordOffset = wordOffset;
  highlight.wordCount = wordCount;
  highlight.cueChunks = [];
  highlight.chunkOffsets = [];
  highlight.activeIndex = null;
  highlight.timer = setInterval(highlightTick, HIGHLIGHT_INTERVAL_MS);
}

function stopHighlighting() {
  if (highlight.timer !== null) clearInterval(highlight.timer);
  highlight.timer = null;
  if (highlight.tabId !== null) {
    browser.tabs.sendMessage(highlight.tabId, { type: "readaloudClear" }).catch(() => {});
  }
  highlight.tabId = null;
  highlight.enabled = false;
  highlight.activeIndex = null;
}

/** Record a chunk's cues as it is yielded, and check they still line up. */
function recordChunkCues({ index, cues }) {
  highlight.cueChunks[index] = cues || [];
  highlight.chunkOffsets[index] =
    index === 0
      ? 0
      : (highlight.chunkOffsets[index - 1] || 0) + (highlight.cueChunks[index - 1]?.length || 0);

  const total = highlight.chunkOffsets[index] + highlight.cueChunks[index].length;
  if (highlight.cueChunks[index].length === 0 || total > highlight.wordCount) {
    highlight.enabled = false;
  }
}

function highlightTick() {
  if (!highlight.enabled || highlight.tabId === null) return;
  const chunk = activePlayer.currentChunkIndex;
  const cues = highlight.cueChunks[chunk];
  if (!cues) return;

  const local = findActiveCueIndex(cues, activePlayer.currentTime);
  if (local === null) return;

  const index = highlight.wordOffset + highlight.chunkOffsets[chunk] + local;
  if (index === highlight.activeIndex) return;
  highlight.activeIndex = index;
  browser.tabs
    .sendMessage(highlight.tabId, { type: "readaloudHighlight", index })
    .catch(() => {});
}

/** Pass chunks through to the player while recording their cues. */
async function* captureCues(generator) {
  for await (const item of generator) {
    recordChunkCues(item);
    yield item;
  }
}

export const __testing = {
  startHighlighting,
  stopHighlighting,
  recordChunkCues,
  highlightTick,
  setPosition(currentChunkIndex, currentTime) {
    activePlayer = { currentChunkIndex, currentTime };
  },
};
```

- [ ] **Step 4: Wire it into the read paths**

`stopAll` gains `stopHighlighting();` before `resetState()`.

`handleReadRequest` takes an optional highlight target and wraps the generator:

```js
async function handleReadRequest(text, voice, speed, highlightTarget = null) {
```

after `setPhase("playing")` is set up, replace `await player.play(generator)` with:

```js
    setPhase("playing");
    if (highlightTarget) startHighlighting(highlightTarget);
    await player.play(highlightTarget ? captureCues(generator) : generator);
```

and add `stopHighlighting();` to the `finally` block alongside `abortController = null;`.

Replace `extractArticleText` with:

```js
// Inject Readability.js first (defines the global), then the reader, then ask
// it to index the page. The word index stays in the tab -- only plain data
// crosses back.
async function buildPageIndex(tab, { fromSelection = false } = {}) {
  await browser.tabs.executeScript(tab.id, { file: "Readability.js" });
  await browser.tabs.executeScript(tab.id, { file: "content-reader.js" });
  const results = await browser.tabs.executeScript(tab.id, {
    code: `window.__readaloud.buildIndex({ fromSelection: ${fromSelection} })`,
  });
  const article = results && results[0];
  if (!article || !article.text || article.text.trim().length === 0) return null;
  return article;
}
```

`handleReadPage`'s try block becomes:

```js
    const article = await buildPageIndex(tab);
    if (!article) {
      setError("No article content could be extracted from this page");
      return;
    }

    await handleReadRequest(article.text, voice, speed, {
      tabId: tab.id,
      wordOffset: article.startWordIndex,
      wordCount: article.wordCount,
    });
```

`handleReadFromHere` drops its `selectionText` parameter entirely — the content script reads the live selection itself:

```js
async function handleReadFromHere(tab, voice, speed) {
  stopAll();
  setPhase("extracting");

  try {
    const article = await buildPageIndex(tab, { fromSelection: true });
    if (!article) {
      setError("No article content could be extracted from this page");
      return;
    }

    await handleReadRequest(article.text, voice, speed, {
      tabId: tab.id,
      wordOffset: article.startWordIndex,
      wordCount: article.wordCount,
    });
  } catch (err) {
    setError(`Extraction failed: ${err.message}`);
  }
}
```

Update its context-menu call site:

```js
  } else if (info.menuItemId === "readaloud-from-here" && info.selectionText && tab.id) {
    handleReadFromHere(tab, settings.defaultVoice, settings.defaultSpeed);
```

Update `buildKnownChunks` for the cache's new entry shape if Task 5 did not already:

```js
      const entry = chunkCache.get(voice, hash);
      if (entry) knownChunks.push({ hash, audioB64: await blobToBase64(entry.blob) });
```

- [ ] **Step 5: Delete the superseded slicer**

```bash
cd /mnt/c/Users/david/Projects/CAT_AI/ReadAloud
trash extension/lib/read-from-here.js extension/lib/read-from-here.test.js
```

- [ ] **Step 6: Run the full suite**

Run: `cd extension && npm test`
Expected: PASS, with no remaining references to `sliceFromArticle`. Confirm with:

Run: `rg -n "sliceFromArticle|read-from-here|content\.js" extension/`
Expected: no matches.

- [ ] **Step 7: Commit**

```bash
git add -A extension/background.js extension/background.test.js extension/lib/read-from-here.js extension/lib/read-from-here.test.js
git commit -m "Drive the in-page highlight from the background player"
```

---

### Task 12: Manifest version floor, manual verification, and docs

**Files:**
- Modify: `extension/manifest.json:29-34`
- Modify: `CLAUDE.md` — the Extension file list (around line 93) and the "Reading-highlight cues" flow (around line 70)

- [ ] **Step 1: Raise the Firefox version floor**

In `extension/manifest.json`:

```json
  "browser_specific_settings": {
    "gecko": {
      "id": "readaloud@yourdomain.com",
      "strict_min_version": "140.0"
    }
  }
```

- [ ] **Step 2: Verify end to end in Firefox**

Start the backend (`cd backend && uv run uvicorn readaloud.main:app --host 0.0.0.0 --port 8000`) with a Kokoro server reachable, then load the extension via `about:debugging#/runtime/this-firefox`.

Check each of these against a long article (one that chunks — over 4000 characters):

1. "Read Page" highlights words in place, in step with the audio, past the first chunk boundary.
2. The page auto-scrolls when the highlighted word leaves the viewport, and does not fight manual scrolling while the word stays visible.
3. Pause, resume, the ±15s skips, and stop all leave the highlight consistent with the audio; stop clears it.
4. "Read From Here" starts at the selected word and highlights from there.
5. Switching `ttsTarget` to direct against Kokoro still highlights (real timestamps); pointing it at a server without `/dev/captioned_speech` still highlights (heuristic).
6. "Read Selection" and a PDF both still play audio with no highlight and no console errors.
7. Reload the page mid-read: audio continues, the highlight stops, nothing throws.

- [ ] **Step 3: Update the project guide**

In `CLAUDE.md`, under the Extension section, add to the file list:

```
- `content-reader.js` — injected extractor: stamps the live DOM, runs Readability on a
  clone, and walks the live text nodes that survived, producing both the text to
  synthesize and a word index of live DOM ranges. Also owns the in-page highlight.
- `lib/reading-cues.js` — JS port of `reading_cues.py` for one chunk, used by the direct
  adapter; `lib/cues.js` finds the cue covering a playback time
- `lib/audio-duration.js` — measures a chunk blob's duration for the cue heuristic
```

and extend the reading-highlight section of the Key Data Flows:

```
**Reading-highlight cues:**
...existing text...
- `ChunkStatus.cues` carries each chunk's cues, chunk-relative, as soon as that chunk is
  synthesized — the extension plays chunks individually and needs timings before the job
  finishes. `TtsStatusResponse.cues` remains the stitched-timeline list the web frontend uses.
- In the extension, `content-reader.js` indexes article words to live DOM ranges, the
  background page polls the player every 100 ms and messages the tab, and the tab paints one
  word via the CSS Custom Highlight API. Highlighting covers "Read Page" and "Read From
  Here"; selections and PDFs play with audio only.
```

Also update the TTS Server Integration section to note that the direct adapter now probes `/dev/captioned_speech` itself.

- [ ] **Step 4: Commit**

```bash
git add extension/manifest.json CLAUDE.md
git commit -m "Require Firefox 140 and document the extension highlight"
```

---

## Self-Review Notes

Spec coverage checked section by section: stamp-and-walk (Task 9), rendering via `CSS.highlights` (Task 10), per-chunk backend cues and `_job_cues` removal (Task 2), the JS cue port (Task 4), `captioned_speech` in direct mode (Task 7), `chunk-cache` cues (Task 5), player position (Task 8), orchestration and the alignment guard (Task 11), `read-from-here.js` deletion (Task 11), the manifest floor (Task 12), the round-trip invariant (Task 3), and the timer probe (Task 1).

Names used consistently across tasks: `cuesForChunk`, `findActiveCueIndex`, `measureDuration`, `buildIndex`, `highlight`, `clear`, `recordChunkCues`, `startHighlighting`, `stopHighlighting`, `highlightTick`, `readaloudHighlight`, `readaloudClear`, `data-ra-id`, `readaloud-word`.
