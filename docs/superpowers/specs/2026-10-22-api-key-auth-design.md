# API Key Authentication for Local Services — Design

## Intent

Other programs on the same machine can call ReadAloud's local services without the user's
approval. One example is an AI agent tricked by prompt injection into POSTing to `localhost`.
Today nothing stops them. CORS only constrains browser pages. A local process that can open a
socket can drive `/api/tts/generate`, `/api/extract`, and the rest, or skip the backend and call
Kokoro on `:8880` directly.

The goal is that only callers holding a secret key the user configured (the extension, the web
frontend, the backend itself) can use either service.

## Goals

- The ReadAloud backend rejects every `/api/*` request that lacks a valid key.
- Kokoro, when run through this repo's compose profiles, is reachable from the host only through
  a gate that rejects requests lacking a valid key.
- The extension's settings page has a field for the backend key. The existing direct-mode
  "API Key" field becomes the Kokoro gate key.
- The web frontend has a key field in its settings panel, so it keeps working.
- A wrong or missing key produces a clear "key rejected" message in the extension popup, the
  options page "Test Connection", and the web frontend. It must not look like "server down".

## Non-goals

- Malware already running as the user. It can read the key from `.env`, the environment, or
  the Firefox profile. The key stops unapproved and tricked callers, not a compromised account.
- Multiple keys, per-client keys, key rotation tooling, scopes, or expiry.
- TLS. Everything is loopback or a Docker network.
- Locking Kokoro when the user runs it outside this repo's compose file.
- Hosted providers (OpenAI, Groq). They already have their own keys.

## Anti-goals

- Fail-open. A blank or unset key must never mean "auth disabled". Neither service may run
  unauthenticated by accident.
- A key that the backend hands out to anyone who asks, for example by injecting it into the
  served frontend HTML. Any local process could fetch it.

## Constraints

- Kokoro-FastAPI has no built-in auth. Upstream feature request #373 is open, and PR #225 was
  never merged. Kokoro must be gated externally.
- The scheme is `Authorization: Bearer <key>` everywhere. The backend's outbound TTS client
  (`config.auth_headers()`) and the extension's direct adapter (`openai.js`) already send this
  header, so the Kokoro side needs no client code changes.
- The extension must still work in both TTS targets. The backend is always used for PDF
  extraction, even in direct mode.
- Project standards: absolute imports, ruff, pytest, vitest, tests for every error path.

## Decided

### Keys and configuration

Two independent secrets. The user may set them to the same value.

| Secret | Server side | Client side |
|---|---|---|
| Backend key | `READALOUD_API_KEY` (new) | extension `backendApiKey` (new), web frontend settings field (new) |
| Kokoro gate key | `KOKORO_API_KEY` (new, compose/Caddy only) | extension `directApiKey` (existing); backend `READALOUD_TTS_API_KEY` (existing) when the backend reaches Kokoro through the gate |

Generate keys with `openssl rand -hex 32` or
`python -c "import secrets; print(secrets.token_hex(32))"`.

### Backend

- Every route under `/api` requires `Authorization: Bearer <READALOUD_API_KEY>`. That includes
  `/api/health`, so a 401 reliably means "bad key" and a connection error means "down".
- Static frontend files (`/`, assets) stay unauthenticated. They contain no secrets.
- Compare keys with `secrets.compare_digest`.
- A failed check returns 401 with `WWW-Authenticate: Bearer`. The body is a single generic
  message that does not say whether the key was missing or wrong.
- Startup fails fast if `READALOUD_API_KEY` is unset, blank, or shorter than 32 characters. The
  error message says how to generate a key.
- CORS `allow_headers` gains `Authorization`.
- CORS preflight (`OPTIONS`) must keep working without a key. Browsers never send credentials on
  preflight.
- `/api/health` currently reports the TTS server as `connected` for any status below 500. Once
  the gate exists, that would hide a wrong `READALOUD_TTS_API_KEY`. It must report
  `tts_server: "unauthorized"` on 401 or 403. The extension already renders this as
  "Backend up, TTS server unauthorized".

### Kokoro gate (compose)

- A new `kokoro-gate` service runs Caddy (`caddy:<2.11.x>-alpine`). Pin a release at least a few
  weeks old, not the newest. It is active under both the `local-gpu` and `local-cpu` profiles.
