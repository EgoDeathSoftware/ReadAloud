import pytest

from readaloud.services.job_store import JobStore


@pytest.fixture
def store(tmp_path):
    return JobStore(root=tmp_path)


def test_written_chunks_read_back(store):
    store.write_chunk("job-1", 0, b"chunk-zero")
    store.write_chunk("job-1", 1, b"chunk-one")
    assert store.read_chunk("job-1", 0) == b"chunk-zero"
    assert store.read_chunk("job-1", 1) == b"chunk-one"


def test_missing_chunk_reads_as_none(store):
    store.write_chunk("job-1", 0, b"chunk-zero")
    assert store.read_chunk("job-1", 5) is None
    assert store.read_chunk("no-such-job", 0) is None


def test_final_audio_reads_back(store):
    store.write_final("job-1", b"stitched")
    assert store.read_final("job-1") == b"stitched"
    assert store.final_path("job-1") is not None


def test_missing_final_audio_reads_as_none(store):
    assert store.read_final("job-1") is None
    assert store.final_path("job-1") is None


def test_finalize_concatenates_chunks_in_index_order(store):
    for i in range(12):
        store.write_chunk("job-1", i, f"[{i}]".encode())
    store.finalize_from_chunks("job-1", 12)
    expected = b"".join(f"[{i}]".encode() for i in range(12))
    assert store.read_final("job-1") == expected


def test_chunks_of_varying_length_map_back_to_the_right_bytes(store):
    payloads = [b"x" * (i * 7 + 1) for i in range(12)]
    for i, payload in enumerate(payloads):
        store.write_chunk("job-1", i, payload)
    store.finalize_from_chunks("job-1", 12)

    for i, payload in enumerate(payloads):
        assert store.read_chunk("job-1", i) == payload


def test_finalize_frees_the_duplicate_chunk_files(store):
    """Only one copy of the audio survives the stitch."""
    store.write_chunk("job-1", 0, b"aaaa")
    store.write_chunk("job-1", 1, b"bbbb")
    store.finalize_from_chunks("job-1", 2)

    job_dir = store.root / "job-1"
    assert not list(job_dir.glob("chunk-*.mp3"))
    assert store.read_final("job-1") == b"aaaabbbb"


def test_chunks_stay_readable_after_the_stitch(store):
    """Clients fetch chunks lazily and can still be behind when the job completes."""
    store.write_chunk("job-1", 0, b"first")
    store.write_chunk("job-1", 1, b"second")
    store.write_chunk("job-1", 2, b"third")
    store.finalize_from_chunks("job-1", 3)

    assert store.read_chunk("job-1", 0) == b"first"
    assert store.read_chunk("job-1", 1) == b"second"
    assert store.read_chunk("job-1", 2) == b"third"
    assert store.read_chunk("job-1", 3) is None


def test_chunks_stay_readable_after_the_stitch_with_empty_chunks(store):
    store.write_chunk("job-1", 0, b"")
    store.write_chunk("job-1", 1, b"body")
    store.finalize_from_chunks("job-1", 2)

    assert store.read_chunk("job-1", 0) == b""
    assert store.read_chunk("job-1", 1) == b"body"


def test_finalize_fails_when_a_chunk_is_missing(store):
    store.write_chunk("job-1", 0, b"a")
    with pytest.raises(FileNotFoundError):
        store.finalize_from_chunks("job-1", 2)


def test_delete_removes_everything_for_one_job(store):
    store.write_chunk("job-1", 0, b"a")
    store.write_final("job-1", b"a")
    store.write_final("job-2", b"b")
    store.delete("job-1")
    assert store.read_final("job-1") is None
    assert store.read_chunk("job-1", 0) is None
    assert store.read_final("job-2") == b"b"


def test_delete_is_safe_for_an_unknown_job(store):
    store.delete("never-existed")


def test_purge_removes_the_root_directory(store, tmp_path):
    store.write_final("job-1", b"a")
    store.purge()
    assert not tmp_path.exists()


@pytest.mark.parametrize(
    "job_id",
    ["../escape", "a/b", "..", "", "with\0null", "/absolute"],
)
def test_rejects_job_ids_that_are_not_safe_path_segments(store, job_id):
    with pytest.raises(ValueError, match="job id"):
        store.write_final(job_id, b"x")
    with pytest.raises(ValueError, match="job id"):
        store.read_final(job_id)


def test_disk_usage_does_not_retain_bytes_in_memory(store):
    """Chunks live on disk, so the store itself holds no audio."""
    store.write_chunk("job-1", 0, b"x" * 1024)
    assert store.__dict__.get("_chunks") is None
    assert not any(isinstance(v, bytes) for v in store.__dict__.values())
