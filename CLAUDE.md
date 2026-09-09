# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**ReadAloud** is a full-stack Text-to-Speech (TTS) web application. It converts text and web content to spoken audio using an OpenAI-compatible TTS backend (e.g., Kokoro). The frontend is React + TypeScript, the backend is Python FastAPI.

## Commands

### Backend

```bash
cd backend
uv sync                          # Install dependencies
uv run uvicorn readaloud.main:app --host 0.0.0.0 --port 8055  # Run dev server
uv run pytest tests/             # Run all tests
uv run pytest tests/test_text_chunker.py  # Run single test file
uv run ruff check src/           # Lint
uv run ruff format src/          # Format
```

### Frontend

```bash
cd frontend
pnpm install                     # Install dependencies
pnpm dev                         # Dev server at http://localhost:8056 (proxies /api → :8055)
pnpm build                       # TypeScript check + build to dist/
pnpm preview                     # Preview production build
```

## Architecture

### Backend (`backend/src/readaloud/`)

- `main.py` — `create_app()` factory: CORS, route registration, static file serving, job-sweeper lifespan
- `config.py` — Pydantic settings from env vars (`READALOUD_*` prefix)
- `routes/` — HTTP handlers: `tts.py`, `extract.py`, `voices.py`, `health.py`, `settings.py`
- `services/` — Business logic: `tts_client.py`, `text_extractor.py`, `pdf_extractor.py`, `text_chunker.py`, `audio_stitcher.py`, `mp3_frames.py`, `job_store.py`, `url_guard.py`, `reading_cues.py`
- `models/schemas.py` — Pydantic request/response models

### Frontend (`frontend/src/`)

- `App.tsx` — Root component; owns text state, wires together all UI pieces
- `hooks/useTts.ts` — TTS generation + job polling logic (polls `/api/tts/status/{id}` every 2s)
- `hooks/useVoices.ts` — Fetches available voices from backend
- `stores/settings.ts` — Zustand store; persisted to localStorage as `readaloud-settings`
- `api/` — Typed HTTP client (`client.ts`) and shared TypeScript interfaces (`types.ts`)
- `components/` — Pure UI: `TextInput`, `UrlInput`, `VoiceSelector`, `AudioPlayer`, `SettingsPanel`, `GenerationProgress`, `ReadingText`

### Key Data Flows

**TTS generation:**
1. POST `/api/tts/generate` → if text ≤ 4000 chars, returns complete audio immediately; otherwise returns a job ID with `status="processing"`
2. Frontend polls `/api/tts/status/{jobId}` until complete
3. Audio served at `/api/tts/audio/{jobId}`
4. Long texts are chunked (paragraph → sentence → word boundaries), processed sequentially, then MP3s are stitched together
5. Callers may pass `known_chunks` (hash + base64 audio) on the request; the backend reuses those
   instead of resynthesizing matching chunks. The extension's direct adapter pre-chunks locally and
   supplies its `chunk-cache.js` cache as `known_chunks`. `TtsStatusResponse.chunks` reports each
   chunk's `source` (`synthesized` vs `client_cache`).

**URL extraction:**
- POST `/api/extract` → trafilatura fetches and parses the URL, returns title + text (max 100k chars)

**Voice list:**
- GET `/api/voices` → tries TTS server `/v1/audio/voices`, falls back to `/v1/models`, then hardcoded defaults

**Reading-highlight cues:**
- `reading_cues.py` builds word-level `Cue` (text, start, end) lists timing the reading highlight
  to playback. Each chunk uses the TTS server's real per-word timestamps when they line up with its
  words, falling back per-chunk to splitting the chunk's audio duration across its words
  proportional to character length. Cue text always comes from the submitted text, never the
  server's (possibly normalized) words. Returned as `cues` on both the short-text response and the
  job status response, consumed by `ReadingText` to highlight the word at the current playback time.

### Extension (`extension/`)

Firefox WebExtension, Manifest V2 with a background *page* (`background.html`) so all scripts load
as ES modules. Imports are extension-root-absolute (`/lib/foo.js`), which resolves both in the
browser and under Vite/vitest.

- `lib/adapters/` — TTS adapters. `backend.js` speaks the FastAPI job API; `openai.js` calls
  `POST /v1/audio/speech` directly. `index.js` picks one from `settings.ttsTarget`.
- `lib/player.js` — plays the adapters' blob stream sequentially with one chunk of lookahead
- `lib/chunker.js` — JS port of `text_chunker.py`, used only by the direct adapter
- `lib/chunk-cache.js` — session-scoped LRU cache of synthesized chunk audio, keyed by (voice, hash)
- `lib/hash.js` — SHA-256 hex digest matching the backend's chunk hashing, for cache lookups
- `lib/read-from-here.js` — slices article text from a DOM selection onward for "read from here"
- `lib/pdf.js` — detects PDF URLs and resolves Firefox's built-in PDF viewer URL to the real one
- `lib/settings.js` — `storage.local` schema and defaults
- `background.js` — orchestration only; owns state and the message API used by the popup

Both adapters expose `synthesize()` as an async generator yielding `{audio, index, total}`, so the
player is target-agnostic. Tests: `cd extension && npm test` (vitest).

### TTS Server Integration

Backend expects an OpenAI-compatible TTS API. Default URL: `http://localhost:8880`. Endpoint: `POST /v1/audio/speech` with `{model, input, voice, speed, response_format: "mp3"}`.

For reading-highlight cues, the backend also probes Kokoro-FastAPI's non-OpenAI
`POST /dev/captioned_speech` for real per-word timestamps. A 404 means the configured server
doesn't implement it; the backend silently falls back to the character-count heuristic for that
job, so a non-Kokoro server still gets approximate highlighting.

### Configuration (env vars, all optional)

| Variable | Default |
|---|---|
| `READALOUD_TTS_BASE_URL` | `http://localhost:8880` |
| `READALOUD_TTS_MODEL` | `kokoro` |
| `READALOUD_TTS_DEFAULT_VOICE` | `af_heart` |
| `READALOUD_TTS_API_KEY` | _(blank)_ |
| `READALOUD_MAX_CHUNK_CHARS` | `4000` |
| `READALOUD_ALLOWED_ORIGINS` | _(blank — localhost dev + prod origins)_ |

In production, the FastAPI backend serves the frontend's `dist/` directory as static files.
