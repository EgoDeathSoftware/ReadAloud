# ReadAloud Extension TTS Targets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the ReadAloud extension send TTS work either through the existing FastAPI backend or directly to an OpenAI-compatible server (the Kokoro Docker container by default), selected in the options page.

**Architecture:** The extension gains a small adapter layer. `backend.js` speaks the existing FastAPI job API; `openai.js` speaks `POST /v1/audio/speech` directly. Both expose the same async-generator interface that yields MP3 blobs chunk-by-chunk, so a single sequential player drives playback regardless of target. The FastAPI backend is kept and gains API-key support so it can also proxy to hosted providers.

**Tech Stack:** Firefox WebExtension (Manifest V2, ES modules via a background *page*), vitest for extension unit tests; Python 3.13 / FastAPI / httpx / pytest for the backend.

**Spec:** `docs/openai-tts-spec.md` (OpenAI `/v1/audio/speech` contract, voice-listing caveats, backend-less implications) and `docs/PROVIDERS.md` (which providers are base-URL-swappable vs. need their own adapter).

## Global Constraints

- **Manifest V2 stays.** MV3 migration is explicitly out of scope for this plan (see "Deferred" at the end). Do not change `manifest_version`.
- **The backend is not deleted.** `backend/` and the `readaloud` service in `docker-compose.yml` remain a supported deployment.
- **Only Tier-1 (OpenAI-schema) providers.** Per `docs/PROVIDERS.md`, the direct adapter covers Kokoro, OpenAI, Groq, and LocalAI. Do **not** add ElevenLabs/Google/Polly adapters.
- **Default direct target is the Kokoro container:** `http://localhost:8880`.
- Python: line length 100, `ruff check` + `ruff format` clean, `ty check` clean.
- JS: no build step. Plain ES modules, no bundler, no TypeScript.
- Pin exact dependency versions (`-E` / `==`), never a caret range.
- Never log or transmit `directApiKey` anywhere except the configured `directUrl` host.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `extension/package.json` | vitest devDependency + `test` script. No runtime deps. |
| `extension/background.html` | MV2 background *page* so `background.js` can load as an ES module. |
| `extension/lib/chunker.js` | Port of `backend/src/readaloud/services/text_chunker.py`. |
| `extension/lib/chunker.test.js` | Chunker unit tests. |
| `extension/lib/settings.js` | `storage.local` schema, defaults, migration from the old `serverUrl` key. |
| `extension/lib/settings.test.js` | Settings/migration unit tests. |
| `extension/lib/adapters/openai.js` | Direct `/v1/audio/speech` adapter (Kokoro/OpenAI/Groq/LocalAI). |
| `extension/lib/adapters/openai.test.js` | Direct adapter unit tests. |
| `extension/lib/adapters/backend.js` | FastAPI job-API adapter, streaming per completed chunk. |
| `extension/lib/adapters/backend.test.js` | Backend adapter unit tests. |
| `extension/lib/adapters/index.js` | `pickAdapter(settings)` selector. |
| `extension/lib/player.js` | Sequential blob queue with one chunk of lookahead; pause/resume/stop. |
| `extension/lib/player.test.js` | Player unit tests. |

**Modified**

| File | Change |
|---|---|
| `extension/manifest.json:18-21` | `background.scripts` → `background.page`. |
| `extension/background.js` | Reduced to orchestration: settings → adapter → player. All `fetch` logic moves out. |
| `extension/options/options.html:12-15` | Target selector, direct URL, API key, model fields. |
| `extension/options/options.js` | Read/write the new settings schema; target-aware voice load and connection test. |
| `backend/src/readaloud/config.py:11-15` | Add `TTS_API_KEY`; delete `TTS_MODE`. |
| `backend/src/readaloud/services/tts_client.py:32-39` | Send `Authorization: Bearer` when a key is set. |
| `backend/src/readaloud/routes/voices.py:22-54` | Same auth header. |
| `backend/src/readaloud/routes/health.py:14-19` | Same auth header. |
| `backend/src/readaloud/routes/settings.py` | Delete `PUT`; `GET` drops `tts_mode`. |
| `backend/src/readaloud/models/schemas.py` | Delete `SettingsUpdateRequest`, drop `tts_mode`. |
| `backend/src/readaloud/main.py:11-17` | `allow_credentials=False`. |
| `frontend/src/stores/settings.ts`, `frontend/src/components/SettingsPanel.tsx`, `frontend/src/api/client.ts` | Remove the `tts_mode` radio and the settings-update call. |
| `docker-compose.yml:16,40` | Kokoro host port `8881` → `8880`; pass `READALOUD_TTS_API_KEY`. |
| `.env.example`, `README.md`, `CLAUDE.md` | Document the new env var and the two extension targets. |

---

## Task 0: Commit the pending settings-button change

The working tree has an unrelated in-progress change (a ⚙ button in the popup header). Land it first so later diffs are clean.

**Files:**
- Modify: `extension/popup/popup.css`, `extension/popup/popup.html`, `extension/popup/popup.js`

- [ ] **Step 1: Review the pending diff**

```bash
git diff extension/popup/
```

Expected: three files, ~24 added lines, adding `#btn-settings` and its click handler calling `browser.runtime.openOptionsPage()`.

- [ ] **Step 2: Commit it**

```bash
git add extension/popup/popup.css extension/popup/popup.html extension/popup/popup.js
git commit -m "Add settings shortcut button to popup header"
```

- [ ] **Step 3: Confirm the tree is clean**

```bash
git status --short extension/
```

Expected: no output.

---

## Task 1: Backend API-key support

Without this, backend mode cannot reach OpenAI or Groq — `tts_client.py` currently sends no `Authorization` header at all.

**Files:**
- Modify: `backend/src/readaloud/config.py:11-15`
- Modify: `backend/src/readaloud/services/tts_client.py:32-39`
- Modify: `backend/src/readaloud/routes/voices.py:22-54`
- Modify: `backend/src/readaloud/routes/health.py:14-19`
- Test: `backend/tests/test_tts_client.py`

**Interfaces:**
- Produces: `settings.TTS_API_KEY: str` (empty string = no auth) and `readaloud.config.auth_headers() -> dict[str, str]`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_tts_client.py`:

```python
import httpx
import pytest

from readaloud.config import auth_headers, settings
from readaloud.services.tts_client import TtsClient


def test_auth_headers_empty_when_no_key(monkeypatch):
    monkeypatch.setattr(settings, "TTS_API_KEY", "")
    assert auth_headers() == {}


def test_auth_headers_bearer_when_key_set(monkeypatch):
    monkeypatch.setattr(settings, "TTS_API_KEY", "sk-test-123")
    assert auth_headers() == {"Authorization": "Bearer sk-test-123"}


@pytest.mark.asyncio
async def test_generate_speech_sends_bearer_token(monkeypatch):
    monkeypatch.setattr(settings, "TTS_API_KEY", "sk-test-123")
    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(request.headers)
        return httpx.Response(200, content=b"ID3audio")

    client = TtsClient()
    client._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        audio = await client.generate_speech("hello", "af_heart", "kokoro", 1.0)
    finally:
        await client.close()

    assert audio == b"ID3audio"
    assert seen["authorization"] == "Bearer sk-test-123"


@pytest.mark.asyncio
async def test_generate_speech_omits_auth_header_when_no_key(monkeypatch):
    monkeypatch.setattr(settings, "TTS_API_KEY", "")
    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(request.headers)
        return httpx.Response(200, content=b"ID3audio")

    client = TtsClient()
    client._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        await client.generate_speech("hello", "af_heart", "kokoro", 1.0)
    finally:
        await client.close()

    assert "authorization" not in seen
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd backend && uv run pytest tests/test_tts_client.py -v
```

Expected: FAIL — `ImportError: cannot import name 'auth_headers' from 'readaloud.config'`.

- [ ] **Step 3: Add the setting and helper**

In `backend/src/readaloud/config.py`, add the field to `Settings` and the helper below the singleton:

```python
class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    model_config = {"env_prefix": "READALOUD_"}

    TTS_BASE_URL: str = "http://localhost:8880"
    TTS_MODEL: str = "kokoro"
    TTS_DEFAULT_VOICE: str = "af_heart"
    TTS_API_KEY: str = ""
    MAX_CHUNK_CHARS: int = 4000


settings = Settings()


def auth_headers() -> dict[str, str]:
    """Build the Authorization header for the configured TTS server.

    Returns:
        A dict with a Bearer token when TTS_API_KEY is set, otherwise empty.
        Self-hosted servers such as Kokoro require no key.
    """
    if not settings.TTS_API_KEY:
        return {}
    return {"Authorization": f"Bearer {settings.TTS_API_KEY}"}
