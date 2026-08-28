import pytest

from readaloud.services.pdf_extractor import extract_from_pdf_bytes
from readaloud.services.text_extractor import MAX_CHARS
from tests.pdf_test_helpers import make_blank_pdf_bytes, make_pdf_bytes


def test_extracts_text_from_a_valid_pdf():
    result = extract_from_pdf_bytes(make_pdf_bytes("Hello World"))
    assert result.text == "Hello World"
    assert result.word_count == 2


def test_corrupt_bytes_become_a_value_error():
    with pytest.raises(ValueError, match="Could not parse PDF"):
        extract_from_pdf_bytes(b"not a pdf at all")


def test_pdf_with_no_text_becomes_a_value_error():
    with pytest.raises(ValueError, match="No text could be extracted"):
        extract_from_pdf_bytes(make_blank_pdf_bytes())


def test_text_is_truncated_to_the_maximum():
    long_pdf = make_pdf_bytes("word " * 40_000)
    result = extract_from_pdf_bytes(long_pdf)
    assert len(result.text) <= MAX_CHARS
