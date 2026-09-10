import pytest

from readaloud.services.reading_cues import (
    WordTimestamp,
    _cues_from_timestamps,
    _merge_punctuation,
    compute_cues,
)


def test_single_chunk_single_sentence_splits_duration_by_word_length():
    # "One" (3 chars) + "sentence." (9 chars) = 12 chars
    cues = compute_cues(["One sentence."], [2.0], [None])

    assert [c.text for c in cues] == ["One", "sentence."]
    assert cues[0].start == pytest.approx(0.0)
    assert cues[0].end == pytest.approx(2.0 * 3 / 12)
    assert cues[1].start == cues[0].end
    assert cues[1].end == pytest.approx(2.0)


def test_single_chunk_splits_duration_across_words_by_character_count():
    # "Short." (6 chars) + "A much longer sentence here." (28 chars) = 34 chars total
    cues = compute_cues(["Short. A much longer sentence here."], [3.4], [None])

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
    cues = compute_cues(["Short. A much longer sentence here."], [3.4], [None])

    for earlier, later in zip(cues, cues[1:], strict=False):
        assert earlier.end == later.start


def test_multiple_chunks_offset_by_cumulative_duration():
    cues = compute_cues(["First chunk.", "Second chunk."], [1.0, 2.0], [None, None])

    assert [c.text for c in cues] == ["First", "chunk.", "Second", "chunk."]
    assert cues[0].start == 0.0
    assert cues[1].end == pytest.approx(1.0)
    assert cues[2].start == pytest.approx(1.0)
    assert cues[-1].end == pytest.approx(3.0)


def test_oversized_sentence_piece_still_splits_into_words():
    # Simulates text_chunker._split_long_sentence breaking one long sentence
    # into multiple TTS chunks -- each piece has no terminal punctuation of
    # its own, but is still split word by word like any other sentence.
    cues = compute_cues(["word word word", "word word done."], [1.0, 1.0], [None, None])

    assert [c.text for c in cues] == ["word", "word", "word", "word", "word", "done."]
    assert cues[0].start == 0.0
    assert cues[2].end == pytest.approx(1.0)
    assert cues[3].start == pytest.approx(1.0)
    assert cues[-1].end == pytest.approx(2.0)


def test_paragraph_break_marker_attaches_to_last_word_of_paragraph():
    cues = compute_cues(["First para. Still first.\n\nSecond para."], [3.0], [None])

    assert [c.text for c in cues] == [
        "First",
        "para.",
        "Still",
        "first.\n\n",
        "Second",
        "para.",
    ]


def test_empty_chunk_text_yields_no_cues():
    assert compute_cues([""], [1.0], [None]) == []


def test_mismatched_lengths_raises():
    with pytest.raises(ValueError):
        compute_cues(["a", "b"], [1.0], [None, None])


def test_mismatched_timestamps_length_raises():
    with pytest.raises(ValueError):
        compute_cues(["a"], [1.0], [None, None])


def test_mixes_real_timestamps_and_heuristic_across_chunks():
    real_timestamps = [
        WordTimestamp(word="Real", start=0.0, end=0.4),
        WordTimestamp(word="words.", start=0.4, end=1.0),
    ]
    cues = compute_cues(
        ["Real words.", "Heuristic words."],
        [1.0, 2.0],
        [real_timestamps, None],
    )

    assert [c.text for c in cues] == ["Real", "words.", "Heuristic", "words."]
    assert cues[0].start == pytest.approx(0.0)
    assert cues[1].end == pytest.approx(1.0)
    assert cues[2].start == pytest.approx(1.0)
    assert cues[-1].end == pytest.approx(3.0)


def test_unusable_timestamps_fall_back_to_the_heuristic_for_that_chunk():
    # Three tokens for two words: the normalizer expanded something, so this
    # chunk gets heuristic timing rather than a bad alignment -- and keeps
    # the submitted text either way.
    normalized = [
        WordTimestamp(word="five", start=0.0, end=0.4),
        WordTimestamp(word="dollars", start=0.4, end=0.8),
        WordTimestamp(word="today.", start=0.8, end=1.0),
    ]
    cues = compute_cues(["$5.00 today."], [1.0], [normalized])

    assert [c.text for c in cues] == ["$5.00", "today."]
    assert cues[0].start == pytest.approx(0.0)
    assert cues[-1].end == pytest.approx(1.0)


