from unittest.mock import patch

import pytest

from readaloud.services.text_extractor import extract_from_url


@patch("readaloud.services.text_extractor.trafilatura")
def test_extract_from_url_success(mock_traf):
    mock_traf.fetch_url.return_value = "<html><body>Hello world</body></html>"
    mock_traf.extract.side_effect = [
        "Hello world content here",
        "Hello world content here",
        None,
    ]
    result = extract_from_url("https://example.com")
    assert result.text == "Hello world content here"
    assert result.word_count == 4


@patch("readaloud.services.text_extractor.trafilatura")
def test_extract_from_url_fetch_fails(mock_traf):
    mock_traf.fetch_url.return_value = None
    with pytest.raises(ValueError, match="Could not fetch URL"):
        extract_from_url("https://bad-url.com")


@patch("readaloud.services.text_extractor.trafilatura")
def test_extract_from_url_no_content(mock_traf):
    mock_traf.fetch_url.return_value = "<html></html>"
    mock_traf.extract.return_value = None
    with pytest.raises(ValueError, match="No content extracted"):
        extract_from_url("https://empty.com")
