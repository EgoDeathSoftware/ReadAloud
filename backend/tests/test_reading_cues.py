import pytest

from readaloud.services.reading_cues import compute_cues


def test_single_chunk_single_sentence_splits_duration_by_word_length():
    # "One" (3 chars) + "sentence." (9 chars) = 12 chars
    cues = compute_cues(["One sentence."], [2.0])

    assert [c.text for c in cues] == ["One", "sentence."]
    assert cues[0].start == pytest.approx(0.0)
    assert cues[0].end == pytest.approx(2.0 * 3 / 12)
    assert cues[1].start == cues[0].end
    assert cues[1].end == pytest.approx(2.0)


def test_single_chunk_splits_duration_across_words_by_character_count():
    # "Short." (6 chars) + "A much longer sentence here." (28 chars) = 34 chars total
    cues = compute_cues(["Short. A much longer sentence here."], [3.4])

    assert [c.text for c in cues] == [
        "Short.",
        "A",
        "much",
        "longer",
        "sentence",
        "here.",
    ]

    sentence_one_end = 3.4 * 6 / 34
    assert cues[0].start == pytest.approx(0.0)
    assert cues[0].end == pytest.approx(sentence_one_end)

    sentence_two_duration = 3.4 - sentence_one_end
    word_chars = [1, 4, 6, 8, 5]  # A, much, longer, sentence, here.
    total_word_chars = sum(word_chars)
    assert cues[1].start == pytest.approx(sentence_one_end)
    assert cues[2].start == pytest.approx(
        sentence_one_end + sentence_two_duration * word_chars[0] / total_word_chars
    )
    assert cues[-1].end == pytest.approx(3.4)


def test_cues_are_contiguous():
    cues = compute_cues(["Short. A much longer sentence here."], [3.4])

    for earlier, later in zip(cues, cues[1:], strict=False):
        assert earlier.end == later.start


def test_multiple_chunks_offset_by_cumulative_duration():
    cues = compute_cues(["First chunk.", "Second chunk."], [1.0, 2.0])

    assert [c.text for c in cues] == ["First", "chunk.", "Second", "chunk."]
    assert cues[0].start == 0.0
    assert cues[1].end == pytest.approx(1.0)
    assert cues[2].start == pytest.approx(1.0)
    assert cues[-1].end == pytest.approx(3.0)


def test_oversized_sentence_piece_still_splits_into_words():
    # Simulates text_chunker._split_long_sentence breaking one long sentence
    # into multiple TTS chunks -- each piece has no terminal punctuation of
    # its own, but is still split word by word like any other sentence.
    cues = compute_cues(["word word word", "word word done."], [1.0, 1.0])

    assert [c.text for c in cues] == ["word", "word", "word", "word", "word", "done."]
    assert cues[0].start == 0.0
    assert cues[2].end == pytest.approx(1.0)
    assert cues[3].start == pytest.approx(1.0)
    assert cues[-1].end == pytest.approx(2.0)


def test_paragraph_break_marker_attaches_to_last_word_of_paragraph():
    cues = compute_cues(["First para. Still first.\n\nSecond para."], [3.0])

    assert [c.text for c in cues] == [
        "First",
        "para.",
        "Still",
        "first.\n\n",
        "Second",
        "para.",
    ]


def test_empty_chunk_text_yields_no_cues():
    assert compute_cues([""], [1.0]) == []


def test_mismatched_lengths_raises():
    with pytest.raises(ValueError):
        compute_cues(["a", "b"], [1.0])