- It publishes `8880:8880` and reverse-proxies to `kokoro:8880` only when the request's
  `Authorization` header equals `Bearer <KOKORO_API_KEY>`. Otherwise it returns 401.
- `kokoro-gpu` and `kokoro-cpu` stop publishing `8880`. They keep the `kokoro` network alias, so
  they are reachable only inside the compose network.
- Caddy's admin API is off (`admin off`). The site address is a bare `:8880`, so it serves plain
  HTTP and never attempts certificate issuance.
- The gate fails closed. Its container command checks `KOKORO_API_KEY` before exec'ing Caddy
  and exits with a message if the key is unset, blank, or shorter than 32 characters. A blank
  key must never turn into a matcher that accepts the header `Bearer ` with nothing after it.
  Do not use compose's `${KOKORO_API_KEY:?}` for this. Compose interpolates services in
  inactive profiles too (verified on Compose v5.6.1), so `:?` would force remote-mode users,
  who run no Kokoro, to set the key.
- The `readaloud` service runs in every mode, so it can use `${READALOUD_API_KEY:?...}` and have
  compose refuse to start without the key. The backend's own startup check is the second line
  of defense.
- Inside compose, the backend keeps talking to Kokoro directly at `http://kokoro:8880` over the
  internal network, with no gate key needed. When the backend runs on the host (`uvicorn` on
  8055), it reaches Kokoro through the gate at `localhost:8880` and needs
  `READALOUD_TTS_API_KEY=<KOKORO_API_KEY>`.
- Kokoro's built-in web player at `:8880/web` becomes unreachable from a plain browser tab.
  This is accepted.

### Extension

- `lib/settings.js` gains `backendApiKey` (default `""`).
- The options page shows a password field "Backend API key" next to the Backend URL. It is
  visible in both TTS targets.
- The direct-mode key label changes from "leave blank for Kokoro" to say it holds the Kokoro gate
  key or the hosted provider's key.
- Every request to the backend sends `Authorization: Bearer <backendApiKey>`. Today's call
  sites:
  - `lib/adapters/backend.js`: `backendJson`, `fetchAudio`
  - `background.js`: `buildKnownChunks` (`/api/settings`), `handleReadPdf` (`/api/extract/pdf`)
- A 401 from the backend or the gate surfaces as "API key rejected — check ReadAloud settings".
  It shows in the popup status, in "Test Connection", and in playback errors.
- Changing the key field refreshes the voice list, the same way the URL fields do today.

### Web frontend

- The settings store (`stores/settings.ts`, persisted to localStorage) gains the backend key.
  `SettingsPanel` gets a password field for it.
- `api/client.ts` `request()` and `useTts.ts` `fetchAudioBlobUrl` send the header. Audio is
  already fetched as a blob, so no `<audio src>` needs a header.
- On a 401, show a message pointing to the Settings panel.

### Docs

- Update `.env.example`, the README configuration table, the README compose instructions, and
  the CLAUDE.md config table.
- Remove "blank for Kokoro" wording wherever it appears, because local Kokoro now needs the gate
  key.

## Accepted risks

- Caddy's header matcher is not a constant-time comparison. A timing attack over loopback
  against a 256-bit random key is not a realistic threat for this model, so we accept it.
- The key sits in plaintext in `.env`, Firefox `storage.local`, and browser localStorage. This is
  covered by the non-goal on same-user malware.

## Left to the builder

- How the backend check is wired: a router-level `Depends`, app-level dependencies, or
  middleware. The behavior above is what matters, including preflight passing.
- Where the fail-fast startup check lives. `readaloud.main` builds `app` at import time, and
  `tests/test_routes.py` imports it at module level. Tests therefore need the key set before
  import, for example in a `conftest.py`.
- Whether the extension builds backend headers through a small shared helper. Four call sites
  justify one.
- Exact Caddyfile syntax and Caddy patch version.
- Test layout, following existing patterns: `tests/test_*.py` for the backend, colocated
  `*.test.js` for the extension. Cover missing, wrong, and correct keys; preflight without a
  key; static files without a key; startup refusal for blank and short keys; header presence
  at every extension call site; and the 401 messaging.
