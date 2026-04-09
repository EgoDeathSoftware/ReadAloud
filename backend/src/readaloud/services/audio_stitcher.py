def stitch_mp3(chunks: list[bytes]) -> bytes:
    """Concatenate MP3 audio chunks into a single MP3 stream.

    MP3 is frame-based, so binary concatenation produces valid output.

    Args:
        chunks: List of MP3 byte sequences.

    Returns:
        Combined MP3 bytes.
    """
    return b"".join(chunks)
