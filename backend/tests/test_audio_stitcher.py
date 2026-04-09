from readaloud.services.audio_stitcher import stitch_mp3


def test_stitch_multiple_chunks():
    chunks = [b"chunk1", b"chunk2", b"chunk3"]
    result = stitch_mp3(chunks)
    assert result == b"chunk1chunk2chunk3"


def test_stitch_single_chunk():
    result = stitch_mp3([b"only_chunk"])
    assert result == b"only_chunk"


def test_stitch_empty_list():
    result = stitch_mp3([])
    assert result == b""
