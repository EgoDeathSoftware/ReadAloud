# Extension reading highlight — design

## Problem

The web frontend highlights the word being spoken (see
`2026-09-03-reading-highlight-design.md` and
`2026-09-04-real-word-timestamps-design.md`). The Firefox extension has no
equivalent: it reads a page aloud with no visual indication of position.

This adds a word-level highlight to the extension, drawn **on the live page
itself** — the words of the article highlight in place, in the page's own
layout, rather than in a separate reader panel.

## Scope

In scope:

- **Read Page** and **Read From Here** — both go through Readability
  extraction and share one extraction-and-mapping pass.
- Both TTS targets: the ReadAloud backend (`ttsTarget: "backend"`) and a
  directly-addressed OpenAI-compatible server (`ttsTarget: "direct"`).

Out of scope — these keep working, with audio only and no highlight:

- **Read Selection** (context menu and popup).
- PDFs, including Firefox's built-in `pdf.js` viewer.
- The web frontend's own highlight, whose API shape and behaviour are
  unchanged by this work.

No settings toggle for the highlight. Adding one is speculative until
someone reports the highlight as intrusive.

## Why in-page rather than an overlay panel

An injected reader overlay would be cheaper — essentially `ReadingText.tsx`
ported to vanilla JS, with no DOM mapping at all — but it replaces the page
the user chose to read with a stripped copy of it. Highlighting in place
keeps the page's own typography, images, and layout, which is the reason to
read in the browser rather than in the web frontend.

The cost is the mapping problem below, which is the substance of this
design.

## Constraints discovered in the existing code

Three properties of the current implementation shape everything else:

1. **Backend cues are job-final.** `_process_long_text` computes
   `job.cues` only after every chunk is synthesized
   (`routes/tts.py:132`). The extension, unlike the web frontend, plays
   chunk 0 while chunk 5 is still being synthesized, so a job-level cue
   list arrives far too late. (Short text, at or below
   `MAX_CHUNK_CHARS`, does return cues immediately on the generate
   response.)
2. **The player plays one blob per chunk** (`lib/player.js:23`), so
   `audio.currentTime` is chunk-relative, while job-level cue times are in
   the stitched audio's timeline.
3. **The direct adapter has no cue source.** It talks to the TTS server
   itself and never sees the backend's cue computation.

## Approach: stamp-and-walk

Cue *n* must resolve to a DOM `Range` around word *n* of the article. The
current extractor destroys that link: `content.js` clones the document,
runs Readability, and returns `article.textContent` — a flat string with no
correspondence to live nodes.

Rather than recovering the link afterwards by aligning two strings,
extraction and mapping become **one pass over the live DOM**, so alignment
holds by construction:

1. Stamp every element in the live document with a `data-ra-id` attribute.
2. `cloneNode(true)`, then
   `new Readability(clone, { serializer: (el) => el })` — the serializer
   option makes `article.content` the cleaned *element* instead of an HTML
   string. Readability strips `class` and presentational attributes but
   preserves `data-*`, so the surviving elements still carry their ids.
3. Collect the set of `data-ra-id` values present in Readability's output.
4. Walk the **live** document's text nodes in document order, keeping only
   those whose nearest stamped ancestor is in that set. This single walk
   emits both the text to synthesize and a parallel
   `words[] = {node, start, end}` array of live positions.
5. Remove every `data-ra-id`. The page's DOM is left as it was found.

Keying on the *nearest stamped ancestor* rather than on the text node's
immediate parent matters: Readability creates new elements (for example
when converting `<br>` runs into paragraphs), and those carry no id, but
their ancestors do.

### Rejected: post-hoc fuzzy alignment

Keeping today's extractor and separately aligning `article.textContent`
against a walk of the live page was considered and rejected. Readability's
`textContent` runs block elements together without a separator
(`"…end.Next paragraph"`), so the match is necessarily fuzzy, and its
failure mode is a highlight that drifts a few words off and stays there —
worse than no highlight, and hard to detect.

### Rejected: sentence-level anchors

Cheaper to map, but a highlighted paragraph-sized band is a visibly worse
feature than the word-level highlight the web frontend already has.

## Text-to-cue alignment invariant

The text handed to TTS is exactly `words` joined: single spaces within a
paragraph, `"\n\n"` where the nearest kept block ancestor changes. Both cue
paths split that text back into words on whitespace, with paragraphs on
`\n\n+`, so they reproduce the same sequence.

Chunking preserves it too: `chunkText` splits only on paragraph, sentence,
or word boundaries, so concatenating the chunks' words reproduces the
original sequence. Therefore word *n* of chunk *k* is global word
`Σ len(cues[0..k-1]) + n`.

Two guards, because everything downstream rests on this:

- A round-trip unit test asserting that chunking then re-splitting a text
  yields the original word sequence.
- A runtime check that total cues equal `words.length`. On mismatch, the
  read continues with **highlighting disabled** rather than highlighting
  the wrong words.

The 50k-character cap in the extractor truncates on a word boundary — it
drops whole entries from `words` — since a mid-word truncation would shift
every subsequent cue.

## Backend changes

### Per-chunk cues on `ChunkStatus`

`ChunkStatus` gains `cues: list[Cue]`, **chunk-relative**: each chunk's
first cue starts at 0.0.

In `_process_long_text`, each chunk's duration is computed inline from the
`audio` bytes already in hand — available in both the synthesized and the
`client_cache` branch — and its cues are attached as soon as the chunk
lands. The extension therefore receives real Kokoro word timings for chunk
0 while chunk 5 is still synthesizing.

### `_job_cues` is deleted

