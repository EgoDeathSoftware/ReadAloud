"""Sentence-level timing cues for synced reading highlights.

Cue times live in the stitched audio's own timeline, so they are
unaffected by playback-rate changes the frontend applies at playback time.
"""

from readaloud.models.schemas import Cue
from readaloud.services.text_chunker import split_sentences


def compute_cues(chunk_texts: list[str], chunk_durations: list[float]) -> list[Cue]:
    """Build sentence-level playback cues for a sequence of TTS chunks.

    Each chunk's real audio duration is split across its own sentences,
    proportional to sentence character length. Sentences never cross chunk
    boundaries, so a chunk produced by splitting an oversized sentence
    across multiple TTS calls (see `text_chunker._split_long_sentence`)
    yields one cue per chunk piece rather than trying to recombine them.

    Args:
        chunk_texts: Chunk text, in playback order -- the same list passed
            to the TTS server for synthesis.
        chunk_durations: Each chunk's real audio duration in seconds, same
            order and length as `chunk_texts`.

    Returns:
        Cues in playback order, with `start`/`end` in the stitched audio's
        timeline (seconds).

    Raises:
        ValueError: If `chunk_texts` and `chunk_durations` differ in length.
    """
    if len(chunk_texts) != len(chunk_durations):
        raise ValueError("chunk_texts and chunk_durations must be the same length")

    cues: list[Cue] = []
    offset = 0.0
    for text, duration in zip(chunk_texts, chunk_durations, strict=True):
        cues.extend(_cues_for_chunk(text, duration, offset))
        offset += duration
    return cues


def _cues_for_chunk(text: str, duration: float, offset: float) -> list[Cue]:
    sentences = [s for s in split_sentences(text) if s.strip()]
    total_chars = sum(len(s) for s in sentences)
    if not sentences or total_chars == 0:
        return []

    cues: list[Cue] = []
    start = offset
    for sentence in sentences:
        end = start + duration * (len(sentence) / total_chars)
        cues.append(Cue(text=sentence, start=start, end=end))
        start = end
    return cues
