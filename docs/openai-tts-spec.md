# OpenAI Text-to-Speech API Spec

Reference for `POST /v1/audio/speech`, sourced from OpenAI's published OpenAPI spec
(https://github.com/openai/openai-openapi, `openapi.yaml`, `CreateSpeechRequest`/`createSpeech`)
and the text-to-speech guide. Written to evaluate what ReadAloud's extension would need to talk
to *any* OpenAI-compatible TTS host directly, without the FastAPI backend as a proxy.

## Endpoint

```
POST {base_url}/v1/audio/speech
Authorization: Bearer {api_key}
Content-Type: application/json
```

Base URL for OpenAI itself is `https://api.openai.com/v1`. Self-hosted OpenAI-compatible
servers (Kokoro, LocalAI, etc.) implement the same path under their own base URL.

## Request body (`CreateSpeechRequest`)

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `model` | string | yes | — | `tts-1`, `tts-1-hd`, `gpt-4o-mini-tts`, `gpt-4o-mini-tts-2025-12-15`, or any custom string. Self-hosted servers accept arbitrary model IDs (e.g. `kokoro`). |
| `input` | string | yes | — | Text to synthesize. **Max 4096 characters** per OpenAI's own limit — this is why ReadAloud chunks long text server-side today. Self-hosted servers may enforce a different limit or none at all. |
| `voice` | string \| `{id: string}` | yes | — | Built-in OpenAI voices: `alloy`, `ash`, `ballad`, `coral`, `echo`, `fable`, `onyx`, `nova`, `sage`, `shimmer`, `verse`, `marin`, `cedar`. `tts-1`/`tts-1-hd` only support 9 of these (no `ballad`, `verse`, `marin`, `cedar`). A custom voice object `{"id": "voice_1234"}` is also accepted. Self-hosted servers define their own voice IDs (Kokoro uses IDs like `af_heart`). |
| `response_format` | string | no | `mp3` | One of `mp3`, `opus`, `aac`, `flac`, `wav`, `pcm`. |
| `speed` | number | no | `1` | Range `0.25`–`4.0`. |
| `instructions` | string | no | — | Freeform steering text (accent, tone, whispering, etc.). Ignored by `tts-1`/`tts-1-hd`; unlikely to be supported by non-OpenAI servers. |
| `stream_format` | string | no | `audio` | `audio` (raw chunked bytes) or `sse` (Server-Sent Events). `sse` is not supported on `tts-1`/`tts-1-hd`. |

## Response

- **`200`**, non-streaming (`stream_format: "audio"`, the default): `application/octet-stream` body containing the raw audio file bytes in the requested `response_format`, sent with `Transfer-Encoding: chunked`. This is what ReadAloud's backend consumes today (`tts_client.py` always requests `response_format: "mp3"`, reads `response.content` as a single blob).
- **`200`**, streaming (`stream_format: "sse"`): `text/event-stream` of `CreateSpeechResponseStreamEvent` objects:
  - `speech.audio.delta` — `{"type": "speech.audio.delta", "audio": "<base64-chunk>"}`, one per audio chunk.
  - `speech.audio.done` — `{"type": "speech.audio.done", "usage": {"input_tokens", "output_tokens", "total_tokens"}}`, terminal event.
- **`429`**: rate limited, standard `ErrorResponse` body.
- **Error shape** (`ErrorResponse`): `{"error": {"type": string, "message": string, "param": string|null, "code": string|null}}`.

## Authentication

`securitySchemes.ApiKeyAuth`: HTTP Bearer (`Authorization: Bearer <key>`). Applies globally to
the OpenAI API. Self-hosted servers vary — Kokoro's default config requires no key at all, but a
generic "OpenAI-compatible" client should treat the API key as optional/configurable rather than
required.

## Adjacent endpoints referenced by ReadAloud but not part of the core spec

- **`GET /v1/audio/voices`** — used by `backend/src/readaloud/routes/voices.py` to list voices.
  **The `GET` verb on this path is not part of OpenAI's public API.** The path `/v1/audio/voices`
  does exist officially, but only as `POST` (`createVoice`) — it uploads an audio sample + consent
  recording to create a custom cloned voice (an eligible-customers-only feature) and returns a
  single `VoiceResource`, not a list. There is no official endpoint to *enumerate* voices at all;
  the built-in voice set is a static, documented enum (see the `voice` field above), not something
  a client can query at runtime. Kokoro reuses the same path with `GET` for a different purpose
  (listing its built-in voices) — that's the non-standard part. Any voice-listing feature needs a
  fallback path for servers that don't implement Kokoro's convention.
- **`GET /v1/models`** (`listModels`, official OpenAI endpoint) — returns
  `{"object": "list", "data": [{"id", "object": "model", "created", "owned_by"}, ...]}`. ReadAloud's
  backend already falls back to this for voice listing when `/v1/audio/voices` fails, using model
  IDs as a stand-in for voice IDs. This works against real OpenAI (lists model names, not voices)
  but is the closest thing to a standardized "what's available" probe.
- **Health check** — there is no standardized health/status endpoint in the OpenAI spec. ReadAloud's
  `/api/health` is backend-only; a direct-to-server client has no equivalent and would need to infer
  health from a request succeeding/failing (or a cheap `GET /v1/models` probe).

## Implications for a backend-less extension

If the extension calls an OpenAI-compatible `/v1/audio/speech` endpoint directly instead of going
through the FastAPI backend:

1. **No job/polling model.** The call is synchronous — response body *is* the audio (or an SSE
   stream). The backend's `job_id` / `/api/tts/status/{id}` / `/api/tts/audio/{id}` pattern
   (`backend/src/readaloud/routes/tts.py`) has no equivalent and isn't needed.
2. **Chunking becomes the extension's job.** OpenAI enforces a hard 4096-char `input` limit;
   self-hosted servers may differ. Long articles must be split client-side (mirroring
   `text_chunker.py`) and played sequentially — using `stream_format: "sse"` or simply firing
   one request per chunk lets playback start before the whole article is synthesized, which is
   better UX than the current stitch-then-play flow (`audio_stitcher.py`).
3. **Voice listing has no standard source.** Fall back to a hardcoded list (mirroring
   `FALLBACK_VOICES` in `voices.py`) when `/v1/audio/voices` (non-standard) and `/v1/models`
   (standard but voice-agnostic) both fail or return nothing useful.
4. **Auth needs to be optional and configurable.** Add an API-key field to the extension's options
   page; send `Authorization: Bearer <key>` only when one is set, since local servers like Kokoro
   don't require it.
5. **CORS.** The extension already requests `<all_urls>` host permission in `manifest.json`, so
   background-script `fetch()` calls to an arbitrary server aren't blocked by CORS the way a
   webpage's would be.
