# Roadmap

Findings from a review of the backend, frontend, and extension on 2026-08-24. Ordered by
priority: live bugs first, then improvements that unblock features, then the features.

Line references are to the state of the tree at the time of review and may drift.

## Bugs

### Fixed on 2026-08-25

- **Speed applies twice in the web app** — the web app no longer sends `speed` at generation time;
  `AudioPlayer`'s `playbackRate` is the only speed control, matching the extension (commit 9f6d03d).
  `speed` is gone from the settings store, `useTts.generate`, and `TtsGenerateRequest`.
- **SSRF in `/api/extract`** — new `services/url_guard.py` rejects non-http(s) schemes and any host
  resolving to a private, loopback, link-local, multicast, reserved, or unspecified address
  (including IPv4-mapped IPv6 forms such as `::ffff:127.0.0.1`). Every resolved address is checked,
  not just the first.
- **Blocking I/O in an async route** — `extract_from_url` is now `async` and fetches with
  `httpx.AsyncClient`. `trafilatura.fetch_url` is gone; trafilatura now only parses HTML we
  fetched ourselves.

Redirects are followed manually (`follow_redirects=False`, max 5 hops) so each hop revalidates —
otherwise a public URL could bounce the request to `127.0.0.1`.

One thing the guard does *not* cover, still open:

- **DNS rebinding (TOCTOU).** The guard resolves the host to check it, then httpx resolves again to
  connect. A hostname with a very short TTL can return a public address to the first lookup and a
  private one to the second. Closing this means pinning the validated IP through a custom transport.

### Also fixed on 2026-08-25

- **`allow_origins=["*"]`** — the API now allows only the local dev and production origins, plus
  browser-extension origins by regex (MV2 host permissions already bypass CORS, so this grants an
  installed extension nothing new). Override with `READALOUD_ALLOWED_ORIGINS`, a comma-separated
  list that replaces the defaults. A wildcard is never returned. `main.py` gained a `create_app()`
  factory so this is testable under different settings.
- **Unbounded in-memory job store** — `JobState` no longer holds any audio. New
  `services/job_store.py` writes chunks to a temp dir keyed by job id; once every chunk lands they
  are streamed into one stitched file and the chunk files are deleted, so a finished job costs one
  copy on disk instead of two in memory. The TTL is now enforced by a background sweeper
  (`sweep_jobs_forever`, every 5 min) rather than only when a generate request arrives, and all job
  audio is purged on shutdown.

  Dropping the chunk files would have broken the extension, which pulls chunk endpoints lazily and
  is routinely still behind when a job completes. `finalize_from_chunks` therefore records each
  chunk's `(offset, length)` in `chunks.json`, and `/api/tts/audio/{job_id}/{index}` serves that
  byte range out of the stitched file. Those offsets are also most of the input the seekability fix
  below needs.

### Fixed on 2026-08-26

- **Concatenated MP3s weren't seekable** — `stitch_mp3` was a raw `b"".join`. If a chunk's encoder
  wrote a Xing/Info VBR header as its first frame (a silent placeholder describing that chunk's own
  frame/byte count for seeking), naive concatenation left one such header per chunk buried
  mid-stream; browsers read only the first and reported chunk one's duration for the whole file.

  New `services/mp3_frames.py` parses Layer III frame headers, strips any embedded Xing/Info header
  from each chunk, and `audio_stitcher` rebuilds a single correct one at the front of the stitched
  file with the true total frame/byte counts. `stitch_mp3_to_file` now returns the real per-source
  byte ranges in the output (not the sources' original sizes, since a stripped header shifts them),
  and `job_store.finalize_from_chunks` records those in `chunks.json` instead of computing offsets
  from the raw chunk files — otherwise per-chunk reads would have drifted out of alignment after the
  header rewrite. Falls back to plain concatenation for anything that doesn't parse as MP3.

This was the last remaining bug from the original review.

## Improvements

### Stream playback in the web app

`/api/tts/audio/{job_id}/{chunk_index}` already exists, and the extension already has a sequential
player with one chunk of lookahead (`extension/lib/player.js`) — but the web frontend waits for the
whole job before playing anything. Reusing that pattern takes time-to-first-audio on long texts
from minutes to a second or two. Largest single UX win available.

### Generate chunks concurrently

`_process_long_text` (`backend/src/readaloud/routes/tts.py:59`) is a strict sequential loop. A
bounded `asyncio.Semaphore(3)` over the chunk list is a near-linear speedup against Kokoro, which
handles parallel requests fine.

### Cache by content hash

`sha256(text + voice + model)` → audio file. Re-reading an article or regenerating after a small
edit becomes instant, and it makes the library/queue features below nearly free.

### Server-sent events instead of polling

`frontend/src/hooks/useTts.ts:97` polls every 2s. A `/api/tts/events/{job_id}` SSE stream gives
smooth progress and removes up to 2s of latency at completion.

### CI and frontend tests

There is no `.github/` directory, and `frontend/package.json` has no test runner while the
extension has full vitest coverage. A workflow running `ruff check`, `pytest`, `tsc --noEmit`, and
the extension's `npm test` catches the class of drift that produced the double-speed bug.

## Features

| Feature | Why it fits | Effort |
|---|---|---|
| Sentence highlighting during playback | Kokoro-FastAPI exposes `/dev/captioned_speech` with word timestamps, and the extension already injects a content script, so highlighting the spoken sentence in-page is reachable | M |
| Download / save as MP3 | Audio is already generated and then thrown away; needs `Content-Disposition` and a button. Gateway to the next row | S |
| Personal podcast feed | Saved articles → RSS at `/feed.xml` → listen in any podcast app, offline, on a phone. Turns the project from a demo into something used daily | M |
| Reading queue | Send several URLs and listen back to back; pairs with caching and the sequential player already written | M |
| Resume position | Persist chunk index and offset per article; the extension currently loses everything on stop | S |
| MediaSession + `browser.commands` | Media keys, lock-screen controls, and keyboard shortcuts for the extension | S |
| Text preprocessing | Strip `[1]` citations, markdown syntax, and code blocks; expand abbreviations; user pronunciation dictionary. Everything is read literally today, which is rough on Wikipedia and docs pages | M |
| Voice blending | Kokoro accepts weighted blends such as `af_bella+af_sky`; needs UI only | S |
| EPUB / PDF input | Same chunker, new extractor — the obvious next source after URLs | M |
| MV3 and Chrome support | The manifest is MV2 with a persistent background page; MV3 needs an offscreen document for `Audio`. Real work, but it's the difference between Firefox-only and everywhere | L |