```

Note: `TTS_MODE` is deleted here — nothing in the TTS path ever read it. Task 3 removes its remaining UI surface.

- [ ] **Step 4: Send the header from the TTS client**

In `backend/src/readaloud/services/tts_client.py`, change the import and the POST:

```python
from readaloud.config import auth_headers, settings
```

```python
                response = await self._client.post(url, json=payload, headers=auth_headers())
```

- [ ] **Step 5: Send the header from voices and health**

In `backend/src/readaloud/routes/voices.py`, change the import to `from readaloud.config import auth_headers, settings` and add `headers=auth_headers()` to both `client.get(...)` calls.

In `backend/src/readaloud/routes/health.py`, do the same for the single `client.get(...)` call.

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd backend && uv run pytest tests/ -v
```

Expected: PASS, including the pre-existing suite.

- [ ] **Step 7: Lint and commit**

```bash
cd backend && uv run ruff check src/ && uv run ruff format src/
git add backend/src/readaloud/config.py backend/src/readaloud/services/tts_client.py \
        backend/src/readaloud/routes/voices.py backend/src/readaloud/routes/health.py \
        backend/tests/test_tts_client.py
git commit -m "Add optional API key auth for upstream TTS server"
```

---

## Task 2: Remove the mutable settings endpoint and fix CORS

`PUT /api/settings` mutates a process-global singleton, so one client's write changes the TTS target for every other client — and combined with `allow_origins=["*"]`, any webpage you visit can repoint the backend at a server it controls and receive everything you subsequently read aloud. Removing the endpoint closes it.

**Files:**
- Modify: `backend/src/readaloud/routes/settings.py`
- Modify: `backend/src/readaloud/models/schemas.py`
- Modify: `backend/src/readaloud/main.py:11-17`
- Modify: `frontend/src/api/client.ts`, `frontend/src/stores/settings.ts`, `frontend/src/components/SettingsPanel.tsx`
- Test: `backend/tests/test_routes.py`

**Interfaces:**
- Consumes: `settings.TTS_API_KEY` from Task 1.
- Produces: `GET /api/settings` returning `{tts_base_url, tts_model, tts_default_voice}` — no `tts_mode`, no `PUT`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_routes.py`:

```python
def test_settings_get_returns_config(client):
    response = client.get("/api/settings")
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"tts_base_url", "tts_model", "tts_default_voice"}


def test_settings_put_is_gone(client):
    response = client.put("/api/settings", json={"tts_base_url": "http://evil.test"})
    assert response.status_code == 405


def test_settings_get_never_leaks_api_key(client, monkeypatch):
    from readaloud.config import settings as app_settings

    monkeypatch.setattr(app_settings, "TTS_API_KEY", "sk-secret")
    body = client.get("/api/settings").json()
    assert "sk-secret" not in response_text(body)


def response_text(body) -> str:
    import json

    return json.dumps(body)
```

If `test_routes.py` has no `client` fixture, add one at the top of the file:

```python
import pytest
from fastapi.testclient import TestClient

from readaloud.main import app


@pytest.fixture
def client():
    return TestClient(app)
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd backend && uv run pytest tests/test_routes.py -v -k settings
```

Expected: FAIL — `test_settings_put_is_gone` gets 200, `test_settings_get_returns_config` sees an extra `tts_mode` key.

- [ ] **Step 3: Replace the settings route**

Replace the whole body of `backend/src/readaloud/routes/settings.py`:

```python
from fastapi import APIRouter

from readaloud.config import settings
from readaloud.models.schemas import SettingsResponse

router = APIRouter()


@router.get("/settings")
async def get_settings() -> SettingsResponse:
    """Return the server's TTS configuration.

    Read-only by design: these values come from environment variables. Never
    includes the API key.
    """
    return SettingsResponse(
        tts_base_url=settings.TTS_BASE_URL,
        tts_model=settings.TTS_MODEL,
        tts_default_voice=settings.TTS_DEFAULT_VOICE,
    )
```

- [ ] **Step 4: Update the schemas**

In `backend/src/readaloud/models/schemas.py`, delete the `SettingsUpdateRequest` class entirely and remove the `tts_mode` field from `SettingsResponse`.

- [ ] **Step 5: Fix the CORS configuration**

In `backend/src/readaloud/main.py`:

```python
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)
```

`allow_origins=["*"]` with `allow_credentials=True` is rejected by browsers anyway; the API uses no cookies or auth, so `False` is both correct and safe.

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd backend && uv run pytest tests/ -v
```

Expected: PASS.

- [ ] **Step 7: Remove the frontend's use of the deleted endpoint**

- `frontend/src/api/client.ts`: delete the `updateSettings` function (the `PUT "/api/settings"` request).
- `frontend/src/stores/settings.ts`: remove the `tts_mode` field from the interface and its default.
- `frontend/src/components/SettingsPanel.tsx`: delete the `tts_mode` local/remote radio group (the two `<input name="tts_mode">` blocks and their wrapper) and the `tts_mode` entry in the props interface.

- [ ] **Step 8: Verify the frontend still typechecks**

```bash
cd frontend && pnpm build
```

Expected: build succeeds, no TS errors.

- [ ] **Step 9: Lint and commit**

```bash
cd backend && uv run ruff check src/ && uv run ruff format src/
git add backend/src/readaloud/routes/settings.py backend/src/readaloud/models/schemas.py \
        backend/src/readaloud/main.py backend/tests/test_routes.py frontend/src
git commit -m "Make settings endpoint read-only and tighten CORS"
```

---

## Task 3: Extension ES modules, test harness, and the text chunker

MV2 background *scripts* are classic scripts and cannot use `import`. Switching to a background *page* lets every extension module be a real ES module, which is also what makes it unit-testable. This task does that switch and lands the first module.

**Files:**
- Create: `extension/package.json`
- Create: `extension/background.html`
- Create: `extension/lib/chunker.js`
- Create: `extension/lib/chunker.test.js`
- Modify: `extension/manifest.json:18-21`

**Interfaces:**
- Produces: `chunkText(text: string, maxChars: number) => string[]` — never returns empty strings; returns `[]` for blank input.

- [ ] **Step 1: Create the package manifest and install vitest**

```bash
cd extension
cat > package.json <<'EOF'
{
  "name": "readaloud-extension",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run"
  }
}
EOF
pnpm add -D -E vitest
```

`-E` pins the exact resolved version rather than a caret range.

- [ ] **Step 2: Write the failing test**

Create `extension/lib/chunker.test.js`:

```js
import { describe, expect, it } from "vitest";

import { chunkText } from "./chunker.js";

describe("chunkText", () => {
  it("returns an empty array for blank input", () => {
    expect(chunkText("", 100)).toEqual([]);
    expect(chunkText("   \n\n  ", 100)).toEqual([]);
  });

  it("returns a single chunk when the text fits", () => {
    expect(chunkText("Hello world.", 100)).toEqual(["Hello world."]);
  });

  it("trims surrounding whitespace", () => {
    expect(chunkText("  Hello world.  ", 100)).toEqual(["Hello world."]);
  });

  it("splits on paragraph boundaries first", () => {
    const text = "A".repeat(60) + "\n\n" + "B".repeat(60);
    expect(chunkText(text, 100)).toEqual(["A".repeat(60), "B".repeat(60)]);
  });

  it("packs several short paragraphs into one chunk", () => {
    const text = "One.\n\nTwo.\n\nThree.";
    expect(chunkText(text, 100)).toEqual(["One.\n\nTwo.\n\nThree."]);
  });

  it("falls back to sentence boundaries for a long paragraph", () => {
    const text = "A".repeat(60) + ". " + "B".repeat(60) + ".";
    const chunks = chunkText(text, 100);
    expect(chunks).toEqual(["A".repeat(60) + ".", "B".repeat(60) + "."]);
  });

  it("falls back to word boundaries for a long sentence", () => {
    const text = Array.from({ length: 40 }, () => "word").join(" ");
    const chunks = chunkText(text, 50);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(50);
    }
    expect(chunks.join(" ")).toEqual(text);
  });

  it("never emits an empty chunk", () => {
    const text = "One.\n\n\n\n\n\nTwo.";
    expect(chunkText(text, 10).every((c) => c.trim().length > 0)).toBe(true);
  });

  it("emits a chunk for a single word longer than the limit", () => {
    const chunks = chunkText("X".repeat(30), 10);
    expect(chunks).toEqual(["X".repeat(30)]);
  });
});
```

