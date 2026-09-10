import { describe, expect, it, vi } from "vitest";

import { createPlayer } from "./player.js";

/** Minimal stand-in for HTMLAudioElement driven manually by the test. */
function fakeAudio() {
  return {
    src: "",
    paused: true,
    currentTime: 0,
    duration: 100,
    onended: null,
    onerror: null,
    played: [],
    play: vi.fn(function () {
      this.paused = false;
      this.played.push(this.src);
      return Promise.resolve();
    }),
    pause: vi.fn(function () {
      this.paused = true;
    }),
    finish() {
      this.onended?.();
    },
  };
}

async function* chunks(count) {
  for (let index = 0; index < count; index++) {
    yield { audio: new Blob([`chunk${index}`]), index, total: count };
  }
}

function setupObjectUrls() {
  let counter = 0;
  globalThis.URL.createObjectURL = vi.fn(() => `blob:chunk-${counter++}`);
  globalThis.URL.revokeObjectURL = vi.fn();
}

describe("createPlayer", () => {
  it("plays chunks in order and resolves when done", async () => {
    setupObjectUrls();
    const audio = fakeAudio();
    const player = createPlayer({ audioElement: audio });

    const done = player.play(chunks(3));
    for (let i = 0; i < 3; i++) {
      await vi.waitFor(() => expect(audio.play).toHaveBeenCalledTimes(i + 1));
      audio.finish();
    }
    await done;

    expect(audio.played).toEqual(["blob:chunk-0", "blob:chunk-1", "blob:chunk-2"]);
    expect(player.phase).toBe("idle");
  });

  it("revokes every object URL it creates", async () => {
    setupObjectUrls();
    const audio = fakeAudio();
    const player = createPlayer({ audioElement: audio });

    const done = player.play(chunks(2));
    for (let i = 0; i < 2; i++) {
      await vi.waitFor(() => expect(audio.play).toHaveBeenCalledTimes(i + 1));
      audio.finish();
    }
    await done;

    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it("pauses and resumes the underlying element", async () => {
    setupObjectUrls();
    const audio = fakeAudio();
    const player = createPlayer({ audioElement: audio });

    const done = player.play(chunks(1));
    await vi.waitFor(() => expect(audio.play).toHaveBeenCalledTimes(1));

    player.pause();
    expect(audio.pause).toHaveBeenCalled();
    expect(player.phase).toBe("paused");

    player.resume();
    expect(player.phase).toBe("playing");
    expect(audio.play).toHaveBeenCalledTimes(2);

    audio.finish();
    await done;
  });

  it("applies speed changes to the current and subsequent chunks", async () => {
    setupObjectUrls();
    const audio = fakeAudio();
    const player = createPlayer({ audioElement: audio });

    const done = player.play(chunks(2));
    await vi.waitFor(() => expect(audio.play).toHaveBeenCalledTimes(1));

    player.setSpeed(1.5);
    expect(audio.playbackRate).toBe(1.5);

    audio.finish();
    await vi.waitFor(() => expect(audio.play).toHaveBeenCalledTimes(2));
    expect(audio.playbackRate).toBe(1.5);

    audio.finish();
    await done;
  });

  it("stops mid-stream without playing later chunks", async () => {
    setupObjectUrls();
    const audio = fakeAudio();
    const player = createPlayer({ audioElement: audio });

    const done = player.play(chunks(5));
    await vi.waitFor(() => expect(audio.play).toHaveBeenCalledTimes(1));
    player.stop();
    await done;

    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(player.phase).toBe("idle");
  });

  it("skips forward and backward within the current chunk, clamped to bounds", async () => {
    setupObjectUrls();
    const audio = fakeAudio();
    const player = createPlayer({ audioElement: audio });

    const done = player.play(chunks(1));
    await vi.waitFor(() => expect(audio.play).toHaveBeenCalledTimes(1));

    audio.currentTime = 10;
    player.skip(15);
    expect(audio.currentTime).toBe(25);

    player.skip(-100);
    expect(audio.currentTime).toBe(0);

    audio.currentTime = 95;
    player.skip(15);
    expect(audio.currentTime).toBe(100);

    audio.finish();
    await done;
  });

  it("ignores skip when idle", async () => {
    setupObjectUrls();
    const audio = fakeAudio();
    const player = createPlayer({ audioElement: audio });

    audio.currentTime = 10;
    player.skip(15);
    expect(audio.currentTime).toBe(10);
  });

  it("reports the index of the chunk being played", async () => {
    setupObjectUrls();
    const audio = fakeAudio();
    const player = createPlayer({ audioElement: audio });
    expect(player.currentChunkIndex).toBe(-1);

    const seen = [];
    const generator = (async function* () {
      yield { audio: new Blob(["a"]), index: 0, total: 2, cues: [] };
      seen.push(player.currentChunkIndex);
      yield { audio: new Blob(["b"]), index: 1, total: 2, cues: [] };
      seen.push(player.currentChunkIndex);
    })();

    const done = player.play(generator);
    await vi.waitFor(() => expect(audio.play).toHaveBeenCalledTimes(1));
    audio.finish();
    await vi.waitFor(() => expect(audio.play).toHaveBeenCalledTimes(2));
    audio.finish();
    await done;

    expect(seen[0]).toBe(0);
    expect(player.currentChunkIndex).toBe(-1);
  });

  it("reports the current time of the playing chunk", async () => {
    setupObjectUrls();
    const audio = fakeAudio();
    audio.currentTime = 1.25;
    const player = createPlayer({ audioElement: audio });

    expect(player.currentTime).toBe(1.25);
  });

  it("propagates a generator failure", async () => {
    setupObjectUrls();
    const audio = fakeAudio();
    const player = createPlayer({ audioElement: audio });

    async function* boom() {
      throw new Error("synthesis failed");
    }

    await expect(player.play(boom())).rejects.toThrow(/synthesis failed/);
    expect(player.phase).toBe("idle");
  });

  it("reports a playback error", async () => {
    setupObjectUrls();
    const audio = fakeAudio();
    const player = createPlayer({ audioElement: audio });

    const done = player.play(chunks(1));
    await vi.waitFor(() => expect(audio.play).toHaveBeenCalledTimes(1));
    audio.onerror();

    await expect(done).rejects.toThrow(/playback failed/i);
  });
});
