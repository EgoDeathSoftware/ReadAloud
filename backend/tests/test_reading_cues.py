import pytest

from readaloud.services.reading_cues import compute_cues


def test_single_chunk_single_sentence_spans_full_duration():
    cues = compute_cues(["One sentence."], [2.0])

    assert len(cues) == 1
    assert cues[0].text == "One sentence."
    assert cues[0].start == 0.0
    assert cues[0].end == 2.0


def test_single_chunk_splits_duration_by_character_count():
    # "Short." (6 chars) + "A much longer sentence here." (28 chars) = 34 chars
    cues = compute_cues(["Short. A much longer sentence here."], [3.4])

    assert [c.text for c in cues] == ["Short.", "A much longer sentence here."]
    assert cues[0].start == pytest.approx(0.0)
    assert cues[0].end == pytest.approx(3.4 * 6 / 34)
    assert cues[1].start == cues[0].end
    assert cues[1].end == pytest.approx(3.4)


def test_multiple_chunks_offset_by_cumulative_duration():
    cues = compute_cues(["First chunk.", "Second chunk."], [1.0, 2.0])

    assert cues[0].start == 0.0
    assert cues[0].end == 1.0
    assert cues[1].start == 1.0
    assert cues[1].end == 3.0


def test_oversized_sentence_split_across_chunks_yields_one_cue_per_piece():
    # Simulates text_chunker._split_long_sentence breaking one long sentence
    # into multiple TTS chunks -- each piece has no terminal punctuation of
    # its own, so it becomes exactly one cue, never merged across chunks.
    cues = compute_cues(["word word word", "word word done."], [1.0, 1.0])

    assert [c.text for c in cues] == ["word word word", "word word done."]
    assert cues[0].start == 0.0
    assert cues[0].end == 1.0
    assert cues[1].start == 1.0
    assert cues[1].end == 2.0


def test_empty_chunk_text_yields_no_cues():
    assert compute_cues([""], [1.0]) == []


def test_mismatched_lengths_raises():
    with pytest.raises(ValueError):
        compute_cues(["a", "b"], [1.0])