The last case documents deliberate behaviour: an unbreakable token is emitted whole rather than sliced mid-word. `backend/src/readaloud/services/text_chunker.py` behaves the same way.

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd extension && pnpm test
```

Expected: FAIL — `Failed to resolve import "./chunker.js"`.

- [ ] **Step 4: Write the chunker**

Create `extension/lib/chunker.js`:

```js
/**
 * Split text into chunks that fit within maxChars.
 *
 * Mirrors backend/src/readaloud/services/text_chunker.py. Splitting order:
 * paragraph boundaries, then sentence boundaries, then word boundaries.
 * A single word longer than maxChars is emitted whole.
 */
export function chunkText(text, maxChars) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= maxChars) return [trimmed];

  return packSegments(trimmed.split(/\n\n+/), maxChars, "\n\n", (paragraph) =>
    splitLongParagraph(paragraph, maxChars),
  );
}

function splitLongParagraph(text, maxChars) {
  return packSegments(text.split(/(?<=[.!?])\s+/), maxChars, " ", (sentence) =>
    splitLongSentence(sentence, maxChars),
  );
}

function splitLongSentence(text, maxChars) {
  const words = text.split(/\s+/).filter(Boolean);
  return packSegments(words, maxChars, " ", (word) => [word]);
}

/**
 * Greedily pack segments into chunks, delegating oversized segments to a
 * finer-grained splitter.
 */
function packSegments(segments, maxChars, joiner, splitOversized) {
  const chunks = [];
  let current = "";

  for (const segment of segments) {
    if (!segment.trim()) continue;

    if (segment.length > maxChars) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      chunks.push(...splitOversized(segment));
    } else if (current && current.length + joiner.length + segment.length > maxChars) {
      chunks.push(current);
      current = segment;
    } else if (current) {
      current = current + joiner + segment;
    } else {
      current = segment;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd extension && pnpm test
```

Expected: PASS, 9 tests.

- [ ] **Step 6: Switch the background script to a module-capable page**

Create `extension/background.html`:

```html
<!DOCTYPE html>
<meta charset="utf-8">
<title>ReadAloud background</title>
<script type="module" src="background.js"></script>
```

In `extension/manifest.json`, replace the `background` block:

```json
  "background": {
    "page": "background.html",
    "persistent": true
  },
```

- [ ] **Step 7: Verify the extension still loads**

Load the extension via `about:debugging` → This Firefox → Load Temporary Add-on → `extension/manifest.json`. Open the background page's console.

Expected: no errors, and "ReadAloud: Read Selection" still appears in the right-click menu on selected text. Behaviour is unchanged — only the loading mechanism moved.

- [ ] **Step 8: Commit**

```bash
git add extension/package.json extension/pnpm-lock.yaml extension/background.html \
        extension/manifest.json extension/lib/chunker.js extension/lib/chunker.test.js
git commit -m "Load background as an ES module page and add JS text chunker"
```

Also add `extension/node_modules/` to `.gitignore` if it is not already covered.

---

## Task 4: Settings module with target selection and migration

**Files:**
- Create: `extension/lib/settings.js`
- Create: `extension/lib/settings.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `DEFAULT_SETTINGS` — the frozen default object.
  - `loadSettings() => Promise<Settings>` — reads `storage.local`, applies defaults, migrates the legacy `serverUrl` key.
  - `saveSettings(partial) => Promise<void>`.
  - `Settings` shape: `{ttsTarget: "backend"|"direct", backendUrl: string, directUrl: string, directApiKey: string, directModel: string, defaultVoice: string, defaultSpeed: number}`.

- [ ] **Step 1: Write the failing test**

Create `extension/lib/settings.test.js`:

```js
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "./settings.js";

function mockStorage(initial = {}) {
  let store = { ...initial };
  globalThis.browser = {
    storage: {
      local: {
        get: vi.fn(async (keys) => {
          if (keys === null || keys === undefined) return { ...store };
          const wanted = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(
            wanted.filter((k) => k in store).map((k) => [k, store[k]]),
          );
        }),
        set: vi.fn(async (values) => {
          store = { ...store, ...values };
        }),
        remove: vi.fn(async (keys) => {
          for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
        }),
      },
    },
  };
  return () => store;
}

describe("loadSettings", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns defaults on a fresh install", async () => {
    mockStorage({});
    await expect(loadSettings()).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it("defaults the direct target to the Kokoro container port", () => {
    expect(DEFAULT_SETTINGS.directUrl).toBe("http://localhost:8880");
    expect(DEFAULT_SETTINGS.ttsTarget).toBe("backend");
  });

  it("migrates the legacy serverUrl key to backendUrl", async () => {
    const read = mockStorage({ serverUrl: "http://192.168.1.5:8000" });
    const settings = await loadSettings();
    expect(settings.backendUrl).toBe("http://192.168.1.5:8000");
    expect(settings.ttsTarget).toBe("backend");
    expect(read().serverUrl).toBeUndefined();
    expect(read().backendUrl).toBe("http://192.168.1.5:8000");
  });

  it("does not clobber an existing backendUrl during migration", async () => {
    mockStorage({ serverUrl: "http://old.test", backendUrl: "http://new.test" });
    const settings = await loadSettings();
    expect(settings.backendUrl).toBe("http://new.test");
  });

  it("strips trailing slashes from both URLs", async () => {
    mockStorage({ backendUrl: "http://a.test:8000//", directUrl: "http://b.test:8880/" });
    const settings = await loadSettings();
    expect(settings.backendUrl).toBe("http://a.test:8000");
    expect(settings.directUrl).toBe("http://b.test:8880");
  });

  it("falls back to defaults for an unrecognised target", async () => {
    mockStorage({ ttsTarget: "carrier-pigeon" });
    await expect(loadSettings()).resolves.toMatchObject({ ttsTarget: "backend" });
  });
});

describe("saveSettings", () => {
  it("writes only the provided keys", async () => {
    const read = mockStorage({ defaultSpeed: 1.5 });
    await saveSettings({ ttsTarget: "direct" });
    expect(read().ttsTarget).toBe("direct");
    expect(read().defaultSpeed).toBe(1.5);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd extension && pnpm test settings
```

Expected: FAIL — cannot resolve `./settings.js`.

- [ ] **Step 3: Write the settings module**

Create `extension/lib/settings.js`:

```js
export const TARGET_BACKEND = "backend";
export const TARGET_DIRECT = "direct";

export const DEFAULT_SETTINGS = Object.freeze({
  ttsTarget: TARGET_BACKEND,
  backendUrl: "http://localhost:8000",
  directUrl: "http://localhost:8880",
  directApiKey: "",
  directModel: "kokoro",
  defaultVoice: "",
  defaultSpeed: 1.0,
});

const KEYS = Object.keys(DEFAULT_SETTINGS);

function stripTrailingSlashes(url) {
  return String(url).replace(/\/+$/, "");
}

/**
 * Read settings from storage.local, applying defaults and migrating the
 * pre-target `serverUrl` key used by versions <= 1.0.0.
 */
export async function loadSettings() {
  const stored = await browser.storage.local.get([...KEYS, "serverUrl"]);

  if (stored.serverUrl) {
    if (!stored.backendUrl) {
      stored.backendUrl = stored.serverUrl;
      await browser.storage.local.set({ backendUrl: stored.backendUrl });
    }
    await browser.storage.local.remove("serverUrl");
  }

  const settings = { ...DEFAULT_SETTINGS };
  for (const key of KEYS) {
    if (stored[key] !== undefined && stored[key] !== null && stored[key] !== "") {
      settings[key] = stored[key];
    }
  }

  if (settings.ttsTarget !== TARGET_BACKEND && settings.ttsTarget !== TARGET_DIRECT) {
    settings.ttsTarget = DEFAULT_SETTINGS.ttsTarget;
  }
  settings.backendUrl = stripTrailingSlashes(settings.backendUrl);
  settings.directUrl = stripTrailingSlashes(settings.directUrl);
  settings.defaultSpeed = Number(settings.defaultSpeed) || DEFAULT_SETTINGS.defaultSpeed;

  return settings;
}

/** Persist a partial settings update. */
export async function saveSettings(partial) {
  const update = {};
  for (const key of KEYS) {
    if (key in partial) update[key] = partial[key];
  }
  await browser.storage.local.set(update);
}
```

Note `directApiKey` and `defaultVoice` default to `""`, and the loop skips empty values — an empty key stays empty, which is exactly what Kokoro needs.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd extension && pnpm test settings
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add extension/lib/settings.js extension/lib/settings.test.js
git commit -m "Add extension settings module with TTS target and migration"
```

---

## Task 5: Direct OpenAI-compatible adapter

**Files:**
- Create: `extension/lib/adapters/openai.js`
- Create: `extension/lib/adapters/openai.test.js`

**Interfaces:**
- Consumes: `chunkText` (Task 3); `Settings` (Task 4).
- Produces the adapter contract that Task 6 also implements and Tasks 7–8 consume:

```js
{
  id: string,
  maxInputChars: number,
  listVoices(settings) => Promise<Array<{id: string, name: string}>>,
  checkHealth(settings) => Promise<{ok: boolean, detail: string}>,
  synthesize({text, voice, speed, settings, signal, onProgress}) =>
    AsyncGenerator<{audio: Blob, index: number, total: number}>,
}
```

`onProgress({chunksCompleted, chunksTotal, progress})` is called before the first chunk and after each one.

- [ ] **Step 1: Write the failing test**

Create `extension/lib/adapters/openai.test.js`:

```js
import { beforeEach, describe, expect, it, vi } from "vitest";

import { openaiAdapter } from "./openai.js";

const settings = {
  directUrl: "http://localhost:8880",
  directApiKey: "",
  directModel: "kokoro",
};

function jsonResponse(body, status = 200) {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function blobResponse(bytes) {
  return { ok: true, status: 200, blob: async () => new Blob([bytes], { type: "audio/mpeg" }) };
}

async function collect(generator) {
  const out = [];
  for await (const item of generator) out.push(item);
  return out;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("listVoices", () => {
  it("reads Kokoro's {voices: [{id}]} shape", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ voices: [{ id: "af_heart", name: "Heart" }, { id: "am_adam" }] }),
    );
    await expect(openaiAdapter.listVoices(settings)).resolves.toEqual([
      { id: "af_heart", name: "Heart" },
      { id: "am_adam", name: "am_adam" },
    ]);
  });

  it("reads a bare array of voice id strings", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse(["af_heart", "am_adam"]));
    await expect(openaiAdapter.listVoices(settings)).resolves.toEqual([
      { id: "af_heart", name: "af_heart" },
      { id: "am_adam", name: "am_adam" },
    ]);
  });

  it("falls back to the built-in OpenAI voices when the endpoint 404s", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ detail: "Not Found" }, 404));
    const voices = await openaiAdapter.listVoices(settings);
    expect(voices.map((v) => v.id)).toContain("alloy");
    expect(voices.map((v) => v.id)).toContain("nova");
  });

  it("falls back when the network throws", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("NetworkError");
    });
    await expect(openaiAdapter.listVoices(settings)).resolves.not.toHaveLength(0);
  });
});

