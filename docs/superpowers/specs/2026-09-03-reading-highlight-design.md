# Reading position highlight — design

## Problem

While audio plays, there's no visual indication of where in the text the
voice currently is. This adds sentence-level highlighting that tracks
playback in the web frontend.

## Scope

Web frontend (`frontend/`) only. The Firefox extension's playback path
(`extension/lib/player.js`) is not touched.

## Approach

Sentence-level highlighting, driven by **estimated timing**: each chunk's
real audio duration (measured server-side from its MP3 frames) is split
across that chunk's sentences proportionally by character count. This
requires no TTS-server-specific capability — it works with any
OpenAI-compatible server, including custom ones, since it only uses audio
the server already returns. The tradeoff is that timing can drift slightly
within a chunk when speech pacing is uneven (numbers, pauses, heavy
punctuation).

Real per-word timestamps from the TTS server were considered and rejected:
they'd tie the backend to a specific server implementation (e.g. a
Kokoro-FastAPI-specific endpoint) and silently degrade to guesswork on any
server that doesn't support them — including the user's custom backend.

## Backend

### Sentence splitting

Extract the sentence-boundary regex (`(?<=[.!?])\s+`) currently inlined in
`text_chunker._split_long_paragraph` into a shared function:

```python
def split_sentences(text: str) -> list[str]
```

Used by both the existing chunker and the new cue computation, so sentence
boundaries stay consistent between the two.

### Duration from MP3 frames

Add to `mp3_frames.py`:

```python
def frame_duration_seconds(frames: list[tuple[FrameHeader, bytes]]) -> float
```

Sums `samples_per_frame / sample_rate` across a chunk's real audio frames.
This reuses frame parsing the stitcher already performs — no new decoding
dependency.

### Cue computation

New module `services/reading_cues.py`:

```python
@dataclass(frozen=True)
class Cue:
    text: str
    start: float  # seconds, in stitched-audio time
    end: float

def compute_cues(chunk_texts: list[str], chunk_durations: list[float]) -> list[Cue]
```

For each chunk: split its text into sentences via `split_sentences`,
allocate each sentence a `[start, end]` window proportional to its
character length within the chunk's duration, offset by the cumulative
duration of prior chunks. Sentences never cross chunk boundaries — even in
the rare case where `_split_long_sentence` breaks an oversized sentence
into multiple chunks, each resulting piece is treated as its own cue. This
avoids needing to map cue text back onto arbitrary offsets in the user's
original input text.

Cue times are in the stitched audio's own timeline and are unaffected by
the frontend's `playbackRate` control, since `HTMLAudioElement.currentTime`
tracks the underlying audio position, not wall-clock speed.

### Wiring

- `_process_long_text` (multi-chunk job path, `routes/tts.py`): after
  `job_store.finalize_from_chunks`, parse each chunk's frames for duration
  (already read during stitching) and call `compute_cues`. Store the
  result on `JobState.cues`.
- `generate_tts`'s short-text synchronous path (single call, ≤
  `MAX_CHUNK_CHARS`): treat the whole text as one chunk, compute its
  duration and cues the same way, and store on the `JobState` created for
  that job.
- `TtsStatusResponse` gains `cues: list[Cue] = []`, populated once
  `status == "complete"` (mirrors the existing `chunks` field). No new
  endpoint — the frontend already polls status and already receives the
  complete response.

## Frontend

### State

`useTts` gains a `cues: Cue[]` field (`{text, start, end}`), populated from
the status response once `status === "complete"`, including the
synchronous short-text path.

### Tracking playback position

`AudioPlayer` already owns the `<audio>` ref and `isPlaying`. It gains:

- a `cues: Cue[]` prop
- an `onCueChange?: (index: number | null) => void` callback
- an `onPlayingChange?: (isPlaying: boolean) => void` callback (lifts the
  existing local `isPlaying` state so `App` can react to it)

While `isPlaying`, a `requestAnimationFrame` loop reads
`audio.currentTime`, binary-searches `cues` for the containing window, and
calls `onCueChange` only when the index changes. The loop stops on
pause/stop/end, and reports `null` when playback isn't active or
`currentTime` falls outside all cues (e.g. trailing silence).

### Rendering the highlight

New component `ReadingText`:

```tsx
interface ReadingTextProps {
  cues: Cue[];
  activeCueIndex: number | null;
}
```

Renders each cue's own text as a `<span>`, in order — not a re-rendering
of the original textarea string. This sidesteps whitespace/formatting
differences between the chunker's rejoined chunk text and the user's raw
input entirely, since the highlighted view is built directly from what
will actually be spoken rather than overlaid on the original text.

- The active cue's span gets a highlight class.
- On active-cue change, call `scrollIntoView({ block: "nearest" })` on
  that span so long texts auto-scroll to keep the current sentence
  visible.

### Swap logic

`App.tsx` holds `isPlaying` (from `AudioPlayer.onPlayingChange`) and
`activeCueIndex` (from `AudioPlayer.onCueChange`). While `isPlaying`,
render `<ReadingText>` in place of `<TextInput>`; otherwise render the
editable `<TextInput>` as today. `TextInput`'s `value`/`onChange` are
untouched — this is a display swap only, not a change to how the text is
edited or submitted.

## Error handling / edge cases

- No cues yet (still generating/polling): `AudioPlayer` won't be
  interacted with until audio exists, so this doesn't arise in practice;
  `cues` defaults to `[]` and the rAF loop simply reports `null`.
- Manual seeking (native scrubber, skip buttons): handled for free — the
  rAF loop reads `currentTime` every frame regardless of how it changed.
- Playback ends (`onEnded`): `isPlaying` becomes `false`, so the view
  reverts to the editable textarea; no separate "clear highlight" case
  needed.
- Client-cached chunks (`known_chunks`/`client_cache` source): cue
  computation is identical regardless of whether a chunk's audio was
  synthesized or supplied by the client, since it only depends on the
  final audio bytes.

## Testing

Backend:
- `split_sentences`: normal text, no terminal punctuation, abbreviations
  are an accepted known limitation (matches existing chunker behavior).
- `frame_duration_seconds`: known frame counts/sample rates produce
  expected durations.
- `compute_cues`: single chunk/single sentence, multiple sentences per
  chunk, the oversized-sentence-split-across-chunks edge case, empty
  chunk text.

Frontend:
- Binary-search cue lookup: before first cue, between cues, after last
  cue, exact boundary times.
- `App` swap behavior: `TextInput` shown when idle/paused, `ReadingText`
  shown while playing, reverts on stop/end.
- `ReadingText`: correct span gets the highlight class as
  `activeCueIndex` changes.
