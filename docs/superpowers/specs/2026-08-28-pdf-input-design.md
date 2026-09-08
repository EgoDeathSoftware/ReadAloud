# PDF input via the Firefox extension

Status: approved design, ready for implementation planning.

## Problem

The roadmap lists "EPUB / PDF input" as a future feature. This spec scopes the PDF half,
triggered by a concrete need: reading a PDF opened in Firefox via the extension's existing
"Read Page" flow (button and context menu) doesn't work — that flow injects `Readability.js` +
`content.js` into the active tab, but Firefox renders PDFs with its built-in `pdf.js` viewer at a
privileged `resource://pdf.js/web/viewer.html` URL, which WebExtension content scripts cannot be
injected into (same restriction as `about:` pages).

EPUB input, and adding PDF support to the web app's URL-paste box, are explicitly out of scope —
see "Non-goals" below.

## Goals

- Clicking "Read Page" (button or context menu) while a PDF tab is active works, for PDFs opened
  from an `http(s)://` URL and for local `file://` PDFs.
- Reuses the existing chunking/TTS/player pipeline unchanged once text is extracted — no changes
  to `handleReadRequest`, the adapters, or the player.
- README documents the resulting backend limitations (see "Documentation" below).

## Non-goals

- Fixing "Read Selection" inside a PDF. pdf.js renders a real selectable text layer, but the
  extension has no way to read that selection back out (same `resource://` content-script
  restriction). This needs a different mechanism (e.g. a manifest-declared content script matching
  `resource://pdf.js/*`, if Firefox permits it, or postMessage with the viewer) and is deferred.
- Adding PDF support to the web app's "paste a URL" box. The backend gains a reusable PDF-parsing
  service as a side effect of this work, so that's a small follow-up later, not blocked by
  anything here — just not built now.
- EPUB input (separate roadmap item).

## Architecture

