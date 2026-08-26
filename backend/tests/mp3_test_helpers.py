"""Builds synthetic MPEG-1/2 Layer III frames for stitcher/parser tests.

Real encoder output is never available in tests, so these helpers construct
byte-exact frames from the same ISO/IEC 11172-3 header layout the production
parser reads, including an optional Xing/Info VBR header at the correct
side-info offset.
"""

_BITRATE_KBPS = {
    3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, -1],  # MPEG1 layer III
    2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, -1],  # MPEG2/2.5 layer III
}
_SAMPLE_RATES = {3: 44100, 2: 22050, 0: 11025}


def frame_size(version: int, bitrate_index: int, samplerate_index: int, padding: int = 0) -> int:
    kbps = _BITRATE_KBPS[3 if version == 3 else 2][bitrate_index]
    rate = _SAMPLE_RATES[version]
    factor = 144 if version == 3 else 72
    return factor * kbps * 1000 // rate + padding


def build_frame(
    *,
    version: int = 3,
    bitrate_index: int = 1,
    samplerate_index: int = 0,
    padding: int = 0,
    mode: int = 0,
    xing_tag: str | None = None,
    num_frames: int = 0,
    num_bytes: int = 0,
) -> bytes:
    """Build one raw Layer III frame.

    If `xing_tag` ('Xing' or 'Info') is given, embeds a minimal VBR header at
    the side-info offset implied by `version`/`mode`.
    """
    size = frame_size(version, bitrate_index, samplerate_index, padding)
    b0 = 0xFF
    b1 = 0xE0 | (version << 3) | (1 << 1) | 1  # layer III, protection bit=1 (no CRC)
    b2 = (bitrate_index << 4) | (samplerate_index << 2) | (padding << 1)
    b3 = mode << 6
    header = bytes([b0, b1, b2, b3])
    body = bytearray(size - 4)

    if xing_tag:
        mono = mode == 3
        side_info = (17 if mono else 32) if version == 3 else (9 if mono else 17)
        payload = (
            xing_tag.encode("ascii")
            + (0b0011).to_bytes(4, "big")
            + num_frames.to_bytes(4, "big")
            + num_bytes.to_bytes(4, "big")
        )
        body[side_info : side_info + len(payload)] = payload

    return header + bytes(body)


def build_id3v2_tag(size: int) -> bytes:
    """A minimal ID3v2 header declaring `size` bytes of tag data to follow."""
    synchsafe = bytes(
        [
            (size >> 21) & 0x7F,
            (size >> 14) & 0x7F,
            (size >> 7) & 0x7F,
            size & 0x7F,
        ]
    )
    return b"ID3" + bytes([3, 0, 0]) + synchsafe + bytes(size)