describe("synthesize", () => {
  it("posts one request per chunk and yields a blob each", async () => {
    const calls = [];
    globalThis.fetch = vi.fn(async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return blobResponse("audio");
    });

    const text = "A".repeat(5000) + "\n\n" + "B".repeat(100);
    const progress = [];
    const results = await collect(
      openaiAdapter.synthesize({
        text,
        voice: "af_heart",
        speed: 1.2,
        settings,
        signal: new AbortController().signal,
        onProgress: (p) => progress.push(p),
      }),
    );

    expect(results.length).toBeGreaterThan(1);
    expect(results[0].audio).toBeInstanceOf(Blob);
    expect(results[0].total).toBe(results.length);
    expect(calls[0].url).toBe("http://localhost:8880/v1/audio/speech");
    expect(calls[0].body).toMatchObject({
      model: "kokoro",
      voice: "af_heart",
      speed: 1.2,
      response_format: "mp3",
    });
    expect(progress.at(-1)).toMatchObject({ progress: 1 });
  });

  it("omits the Authorization header when no key is set", async () => {
    let seen = null;
    globalThis.fetch = vi.fn(async (_url, options) => {
      seen = options.headers;
      return blobResponse("audio");
    });
    await collect(
      openaiAdapter.synthesize({
        text: "Hello.",
        voice: "af_heart",
        speed: 1,
        settings,
        signal: new AbortController().signal,
        onProgress: () => {},
      }),
    );
    expect(seen.Authorization).toBeUndefined();
  });

  it("sends a bearer token when a key is set", async () => {
    let seen = null;
    globalThis.fetch = vi.fn(async (_url, options) => {
      seen = options.headers;
      return blobResponse("audio");
    });
    await collect(
      openaiAdapter.synthesize({
        text: "Hello.",
        voice: "alloy",
        speed: 1,
        settings: { ...settings, directApiKey: "sk-abc" },
        signal: new AbortController().signal,
        onProgress: () => {},
      }),
    );
    expect(seen.Authorization).toBe("Bearer sk-abc");
  });

  it("retries a failed chunk then succeeds", async () => {
    let attempts = 0;
    globalThis.fetch = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("NetworkError");
      return blobResponse("audio");
    });
    const results = await collect(
      openaiAdapter.synthesize({
        text: "Hello.",
        voice: "af_heart",
        speed: 1,
        settings,
        signal: new AbortController().signal,
        onProgress: () => {},
      }),
    );
    expect(attempts).toBe(2);
    expect(results).toHaveLength(1);
  });

  it("surfaces the OpenAI error message after exhausting retries", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ error: { message: "Invalid voice: bogus" } }, 400),
    );
    await expect(
      collect(
        openaiAdapter.synthesize({
          text: "Hello.",
          voice: "bogus",
          speed: 1,
          settings,
          signal: new AbortController().signal,
          onProgress: () => {},
        }),
      ),
    ).rejects.toThrow(/Invalid voice: bogus/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd extension && pnpm test openai
```

Expected: FAIL — cannot resolve `./openai.js`.

- [ ] **Step 3: Write the adapter**

Create `extension/lib/adapters/openai.js`:

```js
import { chunkText } from "../chunker.js";

/**
 * OpenAI's hard `input` cap is 4096 characters. 4000 leaves headroom and
 * matches the backend's READALOUD_MAX_CHUNK_CHARS default. Self-hosted
 * servers such as Kokoro have no cap, but chunking still lets playback
 * start before the whole article is synthesised.
 */
const MAX_INPUT_CHARS = 4000;
const MAX_ATTEMPTS = 3;

/**
 * OpenAI publishes no endpoint for enumerating voices, so this is the
 * documented built-in set from docs/openai-tts-spec.md. Used when the server
 * does not implement Kokoro's non-standard GET /v1/audio/voices.
 */
const FALLBACK_VOICES = [
  "alloy", "ash", "ballad", "coral", "echo", "fable", "onyx",
  "nova", "sage", "shimmer", "verse", "marin", "cedar",
].map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1) }));

function headers(settings, extra = {}) {
  const result = { ...extra };
  if (settings.directApiKey) {
    result.Authorization = `Bearer ${settings.directApiKey}`;
  }
  return result;
}

function toVoice(entry) {
  if (typeof entry === "string") return { id: entry, name: entry };
  const id = entry?.id ?? "";
  return { id, name: entry?.name || id };
}