def test_merge_punctuation_folds_trailing_punctuation_into_previous_word():
    merged = _merge_punctuation(
        [
            WordTimestamp(word="test", start=1.0, end=1.6),
            WordTimestamp(word=".", start=1.6, end=1.8),
        ]
    )
    assert merged == [WordTimestamp(word="test.", start=1.0, end=1.8)]


def test_merge_punctuation_folds_leading_punctuation_into_next_word():
    # A paragraph opening on a quotation mark is common; leaving the mark
    # standalone would fail the alignment check for the whole chunk.
    merged = _merge_punctuation(
        [
            WordTimestamp(word='"', start=0.0, end=0.05),
            WordTimestamp(word="Hello", start=0.05, end=0.4),
        ]
    )
    assert merged == [WordTimestamp(word='"Hello', start=0.0, end=0.4)]


def test_merge_punctuation_leaves_plain_words_untouched():
    merged = _merge_punctuation(
        [
            WordTimestamp(word="Hello", start=0.0, end=0.3),
            WordTimestamp(word="there", start=0.3, end=0.6),
        ]
    )
    assert merged == [
        WordTimestamp(word="Hello", start=0.0, end=0.3),
        WordTimestamp(word="there", start=0.3, end=0.6),
    ]


def test_cues_from_timestamps_offsets_by_chunk_start():
    timestamps = [
        WordTimestamp(word="Hi", start=0.0, end=0.2),
        WordTimestamp(word="!", start=0.2, end=0.3),
    ]
    cues = _cues_from_timestamps("Hi!", timestamps, offset=5.0, duration=0.3)
    assert [(c.text, c.start, c.end) for c in cues] == [("Hi!", 5.0, 5.3)]


def test_cues_from_timestamps_uses_submitted_text_not_the_servers_words():
    # Kokoro reports post-normalization words ("Dr." is spoken "Doctor").
    # Timing comes from the server; the text stays what the user submitted.
    timestamps = [
        WordTimestamp(word="Doctor", start=0.0, end=0.5),
        WordTimestamp(word="Smith", start=0.5, end=0.9),
        WordTimestamp(word=".", start=0.9, end=1.0),
    ]
    cues = _cues_from_timestamps("Dr. Smith.", timestamps, offset=0.0, duration=1.0)
    assert [(c.text, c.start, c.end) for c in cues] == [
        ("Dr.", 0.0, 0.5),
        ("Smith.", 0.5, 1.0),
    ]


def test_cues_from_timestamps_attaches_paragraph_break():
    timestamps = [
        WordTimestamp(word="First", start=0.0, end=0.3),
        WordTimestamp(word="para", start=0.3, end=0.6),
        WordTimestamp(word=".", start=0.6, end=0.7),
        WordTimestamp(word="Second", start=0.7, end=1.0),
        WordTimestamp(word="para", start=1.0, end=1.3),
        WordTimestamp(word=".", start=1.3, end=1.4),
    ]
    cues = _cues_from_timestamps(
        "First para.\n\nSecond para.", timestamps, offset=0.0, duration=1.4
    )
    assert [c.text for c in cues] == ["First", "para.\n\n", "Second", "para."]


def test_cues_from_timestamps_rejects_word_count_mismatch():
    # The normalizer expanded "$5" into two spoken words, so there is no
    # trustworthy positional mapping back onto the submitted text.
    timestamps = [
        WordTimestamp(word="It", start=0.0, end=0.2),
        WordTimestamp(word="costs", start=0.2, end=0.5),
        WordTimestamp(word="five", start=0.5, end=0.8),
        WordTimestamp(word="dollars", start=0.8, end=1.2),
    ]
    assert _cues_from_timestamps("It costs $5.", timestamps, offset=0.0, duration=1.2) is None


def test_cues_from_timestamps_rejects_timestamps_that_stop_short_of_the_audio():
    # Observed Kokoro behavior: it stops emitting timestamps mid-utterance
    # while the audio keeps going, which would freeze the highlight.
    timestamps = [
        WordTimestamp(word="The", start=0.0, end=0.2),
        WordTimestamp(word="plan", start=0.2, end=1.0),
    ]
    assert _cues_from_timestamps("The plan", timestamps, offset=0.0, duration=3.0) is None


