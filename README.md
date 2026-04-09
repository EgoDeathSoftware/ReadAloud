# ReadAloud

A web application that converts text and web content to spoken audio using an OpenAI-compatible TTS server (e.g., [Kokoro](https://github.com/remsky/Kokoro-FastAPI)).

## Features

- Convert text to speech with configurable voice, model, and speed
- Extract readable text from any URL
- Handles long texts by chunking and stitching audio automatically
- Real-time progress tracking for long-form generation
- Settings persisted locally in the browser

## Prerequisites

- A running OpenAI-compatible TTS server **or** Docker with NVIDIA drivers (for local GPU mode)

## Docker (recommended)

All modes build the app and serve it at `http://localhost:8000`.

### Remote TTS

Use your own TTS server (or a hosted service):

```bash
cp .env.example .env
# Set READALOUD_TTS_BASE_URL in .env
docker compose up
```

### Local GPU (NVIDIA)

Requires [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html). Compatible with RTX 4080, DGX Spark, and other CUDA-capable GPUs.

```bash
docker compose --profile local-gpu up
```

### Local CPU

```bash
docker compose --profile local-cpu up
```

## Manual Setup

Requires Python 3.12+, [uv](https://docs.astral.sh/uv/), Node.js 22+, and [pnpm](https://pnpm.io/).

### Backend

```bash
cd backend
uv sync
uv run uvicorn readaloud.main:app --host 0.0.0.0 --port 8000
```

### Frontend (development)

```bash
cd frontend
pnpm install
pnpm dev
```

The dev server runs at `http://localhost:5173` and proxies `/api` requests to the backend at `:8000`.

### Production build

```bash
cd frontend && pnpm build
cd ../backend && uv run uvicorn readaloud.main:app --host 0.0.0.0 --port 8000
```

The backend serves the compiled frontend from `frontend/dist/`.

## Configuration

Configure the backend via environment variables:

| Variable | Default | Description |
|---|---|---|
| `READALOUD_TTS_BASE_URL` | `http://localhost:8880` | TTS server URL |
| `READALOUD_TTS_MODEL` | `kokoro` | Model name |
| `READALOUD_TTS_DEFAULT_VOICE` | `af_heart` | Default voice ID |
| `READALOUD_MAX_CHUNK_CHARS` | `4000` | Max characters per TTS request |

Frontend settings (voice, speed, server URL) are configurable in the Settings panel and persisted to `localStorage`.

## Development

### Running tests

```bash
cd backend
uv run pytest tests/
```

### Linting

```bash
# Backend
cd backend && uv run ruff check src/ && uv run ruff format src/

# Frontend — TypeScript check
cd frontend && pnpm build
```

## Architecture

The FastAPI backend manages TTS job lifecycle and acts as a proxy to the TTS server. Short texts (≤ 4000 chars) are processed synchronously; longer texts are chunked, processed in the background, and the frontend polls for completion. Audio chunks are stitched into a single MP3.

The React frontend uses Zustand for settings state and polls `/api/tts/status/{jobId}` every 2 seconds during generation.

See [CLAUDE.md](CLAUDE.md) for a detailed architecture reference.