async function describeError(response) {
  let detail = `HTTP ${response.status}`;
  try {
    const body = await response.json();
    if (body?.error?.message) detail = body.error.message;
    else if (body?.detail) detail = String(body.detail);
  } catch {
    // Body was not JSON; the status code is the best we have.
  }
  return detail;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

export const openaiAdapter = {
  id: "openai",
  maxInputChars: MAX_INPUT_CHARS,

  /**
   * List voices via Kokoro's GET /v1/audio/voices, falling back to the
   * documented OpenAI voice set. /v1/models is deliberately not consulted:
   * on real OpenAI it returns model names, not voices.
   */
  async listVoices(settings) {
    try {
      const response = await fetch(`${settings.directUrl}/v1/audio/voices`, {
        headers: headers(settings),
      });
      if (response.ok) {
        const data = await response.json();
        const raw = Array.isArray(data) ? data : data?.voices || [];
        const voices = raw.map(toVoice).filter((v) => v.id);
        if (voices.length) return voices;
      }
    } catch {
      // Server does not implement the endpoint, or is unreachable.
    }
    return FALLBACK_VOICES;
  },

  async checkHealth(settings) {
    for (const path of ["/health", "/v1/models"]) {
      try {
        const response = await fetch(`${settings.directUrl}${path}`, {
          headers: headers(settings),
        });
        if (response.status < 500) {
          return { ok: true, detail: `Reachable (${path})` };
        }
      } catch {
        // Try the next probe.
      }
    }
    return { ok: false, detail: "TTS server unreachable" };
  },

  async *synthesize({ text, voice, speed, settings, signal, onProgress }) {
    const chunks = chunkText(text, MAX_INPUT_CHARS);
    const total = chunks.length;
    onProgress({ chunksCompleted: 0, chunksTotal: total, progress: 0 });

    for (let index = 0; index < total; index++) {
      const audio = await requestChunk(chunks[index], voice, speed, settings, signal);
      onProgress({
        chunksCompleted: index + 1,
        chunksTotal: total,
        progress: (index + 1) / total,
      });
      yield { audio, index, total };
    }
  },
};

async function requestChunk(input, voice, speed, settings, signal) {
  const url = `${settings.directUrl}/v1/audio/speech`;
  const body = JSON.stringify({
    model: settings.directModel || "kokoro",
    input,
    voice,
    speed,
    response_format: "mp3",
  });

  let lastError = "unknown error";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: headers(settings, { "Content-Type": "application/json" }),
        body,
        signal,
      });
      if (response.ok) return await response.blob();
      lastError = await describeError(response);
    } catch (err) {
      if (err.name === "AbortError") throw err;
      lastError = err.message;
    }
    if (attempt < MAX_ATTEMPTS - 1) {
      await sleep(2 ** attempt * 1000, signal);
    }
  }
  throw new Error(`TTS request failed after ${MAX_ATTEMPTS} attempts: ${lastError}`);
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd extension && pnpm test openai
```

Expected: PASS, 8 tests. The retry test takes ~1s because of the backoff sleep.

- [ ] **Step 5: Commit**

```bash
git add extension/lib/adapters/openai.js extension/lib/adapters/openai.test.js
git commit -m "Add direct OpenAI-compatible TTS adapter"
```

---

## Task 6: Backend job-API adapter

This adapter finally uses `GET /api/tts/audio/{job_id}/{chunk_index}` (`backend/src/readaloud/routes/tts.py:158-169`), which is implemented but currently called by nothing. Streaming per completed chunk gives backend mode the same start-playing-early behaviour as direct mode.

**Files:**
- Create: `extension/lib/adapters/backend.js`
- Create: `extension/lib/adapters/backend.test.js`
- Create: `extension/lib/adapters/index.js`

**Interfaces:**
- Consumes: the adapter contract defined in Task 5; `TARGET_BACKEND` / `TARGET_DIRECT` from Task 4.
- Produces: `backendAdapter` (same shape as `openaiAdapter`) and `pickAdapter(settings) => adapter`.

- [ ] **Step 1: Write the failing test**

Create `extension/lib/adapters/backend.test.js`:

```js
import { beforeEach, describe, expect, it, vi } from "vitest";

import { backendAdapter } from "./backend.js";
import { pickAdapter } from "./index.js";
import { openaiAdapter } from "./openai.js";

const settings = { backendUrl: "http://localhost:8000" };

function jsonResponse(body, status = 200) {
  return { ok: status < 400, status, json: async () => body, text: async () => "" };
}

function blobResponse() {
  return { ok: true, status: 200, blob: async () => new Blob(["audio"], { type: "audio/mpeg" }) };
}

async function collect(generator) {
  const out = [];
  for await (const item of generator) out.push(item);
  return out;
}

