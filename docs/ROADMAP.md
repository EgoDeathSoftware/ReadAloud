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

## OpenAI API compatibility (current priority)

`docs/openai-tts-spec.md` documents the full `POST /v1/audio/speech` request/response shape.
`TtsClient.generate_speech` (`backend/src/readaloud/services/tts_client.py`) and the extension's
`lib/adapters/openai.js` both use only a subset of it, and their retry/error handling was written
against Kokoro (free, local, never rate-limits) — some of it will misbehave the first time it's
pointed at a real billed provider. Closing these gaps means both clients can point at OpenAI
itself, Groq, or any other spec-compliant server — not just Kokoro — via config alone.

Auth today (`config.py:auth_headers`, `openai.js:headers`) is basically sound: `Authorization:
Bearer <key>` sent only when a key is configured, never echoed back by `/api/settings`. The gaps
are elsewhere.

Ranked by how much each will actually bite in practice:

### Fixed on 2026-08-26

- **Retries didn't check status code** — `tts_client.py` and `openai.js` now only retry 429/5xx.
  A 400 (bad model/voice) fails immediately with the server's real error message instead of
  burning two more attempts first.
- **No `Retry-After` handling on 429** — both clients now read the header and sleep exactly that
  long instead of blind `2**attempt` backoff, falling back to exponential backoff only when the
  header is absent or unparseable.
- **Backend swallowed the real error message** — `tts_client.py` now parses the response body
  (`{"error": {"message": ...}}`) into `JobState.error` instead of a generic httpx exception
  string, matching what `openai.js`'s `describeError` already did.

| Gap | Notes |
|---|---|
| `response_format` hardcoded to `mp3` | Spec also allows `opus`, `aac`, `flac`, `wav`, `pcm`. `audio_stitcher.py`/`mp3_frames.py` assume MP3 today, so accepting another format means either transcoding to MP3 server-side or teaching the stitcher/player about the chosen format. |
| No `instructions` field | Freeform steering text (accent, tone, whispering). OpenAI's `gpt-4o-mini-tts` supports it; passthrough is a one-line addition to `TtsGenerateRequest`/`generate_speech`, ignored harmlessly by servers that don't support it. |
| No `stream_format: "sse"` support | `TtsClient` always reads `response.content` as one blob. Supporting `speech.audio.delta`/`speech.audio.done` SSE events would let the ReadAloud FastAPI backend forward audio to the frontend as it's generated — pairs with "Stream playback in the web app" and "SSE instead of polling" above. It also unlocks usage/cost reporting: the terminal `speech.audio.done` event carries token usage, irrelevant for free local Kokoro but real money against OpenAI/Groq. |
| No `OpenAI-Organization` / `OpenAI-Project` headers | Needed for keys tied to a multi-org OpenAI account, otherwise requests may silently hit the wrong default org/billing. No equivalent concept in Kokoro. |
| One global API key, no per-target credential storage | `READALOUD_TTS_API_KEY` / `directApiKey` is a single flat value. Switching between a keyless Kokoro config and a keyed OpenAI/Groq config means re-entering settings each time — relevant since multiple backends are planned. |
| No model/voice validation against the known enum | A typo'd model/voice against real OpenAI only surfaces as an opaque failed job after generation starts, not as a settings-page warning. `voices.py`'s hardcoded `FALLBACK_VOICES` / `openai.js`'s `FALLBACK_VOICES` could double as a validation list. |
| No input-length guard tied to the active target | `MAX_CHUNK_CHARS` defaults to 4000 (under OpenAI's 4096 cap), but nothing stops configuring it higher for Kokoro and then silently 400ing every chunk if the same config later points at OpenAI. |
| `voice` as `{id: string}` object not supported | Only bare string voice IDs are sent today. Low priority — self-hosted servers only use string IDs; matters only if OpenAI's custom-voice-cloning feature is ever targeted. |

## Kokoro-specific extensions (future, deferred)

Everything below only works against Kokoro-FastAPI specifically — not OpenAI, Groq, or other
OpenAI-compatible servers per `docs/PROVIDERS.md` — so it's deferred until the OpenAI-compatibility
gaps above are closed and there's a capability-detection or Kokoro-only code path to gate these on.

| Feature | What it needs |
|---|---|
| SSML `<break time="Xms"/>` pause tags | Works in both streaming and non-streaming `/v1/audio/speech`. Cheap: insert breaks at paragraph boundaries instead of relying on natural sentence pauses. |
| Kokoro's native audio streaming/chunking | Server-side chunking via `TARGET_MIN_TOKENS`/`TARGET_MAX_TOKENS`/`ABSOLUTE_MAX_TOKENS`. Could replace or complement ReadAloud's own `text_chunker.py` + job-store chunking — needs a design decision on which layer owns chunking. |
| Multi-language support | Spanish, French, Hindi, Italian, Japanese, Brazilian Portuguese, Mandarin, plus US/GB English. Nothing in ReadAloud surfaces a language selector today; relevant if URL extraction pulls non-English content. |
| Phoneme endpoints (text→phonemes, phonemes→audio) | Enables a pronunciation-dictionary feature (see "Text preprocessing" below) with exact control instead of guessing. |
| Voice tagging sidecar (`allow_voice_tags`) | Each chunk's response carries which voice spoke it, when multiple voices are used in one generation. |
| Inline multi-speaker generation | Beyond simple voice blending (`af_bella+af_sky`), switch speakers within one request — e.g. narrator voice vs. quoted-text voice. Pairs with voice tagging above. |
| Voice blending (`af_bella+af_sky` weighted mixes) | Already listed under Features below; noted here too since it's Kokoro-only. |
| Sentence highlighting via `/dev/captioned_speech` | Already listed under Features below; noted here too since it's Kokoro-only. |

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
