# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**ReadAloud** is a full-stack Text-to-Speech (TTS) web application. It converts text and web content to spoken audio using an OpenAI-compatible TTS backend (e.g., Kokoro). The frontend is React + TypeScript, the backend is Python FastAPI.

## Commands

### Backend

```bash
cd backend
uv sync                          # Install dependencies
uv run uvicorn readaloud.main:app --host 0.0.0.0 --port 8000  # Run dev server
uv run pytest tests/             # Run all tests
uv run pytest tests/test_text_chunker.py  # Run single test file
uv run ruff check src/           # Lint
uv run ruff format src/          # Format
```

### Frontend

```bash
cd frontend
pnpm install                     # Install dependencies
pnpm dev                         # Dev server at http://localhost:5173 (proxies /api → :8000)
pnpm build                       # TypeScript check + build to dist/
pnpm preview                     # Preview production build
```

## Architecture

### Backend (`backend/src/readaloud/`)

- `main.py` — FastAPI app setup, CORS, route registration, static file serving
- `config.py` — Pydantic settings from env vars (`READALOUD_*` prefix)
- `routes/` — HTTP handlers: `tts.py`, `extract.py`, `voices.py`, `health.py`, `settings.py`
- `services/` — Business logic: `tts_client.py`, `text_extractor.py`, `text_chunker.py`, `audio_stitcher.py`
- `models/schemas.py` — Pydantic request/response models

### Frontend (`frontend/src/`)

- `App.tsx` — Root component; owns text state, wires together all UI pieces
- `hooks/useTts.ts` — TTS generation + job polling logic (polls `/api/tts/status/{id}` every 2s)
- `hooks/useVoices.ts` — Fetches available voices from backend
- `stores/settings.ts` — Zustand store; persisted to localStorage as `readaloud-settings`
- `api/` — Typed HTTP client (`client.ts`) and shared TypeScript interfaces (`types.ts`)
- `components/` — Pure UI: `TextInput`, `UrlInput`, `VoiceSelector`, `AudioPlayer`, `SettingsPanel`, `GenerationProgress`

### Key Data Flows

**TTS generation:**
1. POST `/api/tts/generate` → if text ≤ 4000 chars, returns complete audio immediately; otherwise returns a job ID with `status="processing"`
2. Frontend polls `/api/tts/status/{jobId}` until complete
3. Audio served at `/api/tts/audio/{jobId}`
4. Long texts are chunked (paragraph → sentence → word boundaries), processed sequentially, then MP3s are stitched together

**URL extraction:**
- POST `/api/extract` → trafilatura fetches and parses the URL, returns title + text (max 100k chars)

**Voice list:**
- GET `/api/voices` → tries TTS server `/v1/audio/voices`, falls back to `/v1/models`, then hardcoded defaults

### TTS Server Integration

Backend expects an OpenAI-compatible TTS API. Default URL: `http://localhost:8880`. Endpoint: `POST /v1/audio/speech` with `{model, input, voice, speed, response_format: "mp3"}`.

### Configuration (env vars, all optional)

| Variable | Default |
|---|---|
| `READALOUD_TTS_BASE_URL` | `http://localhost:8880` |
| `READALOUD_TTS_MODEL` | `kokoro` |
| `READALOUD_TTS_DEFAULT_VOICE` | `af_heart` |
| `READALOUD_MAX_CHUNK_CHARS` | `4000` |

In production, the FastAPI backend serves the frontend's `dist/` directory as static files.