Extraction stays server-side, on the ReadAloud FastAPI backend, matching the existing
URL-extraction pattern (`services/text_extractor.py` fetches and parses; nothing runs in the
browser). What's new is the *input* mode: instead of the backend fetching by URL, the extension's
background script — which already holds `<all_urls>` host permission — fetches the PDF's raw
bytes itself and uploads them to a new backend endpoint. One mechanism covers both
`http(s)://foo.pdf` and local `file://…pdf`; the backend never needs to know the difference, and
never touches `file://` itself (which its SSRF guard in `url_guard.py` would reject anyway, and
which isn't reachable from a server process regardless).

PDF extraction always goes through the ReadAloud FastAPI backend for parsing, even when
`ttsTarget` is set to "direct" (talking straight to Kokoro/OpenAI/Groq for synthesis) — parsing
only exists on the backend; synthesis is a separate step downstream. Once text comes back from
extraction, it flows into the existing `handleReadRequest` pipeline exactly as selection/page-read
text does today, so chunking and TTS-target selection are unaffected.

**PDF parsing library: `pypdf`.** Pure Python, BSD-licensed, no native/system dependencies (this
project has none today). Text extraction is good enough for TTS; may reorder text in complex
multi-column layouts, but that's a tolerable glitch when the output is spoken aloud, not read.
Rejected: `pdfplumber` (better layout fidelity, but heavier/slower for a precision benefit that
doesn't matter once it's spoken text) and `PyMuPDF`/fitz (fastest and highest quality, but
AGPL-3.0 — a license obligation on the whole project we don't want to take on for this).

## Components

- **`backend/src/readaloud/services/pdf_extractor.py`** (new) — `extract_from_pdf_bytes(data:
  bytes) -> ExtractedContent` (reuses the `ExtractedContent` dataclass from `text_extractor.py`).
  Parses with `pypdf`, joins per-page text, truncates to `MAX_CHARS` (reuse the existing 100k
  constant), pulls `/Title` from PDF metadata if present else `None`. Raises `ValueError` for
  corrupt/encrypted/no-extractable-text PDFs (e.g. scanned image-only pages) — same error contract
  as `extract_from_url`.
- **`backend/src/readaloud/routes/extract.py`** — new `POST /api/extract/pdf`, `UploadFile` field
  named `file`. Rejects anything over 25MB with 413 before parsing (real documents are far
  smaller; oversized is almost always a scanned/image PDF that wouldn't yield real text anyway).
  Wraps `ValueError` from the service as 422. Returns the existing `ExtractResponse` shape
  (`title`, `text`, `word_count`) — no new response type needed.
- **`backend/pyproject.toml`** — add `pypdf` to `dependencies`.
- **`extension/lib/pdf.js`** (new) — pure functions, no `browser.*` dependency so they're
  unit-testable directly:
  - `isPdfUrl(url)` — true if the path ends in `.pdf`, case-insensitive, ignoring query string.
  - `resolvePdfSourceUrl(url)` — if `url` matches Firefox's internal viewer pattern
    (`resource://pdf.js/web/viewer.html?...&file=<encoded>...`), decode and return the `file`
    param; otherwise return `url` unchanged. Defensive: covers both "tab.url is already the real
    PDF URL" and "tab.url is the wrapped viewer URL", since which one Firefox uses isn't something
    to assume without checking against a real build.
- **`extension/background.js`** — `handleReadPage` branches: if
  `isPdfUrl(resolvePdfSourceUrl(tab.url))`, call new `handleReadPdf(tab, voice, speed)` instead of
  the `Readability.js`/`content.js` injection path. `handleReadPdf`:
  1. `fetch()`s the resolved URL, reads `arrayBuffer()`.
  2. Builds `multipart/form-data`, POSTs to `${settings.backendUrl}/api/extract/pdf`.
  3. Calls the existing `handleReadRequest(text, voice, speed)` with the returned `title`/`text`
     (title currently unused by `handleReadRequest`, same as the HTML extraction path today).
- **`extension/manifest.json`** — no new manifest permission entries for `http(s)`; `<all_urls>`
  already covers it. For `file://`, no manifest change is possible — Firefox gates local-file
  access per-install via a user toggle ("Allow access to file URLs" on `about:addons`), not
  something a manifest can request.

## Data flow

1. User clicks "Read Page" (button or context menu) while a PDF tab is active.
2. `handleReadPage` detects it's a PDF via `isPdfUrl`/`resolvePdfSourceUrl`, routes to
   `handleReadPdf`.
3. Background script `fetch()`s the PDF bytes directly from the tab's (resolved) URL.
4. Bytes POST to `POST /api/extract/pdf` as multipart form data.
5. Backend parses with `pypdf`, returns `{title, text, word_count}`.
6. Extension feeds `text` into the existing `handleReadRequest` → chunking/TTS/player, unchanged.

## Error handling

- Fetch failure (missing "Allow access to file URLs" permission, network error, 404): surfaced via
  the existing `setError` path with a clear message (e.g. "Could not read PDF: …").
- Backend 413 (too large) / 422 (unparseable, encrypted, no extractable text): message passed
  through to `setError`, same pattern as today's "Extraction failed: …" text for HTML pages.
- A non-PDF resource behind a `.pdf`-looking URL: `pypdf` fails to parse → 422 → same error path.
  No separate content-type sniffing needed before upload.

## Testing

- Backend: unit tests for `pdf_extractor.py` against fixture PDFs (a valid one, a corrupt/empty
  one) in `backend/tests/`, plus a route test for `/api/extract/pdf` covering success, oversized
  (413), and unparseable (422) — following the existing test structure/naming.
- Extension: vitest unit tests for `pdf.js`'s `isPdfUrl`/`resolvePdfSourceUrl` (plain string
  logic) in `extension/lib/pdf.test.js`, mirroring `chunker.test.js`/`settings.test.js`.

## Documentation

As the last implementation step, update `README.md`'s "Extension TTS targets" section with a
limitations note covering:

- **Read Selection doesn't work inside PDFs**, on either `ttsTarget` (backend or direct) —
  Firefox's built-in PDF viewer is a privileged `resource://` page that content scripts can't be
  injected into, so the extension can't read the page's text selection. This is a pre-existing gap
  independent of this feature and true today.
- **PDF Read Page requires the ReadAloud backend reachable**, even when `ttsTarget` is "direct" —
  PDF parsing only exists server-side on the ReadAloud FastAPI backend; an OpenAI-compatible
  `/v1/audio/speech` endpoint has no concept of PDF parsing. Only the synthesis step after
  extraction can go through direct/OpenAI.
