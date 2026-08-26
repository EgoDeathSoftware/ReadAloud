from readaloud.services.audio_stitcher import stitch_mp3, stitch_mp3_to_file
from readaloud.services.mp3_frames import parse_frame_header, real_audio_frames
from tests.mp3_test_helpers import build_frame


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


def test_stitch_to_file_concatenates_in_order(tmp_path):
    sources = []
    for i, payload in enumerate([b"chunk1", b"chunk2", b"chunk3"]):
        path = tmp_path / f"src-{i}.mp3"
        path.write_bytes(payload)
        sources.append(path)

    dest = tmp_path / "out.mp3"
    stitch_mp3_to_file(sources, dest)
    assert dest.read_bytes() == b"chunk1chunk2chunk3"


def test_stitch_to_file_with_no_sources_writes_an_empty_file(tmp_path):
    dest = tmp_path / "out.mp3"
    stitch_mp3_to_file([], dest)
    assert dest.read_bytes() == b""


def test_stitch_to_file_overwrites_an_existing_destination(tmp_path):
    source = tmp_path / "src.mp3"
    source.write_bytes(b"new")
    dest = tmp_path / "out.mp3"
    dest.write_bytes(b"stale-and-longer")

    stitch_mp3_to_file([source], dest)
    assert dest.read_bytes() == b"new"


def _chunk_with_xing(num_real_frames: int, chunk_frame_count: int) -> tuple[bytes, list[bytes]]:
    """A synthetic encoder-output chunk: a Xing header frame (describing only
    this chunk) followed by `num_real_frames` real audio frames."""
    xing = build_frame(
        bitrate_index=1,
        samplerate_index=0,
        mode=0,
        xing_tag="Xing",
        num_frames=chunk_frame_count,
    )
    audio = [
        build_frame(bitrate_index=1, samplerate_index=0, mode=0) for _ in range(num_real_frames)
    ]
    return xing + b"".join(audio), audio


def test_stitch_mp3_rewrites_a_single_correct_xing_header():
    chunk1, audio1 = _chunk_with_xing(2, chunk_frame_count=3)
    chunk2, audio2 = _chunk_with_xing(3, chunk_frame_count=4)

    result = stitch_mp3([chunk1, chunk2])

    assert [raw for _header, raw in real_audio_frames(result)] == audio1 + audio2

    header = parse_frame_header(result, 0)
    tag_offset = 4 + 32  # stereo, MPEG1 side info
    assert result[tag_offset : tag_offset + 4] in (b"Xing", b"Info")
    num_frames = int.from_bytes(result[tag_offset + 8 : tag_offset + 12], "big")
    assert num_frames == len(audio1) + len(audio2) + 1
    assert header.size == len(audio1[0])


def test_stitch_mp3_adds_a_xing_header_even_when_chunks_have_none():
    audio1 = [build_frame(bitrate_index=1, samplerate_index=0, mode=0) for _ in range(2)]
    audio2 = [build_frame(bitrate_index=1, samplerate_index=0, mode=0) for _ in range(3)]
    chunk1, chunk2 = b"".join(audio1), b"".join(audio2)

    result = stitch_mp3([chunk1, chunk2])

    assert [raw for _header, raw in real_audio_frames(result)] == audio1 + audio2
    tag_offset = 4 + 32
    assert result[tag_offset : tag_offset + 4] in (b"Xing", b"Info")


def test_stitch_mp3_to_file_returns_per_source_audio_byte_ranges(tmp_path):
    chunk1, audio1 = _chunk_with_xing(2, chunk_frame_count=3)
    chunk2, audio2 = _chunk_with_xing(3, chunk_frame_count=4)
    paths = []
    for i, payload in enumerate([chunk1, chunk2]):
        path = tmp_path / f"c{i}.mp3"
        path.write_bytes(payload)
        paths.append(path)

    dest = tmp_path / "out.mp3"
    ranges = stitch_mp3_to_file(paths, dest)

    stitched = dest.read_bytes()
    assert len(ranges) == 2
    (off1, len1), (off2, len2) = ranges
    assert stitched[off1 : off1 + len1] == b"".join(audio1)
    assert stitched[off2 : off2 + len2] == b"".join(audio2)


def test_stitch_mp3_to_file_ranges_match_raw_offsets_for_non_mp3_data(tmp_path):
    payloads = [b"chunk1", b"chunk22", b"c3"]
    paths = []
    for i, payload in enumerate(payloads):
        path = tmp_path / f"c{i}.bin"
        path.write_bytes(payload)
        paths.append(path)

    dest = tmp_path / "out.bin"
    ranges = stitch_mp3_to_file(paths, dest)

    assert ranges == [(0, 6), (6, 7), (13, 2)]
    assert dest.read_bytes() == b"".join(payloads)


def test_stitch_mp3_to_file_with_no_sources_returns_no_ranges(tmp_path):
    dest = tmp_path / "out.mp3"
    ranges = stitch_mp3_to_file([], dest)
    assert ranges == []
