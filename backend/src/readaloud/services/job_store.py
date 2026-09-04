"""Disk-backed storage for generated job audio.

Keeping chunk audio and the stitched result in the job dict held both copies in
memory — roughly twice the audio — for the lifetime of the process. A few
100k-char articles pinned hundreds of megabytes. Audio now lives in a temp
directory keyed by job id, and chunk files are discarded once the stitch lands.
"""

import json
import shutil
import tempfile
from pathlib import Path

from readaloud.services.audio_stitcher import stitch_mp3_to_file

FINAL_NAME = "final.mp3"
INDEX_NAME = "chunks.json"


def _safe_segment(job_id: str) -> str:
    """Reject job ids that are not a single, safe path segment.

    Job ids are server-generated UUIDs, but they arrive back through URL paths, so
    this keeps a future refactor from turning a lookup into path traversal.
    """
    if not job_id or job_id in {".", ".."} or set(job_id) & {"/", "\\", "\0"}:
        raise ValueError(f"Unsafe job id: {job_id!r}")
    return job_id


class JobStore:
    """Stores per-job audio under a root directory, one subdirectory per job."""

    def __init__(self, root: Path | None = None) -> None:
        self._root: Path | None = Path(root) if root is not None else None

    @property
    def root(self) -> Path:
        """The storage root, created on first use."""
        if self._root is None:
            self._root = Path(tempfile.mkdtemp(prefix="readaloud-jobs-"))
        self._root.mkdir(parents=True, exist_ok=True)
        return self._root

    def _job_dir(self, job_id: str) -> Path:
        return self.root / _safe_segment(job_id)

    def _chunk_path(self, job_id: str, index: int) -> Path:
        return self._job_dir(job_id) / f"chunk-{index:06d}.mp3"

    def write_chunk(self, job_id: str, index: int, data: bytes) -> None:
        path = self._chunk_path(job_id, index)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def read_chunk(self, job_id: str, index: int) -> bytes | None:
        """Read one chunk, before or after the stitch.

        Clients pull chunks lazily and are often still behind when the job finishes,
        so once the chunk files are gone the bytes are served as a slice of the final
        file using the offsets recorded at stitch time.
        """
        if index < 0:
            return None

        path = self._chunk_path(job_id, index)
        if path.is_file():
            return path.read_bytes()

        offsets = self._read_index(job_id)
        if offsets is None or index >= len(offsets):
            return None
        final = self._job_dir(job_id) / FINAL_NAME
        if not final.is_file():
            return None

        start, length = offsets[index]
        with final.open("rb") as handle:
            handle.seek(start)
            return handle.read(length)

    def _read_index(self, job_id: str) -> list[list[int]] | None:
        path = self._job_dir(job_id) / INDEX_NAME
        if not path.is_file():
            return None
        return json.loads(path.read_text())

    def write_final(self, job_id: str, data: bytes) -> None:
        path = self._job_dir(job_id) / FINAL_NAME
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def read_final(self, job_id: str) -> bytes | None:
        path = self._job_dir(job_id) / FINAL_NAME
        return path.read_bytes() if path.is_file() else None

    def final_path(self, job_id: str) -> Path | None:
        """Path to the stitched audio, or None if the job has not finished."""
        path = self._job_dir(job_id) / FINAL_NAME
        return path if path.is_file() else None

    def finalize_from_chunks(self, job_id: str, count: int) -> None:
        """Stitch `count` chunks into the final file, then discard the chunk files.

        Records each chunk's (offset, length) in the stitched file, so chunk
        reads keep working against a single copy of the audio. These come from
        the stitch itself rather than the chunks' own file sizes: the stitcher
        may drop a leading Xing/Info header frame from a chunk to rebuild one
        correct header for the whole file, which shifts that chunk's audio to
        a different length than it started with.

        Raises:
            FileNotFoundError: If any chunk is missing.
        """
        sources = []
        for index in range(count):
            path = self._chunk_path(job_id, index)
            if not path.is_file():
                raise FileNotFoundError(f"Missing chunk {index} for job {job_id}")
            sources.append(path)

        job_dir = self._job_dir(job_id)
        offsets = stitch_mp3_to_file(sources, job_dir / FINAL_NAME)
        (job_dir / INDEX_NAME).write_text(json.dumps(offsets))

        for path in sources:
            path.unlink(missing_ok=True)

    def delete(self, job_id: str) -> None:
        """Remove all audio for one job. A no-op if nothing was stored."""
        shutil.rmtree(self._job_dir(job_id), ignore_errors=True)

    def purge(self) -> None:
        """Remove the storage root entirely, for shutdown."""
        if self._root is not None:
            shutil.rmtree(self._root, ignore_errors=True)


job_store = JobStore()
