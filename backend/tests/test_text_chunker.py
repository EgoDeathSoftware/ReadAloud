from readaloud.services.text_chunker import chunk_text


def test_short_text_returns_single_chunk():
    result = chunk_text("Hello world", 100)
    assert result == ["Hello world"]


def test_empty_string_returns_empty_list():
    assert chunk_text("", 100) == []


def test_whitespace_only_returns_empty_list():
    assert chunk_text("   \n\n  ", 100) == []


def test_splits_on_paragraph_boundaries():
    text = "Paragraph one.\n\nParagraph two.\n\nParagraph three."
    result = chunk_text(text, 30)
    assert len(result) >= 2
    for chunk in result:
        assert len(chunk) <= 30
    combined = "\n\n".join(result)
    assert "Paragraph one." in combined
    assert "Paragraph two." in combined
    assert "Paragraph three." in combined


def test_splits_long_paragraph_on_sentences():
    text = "First sentence. Second sentence. Third sentence. Fourth sentence."
    result = chunk_text(text, 35)
    assert len(result) >= 2
    for chunk in result:
        assert len(chunk) <= 35


def test_splits_long_sentence_on_word_breaks():
    text = "word " * 50
    result = chunk_text(text.strip(), 30)
    assert len(result) >= 2
    for chunk in result:
        assert len(chunk) <= 30


def test_never_returns_empty_chunks():
    text = "A.\n\n\n\nB.\n\n\n\nC."
    result = chunk_text(text, 5)
    for chunk in result:
        assert chunk.strip() != ""


def test_exact_boundary():
    text = "12345"
    result = chunk_text(text, 5)
    assert result == ["12345"]