Job-level `cues` (in the stitched timeline, consumed by the web frontend)
becomes the per-chunk cues offset by cumulative duration. That is exactly
equivalent to today's result, because `compute_cues` already treats chunks
as independent.

So `_job_cues()` — which reads every chunk back off disk purely to
re-measure durations that were in memory moments earlier — is removed, not
kept alongside. One code path, no double computation, less I/O.

`TtsGenerateResponse` and the job-level `TtsStatusResponse.cues` keep their
current shape and values. The web frontend is untouched.

## Extension changes

### Adapters yield cues

Both adapters change their yielded shape from `{audio, index, total}` to
`{audio, index, total, cues}`, with chunk-relative cue times, keeping the
player target-agnostic:

- `lib/adapters/backend.js` — cues come from the generate response on the
  short-text path, and from `status.chunks[i].cues` on the streaming path.
- `lib/adapters/openai.js` — tries `POST /dev/captioned_speech` with
  `return_timestamps: true`, which returns base64 audio plus
  `{word, start_time, end_time}` entries. A 404 sets a session-scoped
  `captionsSupported = false` and falls back to today's
  `/v1/audio/speech`, mirroring `TtsClient._captions_supported`.

### `lib/reading-cues.js`

A JS port of single-chunk cue computation, mirroring `reading_cues.py` the
way `chunker.js` already mirrors `text_chunker.py`:
punctuation merging, the token-count and 80%-coverage trust checks,
negative-start clamping, and the character-count fallback.

`chunker.js` exports `splitSentences` — the `(?<=[.!?])\s+` regex it
already uses internally — so the fallback and the chunker share one
splitter, the same factoring `text_chunker.py` already did for
`reading_cues.py`.

### `lib/audio-duration.js`

The character-count fallback needs a chunk duration, which the direct
server does not report. Measures a blob via an `<audio>` element's
`loadedmetadata` event.

### `chunk-cache.js` caches cues with audio

Entries become `{blob, cues}`. Without this, a cache hit would silently
downgrade a chunk from real per-word timings to the heuristic on replay.

### `content-reader.js` (replacing `content.js`)

A plain, non-module script — `tabs.executeScript` cannot inject ES modules
— that is idempotent under repeated injection and keeps its state on
`window.__readaloud`. It implements the stamp-and-walk pass above and
exposes a message API to the background page:

- `buildIndex` → `{title, text, wordCount, startWordIndex?}`
- `highlightWord(index)`
- `clearHighlight`

### Highlight rendering

One `Range` around the active word, registered as
`CSS.highlights.set("readaloud-word", …)` and styled by an injected
`::highlight(readaloud-word)` rule. No DOM mutation, no reflow, and the
page's own CSS is untouched.

The API is Baseline as of June 2025, so `manifest.json`'s
`strict_min_version` moves from `109` to `140`. No new permissions:
`activeTab`, `<all_urls>`, and `tabs.executeScript` already cover this, and
`tabs.sendMessage` reaches an injected script without a `content_scripts`
declaration.

A word whose `node.isConnected` is false is skipped rather than
highlighted — an SPA may have re-rendered that part of the page mid-read.

Auto-scroll uses `scrollIntoView({ block: "nearest" })`, and only when the
word is outside the viewport — matching `ReadingText.tsx`.

### Orchestration

`lib/player.js` exposes `currentChunkIndex` and `currentTime`.
`background.js` polls at 100 ms, resolves the global word index by binary
search over the current chunk's cues, and calls `tabs.sendMessage` only
when the index changes — roughly three messages per second at normal
speech rate. Pause, resume, skip, and stop need no special handling; they
fall out of polling.

Navigating or closing the reading tab drops the highlight. Audio keeps
playing, as it does today.

### `lib/read-from-here.js` is deleted

The content script derives the starting word by comparing the live
selection's boundary points against the word ranges, and returns
`startWordIndex`; the background slices `words` from there.

This replaces `sliceFromArticle`'s whitespace-normalized string match,
which collapses paragraph breaks (so a "read from here" today loses the
paragraph structure the cue computation depends on) and silently picks the
first of several matches when the selected snippet repeats. The file and
its test are removed rather than left in place beside the replacement.

## Testing

Test-driven, per the repo's standards.

Backend:

- Per-chunk cues appear on `/api/tts/status/{id}` **before** the job
  completes.
- Job-level cues still equal today's stitched values — a regression guard
  on the offsetting that replaces `_job_cues`.
- A `client_cache`-sourced chunk still gets heuristic cues.

Extension:

- `lib/reading-cues.test.js` — ports the Python trust-check cases:
  punctuation merging, token-count mismatch falling back to the heuristic,
  sub-80% coverage falling back, negative-start clamping.
- `content-reader` tests under jsdom (a new devDependency, justified by
  the DOM-mapping logic being the riskiest part of this change) — kept-set
  filtering, paragraph-break emission, word-boundary truncation at the 50k
  cap, disconnected nodes skipped, and idempotent re-injection.
- The chunk round-trip invariant test described above.
- Adapter tests — cues plumbed through both the short-text and streaming
  backend paths, and the `captioned_speech` 404 fallback in direct mode.
- Player tests — `currentChunkIndex` and `currentTime` across chunk
  transitions.

## Risk to retire first

Whether Firefox throttles a 100 ms `setInterval` in a persistent
background page. `requestAnimationFrame` is not an option there — the
background page is never visible — and a throttled timer would make the
highlight lag the audio.

This gets a throwaway probe before anything is built on it. If the timer
is throttled, the tick moves into the content script, where `rAF` runs
normally in a visible tab, driven by a ~2 Hz time sync from the background
page.
