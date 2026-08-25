# TTS Provider Landscape

Survey of common TTS providers, focused on which ones speak the OpenAI `/v1/audio/speech` schema
(see `docs/openai-tts-spec.md`) versus which require their own integration. Relevant to making
ReadAloud modular — able to point at any TTS host, not just Kokoro — since only a subset of
providers can be swapped in with just a base URL + optional API key.

## OpenAI-schema compatible

Drop-in for a client that only speaks the OpenAI `/v1/audio/speech` request/response shape.

| Provider | Endpoint | Notes |
|---|---|---|
| OpenAI | `api.openai.com/v1/audio/speech` | The reference implementation. |
| Groq (PlayAI TTS) | `api.groq.com/openai/v1/audio/speech` | Genuinely OpenAI-compatible — same `model`/`voice`/`response_format`/`speed` fields, just different model IDs (`playai-tts`, `playai-tts-arabic`) and voice names (e.g. `Fritz-PlayAI`). Also supports other models on the same endpoint (e.g. `canopylabs/orpheus-v1-english`). |
| Kokoro (self-hosted) | `/v1/audio/speech` | What ReadAloud's backend targets today. Also exposes the non-standard `GET /v1/audio/voices` extension for voice listing. |
| Other self-hosted OSS servers (LocalAI, etc.) | `/v1/audio/speech` | Cloned the OpenAI convention specifically so clients don't need custom integration. |

## Own proprietary schema

Need a separate adapter — not just a base-URL swap — because the request shape, auth, or both
differ from OpenAI's.

| Provider | Native endpoint shape | Why it doesn't fit |
|---|---|---|
| ElevenLabs | `POST /v1/text-to-speech/{voice_id}`, `xi-api-key` header | Voice ID is in the URL path, not the body; auth header isn't `Bearer`. Third-party gateways (LLM Gateway, LiteLLM) offer an OpenAI-shaped facade in front of it, but ElevenLabs itself doesn't. Core models: `eleven_flash_v2_5` (~75ms latency), `eleven_multilingual_v2`, `eleven_v3`. Billed per character. |
| xAI Grok TTS | `docs.x.ai` audio endpoints | Standalone API launched April 2026 — 5 voices, 20+ languages, inline expressive tags (laugh/whisper/pause), 15,000-char request limit (streaming has no total limit, but each chunk is capped the same). Priced at $15/1M characters. Separate from the OpenAI-shaped Grok Speech-to-Speech (Realtime) API. |
| Mistral (Voxtral TTS) | `docs.mistral.ai/studio/audio/text_to_speech` | Released March 2026, 4B-parameter open-weight model, zero-shot voice cloning from 2-3s audio samples, 9 languages (English, French, Spanish, Portuguese, Italian, Dutch, German, Hindi, Arabic). Own schema; weights are downloadable for self-hosting (CC BY-NC). $0.016 per 1k characters via API. |
| Google (Cloud TTS / Gemini) | own REST/gRPC | Different auth (service account/API key), different field names. |
| Amazon Polly | AWS SDK / SigV4 | AWS-specific request signing, not a plain bearer token. |
| Deepgram (Aura) | own REST | Different schema; also fast/low-latency focused. |

## Implication for ReadAloud

"Point the extension at any OpenAI-compatible endpoint" (per `docs/openai-tts-spec.md`) covers
OpenAI, Groq, and Kokoro-style self-hosted servers with just a base-URL + optional API-key change.
ElevenLabs, Grok, Mistral, Google, and Amazon would each need their own request-shaping logic —
a genuinely different code path per provider, not a config field — and are out of scope for a
"just needs an OpenAI endpoint" design.
