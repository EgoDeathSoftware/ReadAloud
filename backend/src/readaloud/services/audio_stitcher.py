import shutil
from collections.abc import Iterable
from pathlib import Path

from readaloud.services.mp3_frames import FrameHeader, build_xing_header_frame, real_audio_frames


def _stitch_real_frames(chunks: list[bytes]) -> tuple[bytes, list[list[bytes]]] | None:
    """Parse every chunk's real audio frames and rebuild one Xing header.

    Returns the header frame plus each chunk's own list of raw frame bytes,
    or None if any chunk isn't parseable MP3 (the caller falls back to plain
    concatenation, which is exactly what non-MP3 test fixtures expect).
    """
    per_chunk: list[list[bytes]] = []
    template = None

    for chunk in chunks:
        frames = real_audio_frames(chunk)
        if not frames and chunk:
            return None
        per_chunk.append([raw for _header, raw in frames])
        if template is None and frames:
            template = frames[0][0]

    if template is None:
        return None

    frame_sizes = [len(raw) for chunk_frames in per_chunk for raw in chunk_frames]
    header_frame = build_xing_header_frame(template, frame_sizes)
    return header_frame, per_chunk


def stitch_mp3(chunks: list[bytes]) -> bytes:
    """Concatenate MP3 audio chunks into a single, correctly-seekable MP3 stream.

    Binary concatenation of MP3 frames is valid, but if a chunk's encoder
    wrote a Xing/Info VBR header as its first frame, that header describes
    only the chunk it came from. Left in place, players read the first
    chunk's header and report its duration for the whole file. This strips
    any such header from each chunk and writes one at the front of the
    output describing the true total.

    Falls back to a raw `b"".join` for input that isn't parseable MP3.

    Args:
        chunks: List of MP3 byte sequences.

    Returns:
        Combined MP3 bytes.
    """
    stitched = _stitch_real_frames(chunks)
    if stitched is None:
        return b"".join(chunks)

    header_frame, per_chunk = stitched
    return header_frame + b"".join(raw for frames in per_chunk for raw in frames)


def stitch_mp3_to_file(sources: Iterable[Path], dest: Path) -> list[tuple[int, int]]:
    """Concatenate MP3 files into `dest`, same fix as `stitch_mp3`.

    Reads each source twice rather than holding them all in memory at once
    like `stitch_mp3` does: once to size up the real audio frames (to learn
    the total frame/byte counts the rebuilt header needs), once to stream
    them into `dest`. Only one source's bytes are ever in memory at a time.

    Args:
        sources: MP3 files, in playback order.
        dest: File to write, truncated if it already exists.

    Returns:
        One (offset, length) pair per source, giving the byte range in
        `dest` that holds that source's audio. Not necessarily the same
        bytes it started with: a leading Xing/Info header frame, if any, is
        stripped since it carries no audio.
    """
    sources = list(sources)

    per_source_sizes: list[list[int]] = []
    template = None
    for source in sources:
        frames = real_audio_frames(source.read_bytes())
        if not frames and source.stat().st_size:
            template = None
            break
        per_source_sizes.append([header.size for header, _raw in frames])
        if template is None and frames:
            template = frames[0][0]
    else:
        if per_source_sizes and template is not None:
            return _write_stitched(sources, dest, template, per_source_sizes)

    return _write_raw_concat(sources, dest)


def _write_stitched(
    sources: list[Path],
    dest: Path,
    template: FrameHeader,
    per_source_sizes: list[list[int]],
) -> list[tuple[int, int]]:
    header_frame = build_xing_header_frame(
        template, [size for sizes in per_source_sizes for size in sizes]
    )

    ranges = []
    position = len(header_frame)
    with dest.open("wb") as out:
        out.write(header_frame)
        for source in sources:
            frames = real_audio_frames(source.read_bytes())
            length = sum(len(raw) for _header, raw in frames)
            for _header, raw in frames:
                out.write(raw)
            ranges.append((position, length))
            position += length
    return ranges


def _write_raw_concat(sources: list[Path], dest: Path) -> list[tuple[int, int]]:
    ranges = []
    position = 0
    with dest.open("wb") as out:
        for source in sources:
            with source.open("rb") as handle:
                shutil.copyfileobj(handle, out)
            size = source.stat().st_size
            ranges.append((position, size))
            position += size
    return ranges
