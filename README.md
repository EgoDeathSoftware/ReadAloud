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
| `READALOUD_TTS_API_KEY` | _(blank)_ | Bearer token for the TTS server. Blank for Kokoro; required for OpenAI/Groq |
| `READALOUD_MAX_CHUNK_CHARS` | `4000` | Max characters per TTS request |

Frontend settings (voice, speed, server URL) are configurable in the Settings panel and persisted to `localStorage`.

## Extension TTS targets

The Firefox extension can send TTS work to either of two places, selected in its options page.

**ReadAloud backend** (default) — the extension talks to the FastAPI container at
`http://localhost:8000`. The backend chunks long text, calls the TTS server, and the extension
streams each finished chunk. Use this when you want the API key held server-side, or when the
TTS server is not reachable from the browser.

**Direct endpoint** — the extension calls `POST /v1/audio/speech` itself, chunking in the
browser. Point it at any OpenAI-compatible server:

| Server | Endpoint URL | Model | API key |
|---|---|---|---|
| Kokoro (this repo's compose profiles) | `http://localhost:8880` | `kokoro` | none |
| OpenAI | `https://api.openai.com` | `gpt-4o-mini-tts` | required |
| Groq | `https://api.groq.com/openai` | `playai-tts` | required |

Providers with their own request schema (ElevenLabs, Google, Polly) are not supported — see
[docs/PROVIDERS.md](docs/PROVIDERS.md).

### Limitations

**Read Selection doesn't work inside PDFs**, on either TTS target. Firefox's built-in PDF viewer
(`pdf.js`) is a privileged internal page (`resource://pdf.js/...`) that WebExtension content
scripts cannot be injected into — Mozilla blocked this deliberately in Firefox 60 and has not
reversed it. "Read Page" works around this by re-extracting the PDF server-side; reading a
selected excerpt does not have a workaround.

**PDF "Read Page" always requires the ReadAloud backend reachable**, even when the extension's TTS
target is set to "direct" (calling an OpenAI-compatible server directly for synthesis). PDF text
extraction only exists on the ReadAloud FastAPI backend — an OpenAI-compatible `/v1/audio/speech`
endpoint has no concept of PDF parsing. Only the speech-synthesis step after extraction can go
through direct/OpenAI.

Reading a PDF from a local `file://` URL depends on Firefox's local-file-access permissions for
extensions, which vary by Firefox version and are still evolving upstream (Mozilla is actively
changing how this works). If `file://` PDFs fail to load, check your Firefox version's extension
permission settings for file access; this has not been verified against a specific Firefox release
as part of this feature.

### Extension development

```bash
cd extension
npm install     # vitest only; the extension itself ships no runtime dependencies
npm test
```

Load it in Firefox via `about:debugging` → This Firefox → Load Temporary Add-on → `extension/manifest.json`.

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