function run(overrides = {}) {
  return collect(
    backendAdapter.synthesize({
      text: "Hello.",
      voice: "af_heart",
      speed: 1,
      settings,
      signal: new AbortController().signal,
      onProgress: () => {},
      ...overrides,
    }),
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("pickAdapter", () => {
  it("returns the backend adapter for the backend target", () => {
    expect(pickAdapter({ ttsTarget: "backend" })).toBe(backendAdapter);
  });

  it("returns the direct adapter for the direct target", () => {
    expect(pickAdapter({ ttsTarget: "direct" })).toBe(openaiAdapter);
  });

  it("defaults to the backend adapter for an unknown target", () => {
    expect(pickAdapter({ ttsTarget: "nonsense" })).toBe(backendAdapter);
  });
});

describe("synthesize", () => {
  it("yields immediately when the job completes synchronously", async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (url.endsWith("/api/tts/generate")) {
        return jsonResponse({ job_id: "j1", status: "complete" });
      }
      return blobResponse();
    });

    const results = await run();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ index: 0, total: 1 });
    expect(globalThis.fetch.mock.calls.at(-1)[0]).toBe(
      "http://localhost:8000/api/tts/audio/j1",
    );
  });

  it("polls and yields each chunk as it becomes ready", async () => {
    const statuses = [
      { status: "processing", progress: 0.5, chunks_completed: 1, chunks_total: 2 },
      { status: "complete", progress: 1, chunks_completed: 2, chunks_total: 2 },
    ];
    let poll = 0;
    const fetched = [];

    globalThis.fetch = vi.fn(async (url) => {
      fetched.push(url);
      if (url.endsWith("/api/tts/generate")) {
        return jsonResponse({ job_id: "j2", status: "processing" });
      }
      if (url.includes("/api/tts/status/")) {
        return jsonResponse(statuses[Math.min(poll++, statuses.length - 1)]);
      }
      return blobResponse();
    });

    const results = await run();
    expect(results.map((r) => r.index)).toEqual([0, 1]);
    expect(fetched).toContain("http://localhost:8000/api/tts/audio/j2/0");
    expect(fetched).toContain("http://localhost:8000/api/tts/audio/j2/1");
  });

  it("throws with the job error when the job fails", async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (url.endsWith("/api/tts/generate")) {
        return jsonResponse({ job_id: "j3", status: "processing" });
      }
      return jsonResponse({
        status: "failed",
        error: "upstream refused",
        progress: 0,
        chunks_completed: 0,
        chunks_total: 3,
      });
    });

    await expect(run()).rejects.toThrow(/upstream refused/);
  });

  it("reports progress from the poll response", async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (url.endsWith("/api/tts/generate")) {
        return jsonResponse({ job_id: "j4", status: "processing" });
      }
      if (url.includes("/api/tts/status/")) {
        return jsonResponse({
          status: "complete",
          progress: 1,
          chunks_completed: 1,
          chunks_total: 1,
        });
      }
      return blobResponse();
    });

    const progress = [];
    await run({ onProgress: (p) => progress.push(p) });
    expect(progress.at(-1)).toMatchObject({ chunksTotal: 1, progress: 1 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd extension && pnpm test backend
```

Expected: FAIL — cannot resolve `./backend.js`.

- [ ] **Step 3: Write the backend adapter**

Create `extension/lib/adapters/backend.js`:

```js
const POLL_INTERVAL_MS = 1000;

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

async function backendJson(settings, path, options = {}) {
  const response = await fetch(`${settings.backendUrl}${path}`, options);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${response.status}: ${body}`);
  }
  return response.json();
}

async function fetchAudio(settings, path, signal) {
  const response = await fetch(`${settings.backendUrl}${path}`, { signal });
  if (!response.ok) {
    throw new Error(`Failed to fetch audio: ${response.status}`);
  }
  return response.blob();
}

export const backendAdapter = {
  id: "backend",
  /** The backend chunks server-side, so the extension sends the full text. */
  maxInputChars: Infinity,

  async listVoices(settings) {
    const voices = await backendJson(settings, "/api/voices");
    return voices.map((v) => ({ id: v.id, name: v.name || v.id }));
  },

  async checkHealth(settings) {
    try {
      const data = await backendJson(settings, "/api/health");
      return data.status === "healthy"
        ? { ok: true, detail: "Backend and TTS server reachable" }
        : { ok: false, detail: `Backend up, TTS server ${data.tts_server}` };
    } catch (err) {
      return { ok: false, detail: `Backend unreachable: ${err.message}` };
    }
  },

  async *synthesize({ text, voice, speed, settings, signal, onProgress }) {
    const body = { text: text.trim() };
    if (voice) body.voice = voice;
    if (speed) body.speed = speed;

    const job = await backendJson(settings, "/api/tts/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });

    if (job.status === "complete") {
      onProgress({ chunksCompleted: 1, chunksTotal: 1, progress: 1 });
      yield {
        audio: await fetchAudio(settings, `/api/tts/audio/${job.job_id}`, signal),
        index: 0,
        total: 1,
      };
      return;
    }

    let nextChunk = 0;
    for (;;) {
      const status = await backendJson(settings, `/api/tts/status/${job.job_id}`, { signal });
      onProgress({
        chunksCompleted: status.chunks_completed,
        chunksTotal: status.chunks_total,
        progress: status.progress,
      });

      if (status.status === "failed") {
        throw new Error(status.error || "TTS generation failed");
      }

      while (nextChunk < status.chunks_completed) {
        yield {
          audio: await fetchAudio(
            settings,
            `/api/tts/audio/${job.job_id}/${nextChunk}`,
            signal,
          ),
          index: nextChunk,
          total: status.chunks_total,
        };
        nextChunk += 1;
      }

      if (status.status === "complete" && nextChunk >= status.chunks_total) return;
      await sleep(POLL_INTERVAL_MS, signal);
    }
  },
};
```

The poll interval drops from the old 2000 ms to 1000 ms: chunks are now consumed as they land, so the interval is first-audio latency rather than a background progress tick.

- [ ] **Step 4: Write the selector**

Create `extension/lib/adapters/index.js`:

```js
import { TARGET_DIRECT } from "../settings.js";
import { backendAdapter } from "./backend.js";
import { openaiAdapter } from "./openai.js";

/** Choose the TTS adapter for the configured target. */
export function pickAdapter(settings) {
  return settings.ttsTarget === TARGET_DIRECT ? openaiAdapter : backendAdapter;
}

export { backendAdapter, openaiAdapter };
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd extension && pnpm test
```

Expected: PASS, all suites.

- [ ] **Step 6: Commit**

```bash
git add extension/lib/adapters/backend.js extension/lib/adapters/backend.test.js \
        extension/lib/adapters/index.js
git commit -m "Add backend job-API adapter with per-chunk streaming"
```

---

## Task 7: Sequential player

**Files:**
- Create: `extension/lib/player.js`
- Create: `extension/lib/player.test.js`

**Interfaces:**
- Consumes: the `{audio, index, total}` async generator from Tasks 5–6.
- Produces: `createPlayer({audioElement}) => {play, pause, resume, stop, get phase}`.
  - `play(generator) => Promise<void>` — resolves when the last chunk finishes or `stop()` is called; rejects if the generator throws.
  - `phase` is one of `"idle" | "playing" | "paused"`.

- [ ] **Step 1: Write the failing test**

Create `extension/lib/player.test.js`:

```js
import { describe, expect, it, vi } from "vitest";

import { createPlayer } from "./player.js";

/** Minimal stand-in for HTMLAudioElement driven manually by the test. */
function fakeAudio() {
  return {
    src: "",
    paused: true,
    onended: null,
    onerror: null,
    played: [],
    play: vi.fn(function () {
      this.paused = false;
      this.played.push(this.src);
      return Promise.resolve();
    }),
    pause: vi.fn(function () {
      this.paused = true;
    }),
    finish() {
      this.onended?.();
    },
  };
}

async function* chunks(count) {
  for (let index = 0; index < count; index++) {
    yield { audio: new Blob([`chunk${index}`]), index, total: count };
  }
}

function setupObjectUrls() {
  let counter = 0;
  globalThis.URL.createObjectURL = vi.fn(() => `blob:chunk-${counter++}`);
  globalThis.URL.revokeObjectURL = vi.fn();
}

describe("createPlayer", () => {
  it("plays chunks in order and resolves when done", async () => {
    setupObjectUrls();
    const audio = fakeAudio();
    const player = createPlayer({ audioElement: audio });

    const done = player.play(chunks(3));
    for (let i = 0; i < 3; i++) {
      await vi.waitFor(() => expect(audio.play).toHaveBeenCalledTimes(i + 1));
      audio.finish();
    }
    await done;

    expect(audio.played).toEqual(["blob:chunk-0", "blob:chunk-1", "blob:chunk-2"]);
    expect(player.phase).toBe("idle");
  });

  it("revokes every object URL it creates", async () => {
    setupObjectUrls();
    const audio = fakeAudio();
    const player = createPlayer({ audioElement: audio });

    const done = player.play(chunks(2));
    for (let i = 0; i < 2; i++) {
      await vi.waitFor(() => expect(audio.play).toHaveBeenCalledTimes(i + 1));
      audio.finish();
    }
    await done;

    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it("pauses and resumes the underlying element", async () => {
    setupObjectUrls();
    const audio = fakeAudio();
    const player = createPlayer({ audioElement: audio });

    const done = player.play(chunks(1));
    await vi.waitFor(() => expect(audio.play).toHaveBeenCalledTimes(1));

    player.pause();
    expect(audio.pause).toHaveBeenCalled();
    expect(player.phase).toBe("paused");

    player.resume();
    expect(player.phase).toBe("playing");
    expect(audio.play).toHaveBeenCalledTimes(2);

    audio.finish();
    await done;
  });

  it("stops mid-stream without playing later chunks", async () => {
    setupObjectUrls();
    const audio = fakeAudio();
    const player = createPlayer({ audioElement: audio });

    const done = player.play(chunks(5));
    await vi.waitFor(() => expect(audio.play).toHaveBeenCalledTimes(1));
    player.stop();
    await done;

    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(player.phase).toBe("idle");
  });

  it("propagates a generator failure", async () => {
    setupObjectUrls();
    const audio = fakeAudio();
    const player = createPlayer({ audioElement: audio });

    async function* boom() {
      throw new Error("synthesis failed");
    }

    await expect(player.play(boom())).rejects.toThrow(/synthesis failed/);
    expect(player.phase).toBe("idle");
  });

  it("reports a playback error", async () => {
    setupObjectUrls();
    const audio = fakeAudio();
    const player = createPlayer({ audioElement: audio });

    const done = player.play(chunks(1));
    await vi.waitFor(() => expect(audio.play).toHaveBeenCalledTimes(1));
    audio.onerror();

    await expect(done).rejects.toThrow(/playback failed/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd extension && pnpm test player
```

Expected: FAIL — cannot resolve `./player.js`.

- [ ] **Step 3: Write the player**

Create `extension/lib/player.js`:

```js
/**
 * Play a stream of MP3 blobs back to back.
 *
 * Exactly one chunk of lookahead: the generator is asked for chunk N+1 as
 * soon as chunk N starts playing, so synthesis overlaps playback without
 * buffering the whole article in memory.
 */
export function createPlayer({ audioElement } = {}) {
  const audio = audioElement || new Audio();
  let currentUrl = null;
  let phase = "idle";
  let stopped = false;
  let settleCurrent = null;

  function releaseUrl() {
    if (currentUrl) {
      URL.revokeObjectURL(currentUrl);
      currentUrl = null;
    }
  }

  function playBlob(blob) {
    return new Promise((resolve, reject) => {
      releaseUrl();
      currentUrl = URL.createObjectURL(blob);
      settleCurrent = resolve;
      audio.onended = () => resolve();
      audio.onerror = () => reject(new Error("Audio playback failed"));
      audio.src = currentUrl;
      audio.play().catch(reject);
    });
  }

  function teardown() {
    audio.onended = null;
    audio.onerror = null;
    settleCurrent = null;
    releaseUrl();
    phase = "idle";
  }

  return {
    get phase() {
      return phase;
    },

    async play(generator) {
      stopped = false;
      phase = "playing";
      const iterator = generator[Symbol.asyncIterator]();
      let pending = iterator.next();

      try {
        while (!stopped) {
          const { value, done } = await pending;
          if (done || stopped) break;
          pending = iterator.next();
          await playBlob(value.audio);
        }
      } finally {
        // Swallow the abandoned lookahead so it cannot surface as an
        // unhandled rejection after stop().
        Promise.resolve(pending).catch(() => {});
        teardown();
      }
    },

    pause() {
      if (phase !== "playing") return;
      audio.pause();
      phase = "paused";
    },

    resume() {
      if (phase !== "paused") return;
      phase = "playing";
      audio.play();
    },

    stop() {
      stopped = true;
      audio.pause();
      settleCurrent?.();
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd extension && pnpm test player
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add extension/lib/player.js extension/lib/player.test.js
git commit -m "Add sequential chunk player with one-chunk lookahead"
```

---

## Task 8: Rewire the background script

**Files:**
- Modify: `extension/background.js` (full rewrite)

**Interfaces:**
- Consumes: `loadSettings` (Task 4), `pickAdapter` (Task 6), `createPlayer` (Task 7).
- Produces: unchanged `runtime.sendMessage` contract — `getState`, `readSelection`, `readPage`, `pause`, `resume`, `stop`, `getVoices`, `healthCheck` — so `popup.js` needs no change.

- [ ] **Step 1: Replace the background script**

Replace the entire contents of `extension/background.js`:

```js
import { pickAdapter } from "./lib/adapters/index.js";
import { createPlayer } from "./lib/player.js";
import { loadSettings } from "./lib/settings.js";

const state = {
  phase: "idle",
  progress: 0,
  chunksCompleted: 0,
  chunksTotal: 0,
  error: null,
};

const player = createPlayer({});
let abortController = null;

function resetState() {
  state.phase = "idle";
  state.progress = 0;
  state.chunksCompleted = 0;
  state.chunksTotal = 0;
  state.error = null;
}

function broadcastState() {
  browser.runtime.sendMessage({ type: "stateUpdate", state: { ...state } }).catch(() => {});
}

function setPhase(phase) {
  state.phase = phase;
  broadcastState();
}

function setError(message) {
  state.phase = "error";
  state.error = message;
  broadcastState();
}

function stopAll() {
  abortController?.abort();
  abortController = null;
  player.stop();
  resetState();
  broadcastState();
}

async function handleReadRequest(text, voice, speed) {
  stopAll();

  if (!text || text.trim().length === 0) {
    setError("No text to read");
    return;
  }

  const settings = await loadSettings();
  const adapter = pickAdapter(settings);
  abortController = new AbortController();

  setPhase("generating");

  const generator = adapter.synthesize({
    text,
    voice: voice || settings.defaultVoice,
    speed: speed || settings.defaultSpeed,
    settings,
    signal: abortController.signal,
    onProgress: ({ chunksCompleted, chunksTotal, progress }) => {
      state.chunksCompleted = chunksCompleted;
      state.chunksTotal = chunksTotal;
      state.progress = progress;
      if (state.phase === "generating" || state.phase === "playing") broadcastState();
    },
  });

  try {
    setPhase("playing");
    await player.play(generator);
    if (state.phase !== "error") {
      resetState();
      broadcastState();
    }
  } catch (err) {
    if (err.name === "AbortError") return;
    setError(err.message);
  } finally {
    abortController = null;
  }
}

async function handleReadPage(tabId, voice, speed) {
  stopAll();
  setPhase("extracting");

  try {
    // Inject Readability.js first (defines the global), then run the extractor.
    await browser.tabs.executeScript(tabId, { file: "Readability.js" });
    const results = await browser.tabs.executeScript(tabId, { file: "content.js" });
    const article = results && results[0];

    if (!article || !article.text || article.text.trim().length === 0) {
      setError("No article content could be extracted from this page");
      return;
    }

    await handleReadRequest(article.text, voice, speed);
  } catch (err) {
    setError(`Extraction failed: ${err.message}`);
  }
}

browser.contextMenus.create({
  id: "readaloud-selection",
  title: "ReadAloud: Read Selection",
  contexts: ["selection"],
});

browser.contextMenus.create({
  id: "readaloud-page",
  title: "ReadAloud: Read Page",
  contexts: ["page"],
});

browser.contextMenus.onClicked.addListener(async (info, tab) => {
  const settings = await loadSettings();
  if (info.menuItemId === "readaloud-selection" && info.selectionText) {
    handleReadRequest(info.selectionText, settings.defaultVoice, settings.defaultSpeed);
  } else if (info.menuItemId === "readaloud-page" && tab.id) {
    handleReadPage(tab.id, settings.defaultVoice, settings.defaultSpeed);
  }
});

browser.runtime.onMessage.addListener((message) => {
  switch (message.type) {
    case "getState":
      return Promise.resolve({ ...state });

    case "readSelection":
      return browser.tabs
        .query({ active: true, currentWindow: true })
        .then((tabs) => {
          if (!tabs[0]) throw new Error("No active tab");
          return browser.tabs.executeScript(tabs[0].id, {
            code: "window.getSelection().toString();",
          });
        })
        .then((results) => {
          const text = results && results[0];
          if (!text || text.trim().length === 0) {
            setError("No text selected on this page");
            return;
          }
          handleReadRequest(text, message.voice, message.speed);
        })
        .catch((err) => setError(`Could not read selection: ${err.message}`));

    case "readPage":
      return browser.tabs
        .query({ active: true, currentWindow: true })
        .then((tabs) => {
          if (!tabs[0]) throw new Error("No active tab");
          handleReadPage(tabs[0].id, message.voice, message.speed);
        })
        .catch((err) => setError(`Could not read page: ${err.message}`));

    case "pause":
      player.pause();
      if (player.phase === "paused") setPhase("paused");
      return Promise.resolve();

    case "resume":
      player.resume();
      if (player.phase === "playing") setPhase("playing");
      return Promise.resolve();

    case "stop":
      stopAll();
      return Promise.resolve();

    case "getVoices":
      return loadSettings()
        .then((settings) => pickAdapter(settings).listVoices(settings))
        .catch((err) => ({ error: err.message }));

    case "healthCheck":
      return loadSettings()
        .then((settings) => pickAdapter(settings).checkHealth(settings))
        .then((result) => ({
          status: result.ok ? "healthy" : "unhealthy",
          detail: result.detail,
        }))
        .catch((err) => ({ status: "unreachable", error: err.message }));

    default:
      return Promise.resolve();
  }
});
```

The old `polling` phase disappears — progress now arrives through `onProgress` while the phase is `playing`. `popup.js`'s `phaseLabels` still has a `polling` entry; it is harmless dead data and `renderState` falls through to showing the raw phase name for anything unmapped.

- [ ] **Step 2: Manually verify backend mode end to end**

```bash
docker compose --profile local-cpu up -d
```

Load the extension in `about:debugging`. In options, leave the target on **ReadAloud backend** with `http://localhost:8000`. Open a long article, right-click → ReadAloud: Read Page.

Expected: audio starts after the first chunk (not after the whole article), the progress bar advances, Pause/Resume/Stop all work.

- [ ] **Step 3: Manually verify direct mode end to end**

In options, switch the target to **Direct endpoint** with `http://localhost:8880`, no API key, model `kokoro`. Repeat the read.

Expected: identical behaviour. Confirm in the Network panel of the background page that requests go to `localhost:8880/v1/audio/speech` and never to `:8000`.

- [ ] **Step 4: Commit**

```bash
git add extension/background.js
git commit -m "Drive playback through TTS adapters and the sequential player"
```

---

## Task 9: Options page for target selection

**Files:**
- Modify: `extension/options/options.html:12-15`
- Modify: `extension/options/options.js`
- Modify: `extension/options/options.css`

**Interfaces:**
- Consumes: `loadSettings`, `saveSettings`, `TARGET_BACKEND`, `TARGET_DIRECT` (Task 4); `pickAdapter` (Task 6).

- [ ] **Step 1: Add the target fields to the options markup**

In `extension/options/options.html`, replace the single Server URL field (lines 12–15) with:

```html
    <div class="field">
      <label>TTS Target</label>
      <label class="radio">
        <input type="radio" name="tts-target" value="backend" checked>
        ReadAloud backend
      </label>
      <label class="radio">
        <input type="radio" name="tts-target" value="direct">
        Direct OpenAI-compatible endpoint
      </label>
    </div>

    <div class="field" id="backend-fields">
      <label for="backend-url">Backend URL</label>
      <input type="url" id="backend-url" placeholder="http://localhost:8000">
    </div>

    <div class="field hidden" id="direct-fields">
      <label for="direct-url">Endpoint URL</label>
      <input type="url" id="direct-url" placeholder="http://localhost:8880">
      <label for="direct-model">Model</label>
      <input type="text" id="direct-model" placeholder="kokoro">
      <label for="direct-api-key">API Key (leave blank for Kokoro)</label>
      <input type="password" id="direct-api-key" autocomplete="off" placeholder="sk-...">
    </div>
```

Change the script tag at the bottom to a module:

```html
  <script type="module" src="options.js"></script>
```

- [ ] **Step 2: Add the radio and hidden styles**

Append to `extension/options/options.css`:

```css
.radio {
  display: block;
  font-weight: normal;
  margin: 4px 0;
}

.hidden {
  display: none;
}
```

- [ ] **Step 3: Rewrite the options script**

Replace the contents of `extension/options/options.js`:

```js
import { pickAdapter } from "../lib/adapters/index.js";
import { TARGET_BACKEND, TARGET_DIRECT, loadSettings, saveSettings } from "../lib/settings.js";

const backendUrlInput = document.getElementById("backend-url");
const directUrlInput = document.getElementById("direct-url");
const directModelInput = document.getElementById("direct-model");
const directApiKeyInput = document.getElementById("direct-api-key");
const backendFields = document.getElementById("backend-fields");
const directFields = document.getElementById("direct-fields");
const voiceSelect = document.getElementById("voice-select");
const speedRange = document.getElementById("speed-range");
const speedValue = document.getElementById("speed-value");
const btnSave = document.getElementById("btn-save");
const btnTest = document.getElementById("btn-test");
const messageEl = document.getElementById("message");

function showMessage(text, type) {
  messageEl.textContent = text;
  messageEl.className = type;
  setTimeout(() => {
    messageEl.className = "hidden";
  }, 4000);
}

function selectedTarget() {
  const checked = document.querySelector('input[name="tts-target"]:checked');
  return checked?.value === TARGET_DIRECT ? TARGET_DIRECT : TARGET_BACKEND;
}

function formSettings() {
  return {
    ttsTarget: selectedTarget(),
    backendUrl: backendUrlInput.value.replace(/\/+$/, ""),
    directUrl: directUrlInput.value.replace(/\/+$/, ""),
    directModel: directModelInput.value,
    directApiKey: directApiKeyInput.value,
    defaultVoice: voiceSelect.value,
    defaultSpeed: parseFloat(speedRange.value),
  };
}

function syncFieldVisibility() {
  const direct = selectedTarget() === TARGET_DIRECT;
  directFields.classList.toggle("hidden", !direct);
  backendFields.classList.toggle("hidden", direct);
}

async function refreshVoices(selectedVoice) {
  const settings = formSettings();
  voiceSelect.innerHTML = '<option value="">Loading voices...</option>';
  try {
    const voices = await pickAdapter(settings).listVoices(settings);
    voiceSelect.innerHTML = "";
    for (const voice of voices) {
      const option = document.createElement("option");
      option.value = voice.id;
      option.textContent = voice.name || voice.id;
      voiceSelect.appendChild(option);
    }
    if (selectedVoice) voiceSelect.value = selectedVoice;
  } catch (err) {
    voiceSelect.innerHTML = `<option value="">Could not load voices: ${err.message}</option>`;
  }
}

async function init() {
  const settings = await loadSettings();
  document.querySelector(`input[name="tts-target"][value="${settings.ttsTarget}"]`).checked = true;
  backendUrlInput.value = settings.backendUrl;
  directUrlInput.value = settings.directUrl;
  directModelInput.value = settings.directModel;
  directApiKeyInput.value = settings.directApiKey;
  speedRange.value = settings.defaultSpeed;
  speedValue.textContent = settings.defaultSpeed.toFixed(1);
  syncFieldVisibility();
  await refreshVoices(settings.defaultVoice);
}

for (const radio of document.querySelectorAll('input[name="tts-target"]')) {
  radio.addEventListener("change", () => {
    syncFieldVisibility();
    refreshVoices(voiceSelect.value);
  });
}

for (const input of [backendUrlInput, directUrlInput, directApiKeyInput, directModelInput]) {
  input.addEventListener("change", () => refreshVoices(voiceSelect.value));
}

speedRange.addEventListener("input", () => {
  speedValue.textContent = parseFloat(speedRange.value).toFixed(1);
});

btnSave.addEventListener("click", async () => {
  await saveSettings(formSettings());
  showMessage("Settings saved.", "success");
});

btnTest.addEventListener("click", async () => {
  const settings = formSettings();
  const result = await pickAdapter(settings).checkHealth(settings);
  showMessage(result.detail, result.ok ? "success" : "error");
  await refreshVoices(voiceSelect.value);
});

init();
```

- [ ] **Step 4: Verify the options page manually**

Reload the extension, open the options page.

Expected:
- Selecting **Direct endpoint** hides the Backend URL field and reveals endpoint/model/API key.
- With Kokoro running, **Test Connection** on the direct target reports `Reachable (/health)` and the voice list populates with Kokoro IDs (`af_heart`, …).
- Switching to a bogus URL and testing reports `TTS server unreachable` without throwing.
- Saving, closing and reopening the page restores every field. The API key field renders as dots.

- [ ] **Step 5: Confirm the legacy migration works**

In the browser console for the extension, seed the old key and reload the options page:

```js
await browser.storage.local.clear();
await browser.storage.local.set({ serverUrl: "http://192.168.1.5:8000" });
```

Expected: after reload, the target is **ReadAloud backend**, Backend URL shows `http://192.168.1.5:8000`, and `browser.storage.local.get("serverUrl")` returns `{}`.

- [ ] **Step 6: Run the full test suite and commit**

```bash
cd extension && pnpm test
git add extension/options/
git commit -m "Add TTS target selection to the extension options page"
```

---

## Task 10: Align Docker ports and update documentation

The compose file maps Kokoro to host port **8881**, but the extension's direct target defaults to **8880** — the port a standalone Kokoro uses and the one every Kokoro doc example shows. Align them so one default works for both setups.

**Files:**
- Modify: `docker-compose.yml:16,40` (both Kokoro profiles) and the `readaloud` service environment
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Change both Kokoro host port mappings**

In `docker-compose.yml`, under both `kokoro-gpu` and `kokoro-cpu`:

```yaml
    ports:
      - "8880:8880"
```

The backend reaches Kokoro over the internal network alias `kokoro:8880`, so it is unaffected. Only host and browser access change.

- [ ] **Step 2: Pass the API key through to the backend**

In the `readaloud` service `environment` block, add:

```yaml
      READALOUD_TTS_API_KEY: ${READALOUD_TTS_API_KEY:-}
```

- [ ] **Step 3: Document the env var**

Add to `.env.example`:

```bash
# API key for the upstream TTS server. Leave blank for self-hosted Kokoro;
# required for hosted providers such as OpenAI or Groq.
READALOUD_TTS_API_KEY=
```

- [ ] **Step 4: Document both extension targets**

Add to `README.md` after the Configuration table (and add the `READALOUD_TTS_API_KEY` row to that table, default blank):

```markdown
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
```

- [ ] **Step 5: Update the architecture notes**

In `CLAUDE.md`, add `READALOUD_TTS_API_KEY` (default blank) to the configuration table, delete the `PUT /api/settings` mention if present, and add a short Extension section noting the adapter layer under `extension/lib/adapters/`.

- [ ] **Step 6: Verify the stack from a clean start**

```bash
docker compose down
docker compose --profile local-cpu up -d
curl -sf http://localhost:8880/health
curl -sf http://localhost:8000/api/health
```

Expected: both return successfully. Then reload the extension and read a page in each target mode.

- [ ] **Step 7: Commit**

```bash
git add docker-compose.yml .env.example README.md CLAUDE.md
git commit -m "Align Kokoro host port with extension default and document targets"
```

---

## Deferred (explicitly not in this plan)

- **Manifest V3.** Chrome does not run MV2 at all and Firefox is deprecating it. The blocker is not the manifest: an MV3 service worker is killed after ~30s idle and cannot hold a live `Audio` element, so playback has to move to an offscreen document or a hidden tab. That is its own plan. `lib/` is written to survive it untouched — only `background.js` and the manifest are MV2-specific.
- **Non-OpenAI providers.** ElevenLabs et al. need request-shaping per provider. The adapter contract in Task 5 accommodates them; add one only when actually wanted, per `docs/PROVIDERS.md`.
- **Backend job memory.** `JobState` keeps both `chunk_audio` and the stitched `audio_data`, roughly doubling retained bytes for an hour, and `_cleanup_old_jobs()` only runs when a new request arrives. Task 6 makes `chunk_audio` the primary consumer, so a follow-up could drop `audio_data` for chunked jobs entirely.
- **MP3 stitching metadata.** `stitch_mp3` concatenates frames without stripping per-chunk ID3/Xing headers, so the combined file reports the wrong duration and seeks badly. Per-chunk streaming avoids the stitched file on the extension path, but `GET /api/tts/audio/{job_id}` (used by the web UI) still serves it.

---

## Self-Review

**Spec coverage**

| Requirement | Task |
|---|---|
| Keep the backend | Backend retained; Tasks 1–2 improve it, Task 6 makes the extension use its unused chunk endpoint |
| Specify a custom backend | Task 4 `backendUrl`, Task 9 options field |
| Specify an OpenAI-compatible backend | Tasks 5, 9 |
| Kokoro container as the OpenAI backend | Task 4 default `http://localhost:8880`, Task 10 port alignment, Task 10 README table |
| Auth optional per `openai-tts-spec.md` §4 | Task 1 (backend), Task 5 `headers()` (extension) |
| Client-side chunking per §2 | Task 3 chunker, Task 5 `synthesize` |
| Voice-listing fallback per §3 | Task 5 `listVoices` + `FALLBACK_VOICES` |
| No job/polling model in direct mode per §1 | Task 5 yields blobs directly |
| Tier-1 providers only per PROVIDERS.md | Deferred section |

**Placeholder scan:** no TBDs; every code step carries the full implementation, and every test step names the exact command and expected result.

**Type consistency:** `synthesize` yields `{audio, index, total}` in Tasks 5, 6, and 7. `onProgress` receives `{chunksCompleted, chunksTotal, progress}` in Tasks 5, 6, and 8. `listVoices` returns `{id, name}[]` in Tasks 5, 6, and 9. `checkHealth` returns `{ok, detail}` in Tasks 5, 6, 8, and 9. Settings keys match between Tasks 4, 5, 6, 8, and 9.
