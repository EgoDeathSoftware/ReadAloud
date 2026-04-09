import re


def chunk_text(text: str, max_chars: int) -> list[str]:
    """Split text into chunks that fit within max_chars.

    Splitting strategy (in order of preference):
    1. Paragraph boundaries (double newline)
    2. Sentence boundaries
    3. Word boundaries

    Args:
        text: The text to split.
        max_chars: Maximum character count per chunk.

    Returns:
        List of text chunks. Never returns empty chunks.
    """
    text = text.strip()
    if not text:
        return []

    if len(text) <= max_chars:
        return [text]

    paragraphs = re.split(r"\n\n+", text)
    chunks: list[str] = []
    current = ""

    for para in paragraphs:
        if not para.strip():
            continue
        if len(para) > max_chars:
            if current:
                chunks.append(current)
                current = ""
            chunks.extend(_split_long_paragraph(para, max_chars))
        elif len(current) + len(para) + 2 > max_chars:
            if current:
                chunks.append(current)
            current = para
        elif current:
            current = current + "\n\n" + para
        else:
            current = para

    if current:
        chunks.append(current)

    return chunks


def _split_long_paragraph(text: str, max_chars: int) -> list[str]:
    """Split a paragraph that exceeds max_chars on sentence boundaries."""
    sentences = re.split(r"(?<=[.!?])\s+", text)
    chunks: list[str] = []
    current = ""

    for sentence in sentences:
        if len(sentence) > max_chars:
            if current:
                chunks.append(current)
                current = ""
            chunks.extend(_split_long_sentence(sentence, max_chars))
        elif len(current) + len(sentence) + 1 > max_chars:
            if current:
                chunks.append(current)
            current = sentence
        elif current:
            current = current + " " + sentence
        else:
            current = sentence

    if current:
        chunks.append(current)

    return chunks


def _split_long_sentence(text: str, max_chars: int) -> list[str]:
    """Split a sentence at word boundaries when it exceeds max_chars."""
    words = text.split()
    chunks: list[str] = []
    current = ""

    for word in words:
        if len(current) + len(word) + 1 > max_chars:
            if current:
                chunks.append(current)
            current = word
        elif current:
            current = current + " " + word
        else:
            current = word

    if current:
        chunks.append(current)

    return chunks
