from readaloud.services.mp3_frames import (
    build_xing_header_frame,
    is_xing_or_info_header,
    parse_frame_header,
    real_audio_frames,
)
from tests.mp3_test_helpers import build_frame, build_id3v2_tag


def test_parse_frame_header_reads_size_and_sample_rate():
    frame = build_frame(bitrate_index=1, samplerate_index=0, mode=0)  # 32kbps, 44100Hz, stereo
    header = parse_frame_header(frame, 0)
    assert header is not None
    assert header.size == len(frame)
    assert header.sample_rate == 44100
    assert header.samples_per_frame == 1152


def test_parse_frame_header_rejects_bad_sync():
    assert parse_frame_header(b"\x00\x00\x00\x00", 0) is None


def test_parse_frame_header_rejects_reserved_sample_rate():
    data = bytearray(build_frame(bitrate_index=1, samplerate_index=0))
    data[2] |= 0b00001100  # samplerate index bits -> 11 (reserved)
    assert parse_frame_header(bytes(data), 0) is None


def test_parse_frame_header_returns_none_past_end_of_data():
    assert parse_frame_header(b"\xff\xfb", 0) is None


def test_is_xing_or_info_header_true_for_xing_frame():
    frame = build_frame(bitrate_index=1, samplerate_index=0, mode=0, xing_tag="Xing", num_frames=5)
    header = parse_frame_header(frame, 0)
    assert is_xing_or_info_header(frame, header) is True


def test_is_xing_or_info_header_true_for_info_frame_mono():
    frame = build_frame(bitrate_index=1, samplerate_index=0, mode=3, xing_tag="Info", num_frames=5)
    header = parse_frame_header(frame, 0)
    assert is_xing_or_info_header(frame, header) is True


def test_is_xing_or_info_header_false_for_plain_audio_frame():
    frame = build_frame(bitrate_index=1, samplerate_index=0, mode=0)
    header = parse_frame_header(frame, 0)
    assert is_xing_or_info_header(frame, header) is False


def test_real_audio_frames_strips_a_leading_xing_frame():
    xing = build_frame(bitrate_index=1, samplerate_index=0, mode=0, xing_tag="Xing", num_frames=3)
    audio1 = build_frame(bitrate_index=1, samplerate_index=0, mode=0)
    audio2 = build_frame(bitrate_index=1, samplerate_index=0, mode=0)
    data = xing + audio1 + audio2

    frames = real_audio_frames(data)

    assert [raw for _header, raw in frames] == [audio1, audio2]


def test_real_audio_frames_keeps_all_frames_when_no_xing_header():
    audio1 = build_frame(bitrate_index=1, samplerate_index=0, mode=0)
    audio2 = build_frame(bitrate_index=1, samplerate_index=0, mode=0)
    data = audio1 + audio2

    frames = real_audio_frames(data)

    assert [raw for _header, raw in frames] == [audio1, audio2]


def test_real_audio_frames_skips_a_leading_id3v2_tag():
    tag = build_id3v2_tag(37)
    audio1 = build_frame(bitrate_index=1, samplerate_index=0, mode=0)
    data = tag + audio1

    frames = real_audio_frames(data)

    assert [raw for _header, raw in frames] == [audio1]


def test_real_audio_frames_returns_nothing_for_non_mp3_bytes():
    assert real_audio_frames(b"not an mp3 file") == []


def test_build_xing_header_frame_matches_template_size():
    template_frame = build_frame(bitrate_index=1, samplerate_index=0, mode=0)
    template = parse_frame_header(template_frame, 0)

    xing_frame = build_xing_header_frame(template, frame_sizes=[len(template_frame)] * 4)

    assert len(xing_frame) == template.size


def test_build_xing_header_frame_declares_total_frame_and_byte_counts():
    template_frame = build_frame(bitrate_index=1, samplerate_index=0, mode=0)
    template = parse_frame_header(template_frame, 0)
    frame_sizes = [len(template_frame)] * 4

    xing_frame = build_xing_header_frame(template, frame_sizes=frame_sizes)

    side_info = 32  # stereo, MPEG1
    tag_offset = 4 + side_info
    assert xing_frame[tag_offset : tag_offset + 4] in (b"Xing", b"Info")
    num_frames = int.from_bytes(xing_frame[tag_offset + 8 : tag_offset + 12], "big")
    num_bytes = int.from_bytes(xing_frame[tag_offset + 12 : tag_offset + 16], "big")
    assert num_frames == len(frame_sizes) + 1  # header frame counts itself
    assert num_bytes == template.size + sum(frame_sizes)
