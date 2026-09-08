"""Sentence-level timing cues for synced reading highlights.

Cue times live in the stitched audio's own timeline, so they are
unaffected by playback-rate changes the frontend applies at playback time.
"""

import re
from dataclasses import dataclass

from readaloud.models.schemas import Cue
from readaloud.services.text_chunker import split_sentences


@dataclass(frozen=True)
class WordTimestamp:
    """One word's real timing, as reported by the TTS server."""

    word: str
    start: float
    end: float


_PUNCTUATION_ONLY = re.compile(r"[^\w\s]+")
MIN_TIMESTAMP_COVERAGE = 0.8


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


def _merge_punctuation(timestamps: list[WordTimestamp]) -> list[WordTimestamp]:
    """Fold punctuation-only tokens into the adjacent word's span.

    Kokoro tokenizes punctuation separately from the word beside it ("test"
    then "."), while the source text attaches it ("test."). Folding it back
    restores one token per source word, which is what `_cues_from_timestamps`
    aligns on. Punctuation merges backward into the preceding word, or
    forward into the following one when it opens the chunk -- a paragraph
    starting on a quotation mark is common enough that leaving it standalone
    would fail that alignment for the whole chunk.
    """
    merged: list[WordTimestamp] = []
    leading: list[WordTimestamp] = []
    for ts in timestamps:
        is_punctuation = bool(_PUNCTUATION_ONLY.fullmatch(ts.word))
        if is_punctuation and merged:
            previous = merged[-1]
            merged[-1] = WordTimestamp(
                word=previous.word + ts.word, start=previous.start, end=ts.end
            )
        elif is_punctuation:
            leading.append(ts)
        elif leading:
            merged.append(
                WordTimestamp(
                    word="".join(t.word for t in leading) + ts.word,
                    start=leading[0].start,
                    end=ts.end,
                )
            )
            leading.clear()
        else:
            merged.append(ts)

    if leading:
        merged.append(
            WordTimestamp(
                word="".join(t.word for t in leading),
                start=leading[0].start,
                end=leading[-1].end,
            )
        )
    return merged


def _chunk_words(text: str) -> list[str]:
    """The chunk's own words in order, each paragraph's last word carrying "\\n\\n".

    Same paragraph and word splitting the heuristic path uses, flattened.
    The real-timestamp path pairs these with timestamps positionally, so cue
    text is always the submitted text rather than the server's normalized
    rendering of it.
    """
    paragraphs = [p for p in re.split(r"\n\n+", text) if p.strip()]
    words: list[str] = []
    for index, paragraph in enumerate(paragraphs):
        paragraph_words = paragraph.split()
        if not paragraph_words:
            continue
        if index < len(paragraphs) - 1:
            paragraph_words[-1] += "\n\n"
        words.extend(paragraph_words)
    return words


def _cues_from_timestamps(
    text: str,
    timestamps: list[WordTimestamp],
    offset: float,
    duration: float,
) -> list[Cue] | None:
    """Build one chunk's cues from the TTS server's real per-word timestamps.

    Timestamps supply timing only -- cue text comes from `text`, so the
    reading view always shows what was submitted.

    Returns:
        The chunk's cues, or None when the timestamps can't be trusted and
        the caller should fall back to the character-count heuristic: a
        token count that doesn't match the chunk's own words (the server's
        normalizer rewrote something, e.g. "$5.00" -> "five dollars", so no
        positional mapping holds), or timestamps ending well before the
        audio does (the server stopped emitting them mid-utterance, which
        would freeze the highlight for the rest of the chunk).
    """
    merged = _merge_punctuation(timestamps)
    words = _chunk_words(text)
    if not merged or len(merged) != len(words):
        return None
    if duration > 0 and merged[-1].end < duration * MIN_TIMESTAMP_COVERAGE:
        return None

    return [
        Cue(text=word, start=offset + ts.start, end=offset + ts.end)
        for word, ts in zip(words, merged, strict=True)
    ]
