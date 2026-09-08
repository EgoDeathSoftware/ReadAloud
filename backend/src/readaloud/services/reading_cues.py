"""Sentence-level timing cues for synced reading highlights.

Cue times live in the stitched audio's own timeline, so they are
unaffected by playback-rate changes the frontend applies at playback time.
"""

import re

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
    paragraphs = [p for p in re.split(r"\n\n+", text) if p.strip()]
    sentences_by_paragraph = [[s for s in split_sentences(p) if s.strip()] for p in paragraphs]
    all_sentences = [s for para in sentences_by_paragraph for s in para]
    total_chars = sum(len(s) for s in all_sentences)
    if not all_sentences or total_chars == 0:
        return []

    cues: list[Cue] = []
    start = offset
    for para_index, para_sentences in enumerate(sentences_by_paragraph):
        for sent_index, sentence in enumerate(para_sentences):
            end = start + duration * (len(sentence) / total_chars)
            is_last_sentence_in_para = sent_index == len(para_sentences) - 1
            is_last_paragraph = para_index == len(sentences_by_paragraph) - 1
            suffix = "\n\n" if is_last_sentence_in_para and not is_last_paragraph else ""
            cues.extend(_cues_for_sentence(sentence, start, end, suffix))
            start = end
    return cues


def _cues_for_sentence(sentence: str, start: float, end: float, suffix: str) -> list[Cue]:
    """Split one sentence's allotted time span across its words.

    Words share the span proportional to their character length, the same
    proportional approach `_cues_for_chunk` uses for sentences -- there is no
    real per-word timing from the TTS server to split on.
    """
    words = sentence.split()
    total_chars = sum(len(word) for word in words)
    if not words or total_chars == 0:
        return []

    duration = end - start
    cues: list[Cue] = []
    cursor = start
    for index, word in enumerate(words):
        word_end = cursor + duration * (len(word) / total_chars)
        is_last_word = index == len(words) - 1
        cue_text = word + suffix if is_last_word else word
        cues.append(Cue(text=cue_text, start=cursor, end=word_end))
        cursor = word_end
    return cues