def test_cues_from_timestamps_empty_timestamps_falls_back():
    assert _cues_from_timestamps("text", [], offset=0.0, duration=1.0) is None


def test_cues_from_timestamps_are_contiguous():
    # Kokoro leaves small gaps between words; an accepted chunk's cues must
    # still tile the chunk with no holes, same as the heuristic path.
    timestamps = [
        WordTimestamp(word="One", start=0.0, end=0.2),
        WordTimestamp(word="two", start=0.25, end=0.45),
        WordTimestamp(word="three.", start=0.5, end=0.85),
    ]
    cues = _cues_from_timestamps("One two three.", timestamps, offset=0.0, duration=1.0)

    for earlier, later in zip(cues, cues[1:], strict=False):
        assert earlier.end == later.start


def test_cues_from_timestamps_clamps_negative_first_start_to_chunk_offset():
    # Observed Kokoro behavior: a chunk's first word can report a small
    # negative start_time. Left unclamped, offsetting it by the chunk's own
    # offset would start the cue before the chunk begins, overlapping the
    # previous chunk's last cue.
    timestamps = [
        WordTimestamp(word="We", start=-0.0303, end=0.2),
        WordTimestamp(word="agree.", start=0.2, end=0.9),
    ]
    cues = _cues_from_timestamps("We agree.", timestamps, offset=10.0, duration=1.0)

    assert cues[0].start == pytest.approx(10.0)


def test_cues_from_timestamps_stays_contiguous_and_full_duration_with_negative_start():
    timestamps = [
        WordTimestamp(word="We", start=-0.0303, end=0.2),
        WordTimestamp(word="agree.", start=0.2, end=0.9),
    ]
    cues = _cues_from_timestamps("We agree.", timestamps, offset=10.0, duration=1.0)

    for earlier, later in zip(cues, cues[1:], strict=False):
        assert earlier.end == later.start
    assert cues[-1].end == pytest.approx(11.0)


def test_cues_from_timestamps_last_cue_reaches_chunk_duration():
    # The coverage guard accepts timestamps ending at 80% of the chunk's
    # audio duration; the residual must still be covered by the last cue,
    # not left blank.
    timestamps = [
        WordTimestamp(word="One", start=0.0, end=0.4),
        WordTimestamp(word="two.", start=0.4, end=0.8),
    ]
    cues = _cues_from_timestamps("One two.", timestamps, offset=5.0, duration=1.0)

    assert cues[-1].end == pytest.approx(6.0)


def test_heuristic_weights_digit_heavy_words_by_estimated_spoken_length():
    # "1999" (4 chars) is spoken as roughly "nineteen ninety nine" -- far more
    # speech than its literal character count suggests. Weighting it by raw
    # character count (same as "abcd", also 4 chars) makes the highlight race
    # past it while the audio is still pronouncing the year, then slowly
    # regain sync as the rest of the sentence's overly generous allocation
    # lets the audio catch up. This is the mechanism, not the disproving
    # length -- so require a clear margin, not just "greater than".
    cues = compute_cues(["1999 abcd"], [2.0], [None])

    assert [c.text for c in cues] == ["1999", "abcd"]
    numeric_span = cues[0].end - cues[0].start
    plain_span = cues[1].end - cues[1].start
    assert numeric_span > plain_span * 1.5


def test_heuristic_digit_weighting_applies_across_sentences_in_a_chunk():
    # The same under-weighting happens one level up: _cues_for_chunk splits
    # duration across sentences by character length too, so a numeral-heavy
    # sentence must get more than an equal-length numeral-free sentence's
    # share of the chunk. Both sentences are the same length (24 chars), so
    # unweighted code would give them equal spans -- any inequality here is
    # from the digit weighting, not from a length difference.
    cues = compute_cues(["The 1999 event happened. The nice event happened."], [4.0], [None])

    numeric_sentence_end = next(c.end for c in cues if c.text == "happened.")
    plain_sentence_span = 4.0 - numeric_sentence_end
    assert numeric_sentence_end > plain_sentence_span
