"""MPEG-1/2 Layer III (MP3) frame parsing.

`audio_stitcher` concatenates raw encoder output. If a chunk's encoder wrote
a Xing/Info VBR header as its first frame -- a silent placeholder frame that
declares the *chunk's* total frame/byte count for players' seek tables --
naive concatenation leaves one such header per chunk buried mid-stream.
Players read only the first one, so they report the duration of chunk one as
the duration of the whole file.

This module walks real audio frames (skipping ID3v2 tags and any Xing/Info
header frame) so the stitcher can rebuild a single correct header. Only
Layer III is handled: `response_format=mp3` never produces Layer I/II.
"""

from __future__ import annotations

from dataclasses import dataclass

# Layer III bitrates in kbps, indexed by the header's 4-bit bitrate index.
# Index 0 ("free") and 15 (reserved) are not used by real encoder output.
_BITRATE_KBPS = {
    3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, -1],  # MPEG1
    2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, -1],  # MPEG2/2.5
}
_SAMPLE_RATES = {
    3: [44100, 48000, 32000],  # MPEG1
    2: [22050, 24000, 16000],  # MPEG2
    0: [11025, 12000, 8000],  # MPEG2.5
}
_SAMPLES_PER_FRAME = {3: 1152, 2: 576, 0: 576}

_XING_TAGS = (b"Xing", b"Info")


@dataclass(frozen=True)
class FrameHeader:
    offset: int
    size: int
    version_bits: int  # 0=MPEG2.5, 2=MPEG2, 3=MPEG1
    channel_mode: int  # 0=stereo, 1=joint stereo, 2=dual channel, 3=mono
    sample_rate: int
    samples_per_frame: int
    header_bytes: bytes  # the raw 4-byte header, reused verbatim when rebuilding


def parse_frame_header(data: bytes, offset: int) -> FrameHeader | None:
    """Parse a Layer III frame header at `offset`, or None if invalid."""
    if offset < 0 or offset + 4 > len(data):
        return None

    b0, b1, b2, b3 = data[offset], data[offset + 1], data[offset + 2], data[offset + 3]
    if b0 != 0xFF or (b1 & 0xE0) != 0xE0:
        return None

    version_bits = (b1 >> 3) & 0x03
    layer_bits = (b1 >> 1) & 0x03
    if version_bits == 1 or layer_bits != 1:  # reserved version, or not Layer III
        return None

    bitrate_index = (b2 >> 4) & 0x0F
    samplerate_index = (b2 >> 2) & 0x03
    padding = (b2 >> 1) & 0x01
    channel_mode = (b3 >> 6) & 0x03

    if samplerate_index == 3:
        return None

    bitrate_table = _BITRATE_KBPS[3 if version_bits == 3 else 2]
    bitrate_kbps = bitrate_table[bitrate_index]
    if bitrate_kbps <= 0:  # free-form or reserved: not produced by fixed-setting encoders
        return None

    sample_rate = _SAMPLE_RATES[version_bits][samplerate_index]
    factor = 144 if version_bits == 3 else 72
    size = factor * bitrate_kbps * 1000 // sample_rate + padding
    if offset + size > len(data):
        return None

    return FrameHeader(
        offset=offset,
        size=size,
        version_bits=version_bits,
        channel_mode=channel_mode,
        sample_rate=sample_rate,
        samples_per_frame=_SAMPLES_PER_FRAME[version_bits],
        header_bytes=data[offset : offset + 4],
    )


def _xing_tag_offset(header: FrameHeader) -> int:
    """Byte offset of the Xing/Info tag, relative to the frame's own start."""
    mono = header.channel_mode == 3
    side_info = (17 if mono else 32) if header.version_bits == 3 else (9 if mono else 17)
    return 4 + side_info


def is_xing_or_info_header(data: bytes, header: FrameHeader) -> bool:
    """Whether `header`'s frame is a Xing/Info VBR header, not real audio."""
    tag_at = header.offset + _xing_tag_offset(header)
    return data[tag_at : tag_at + 4] in _XING_TAGS


def _id3v2_tag_size(data: bytes) -> int:
    """Total byte length of a leading ID3v2 tag, or 0 if there isn't one."""
    if len(data) < 10 or data[0:3] != b"ID3":
        return 0
    size = 0
    for byte in data[6:10]:
        size = (size << 7) | (byte & 0x7F)
    return 10 + size


def real_audio_frames(data: bytes) -> list[tuple[FrameHeader, bytes]]:
    """Walk `data` and return its real audio frames, in order.

    Skips a leading ID3v2 tag and a leading Xing/Info header frame -- neither
    carries audio. Stops at the first byte offset that doesn't hold a valid
    frame header, which is always the end of well-formed encoder output.
    """
    frames: list[tuple[FrameHeader, bytes]] = []
    offset = _id3v2_tag_size(data)
    first = True

    while True:
        header = parse_frame_header(data, offset)
        if header is None:
            break
        if first and is_xing_or_info_header(data, header):
            offset += header.size
            first = False
            continue
        first = False
        frames.append((header, data[offset : offset + header.size]))
        offset += header.size

    return frames


def frame_duration_seconds(frames: list[tuple[FrameHeader, bytes]]) -> float:
    """Total playback duration of a sequence of real audio frames, in seconds."""
    return sum(header.samples_per_frame / header.sample_rate for header, _raw in frames)


def build_xing_header_frame(template: FrameHeader, frame_sizes: list[int]) -> bytes:
    """Build a replacement Xing header frame describing the whole stitched file.

    Reuses `template`'s exact 4-byte MPEG header (any real audio frame works,
    since only frame *size* need match to keep byte offsets correct) and
    fills its payload with the Xing tag, frame/byte totals, and a TOC so
    players can seek accurately even into a variable-bitrate stream.

    Args:
        template: Header of a real audio frame from the stream, used as the
            size/format template for the header frame itself.
        frame_sizes: Sizes, in order, of every real audio frame that follows.
    """
    total_frames = len(frame_sizes) + 1  # the header frame counts itself
    total_bytes = template.size + sum(frame_sizes)

    body = bytearray(template.size - 4)
    tag_offset = _xing_tag_offset(template) - 4  # relative to body, not the frame
    flags = 0b0011  # frame count + byte count present; no TOC/quality
    payload = (
        b"Xing"
        + flags.to_bytes(4, "big")
        + total_frames.to_bytes(4, "big")
        + total_bytes.to_bytes(4, "big")
    )
    body[tag_offset : tag_offset + len(payload)] = payload

    return template.header_bytes + bytes(body)
