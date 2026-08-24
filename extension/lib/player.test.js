import { describe, expect, it, vi } from "vitest";

import { createPlayer } from "./player.js";

/** Minimal stand-in for HTMLAudioElement driven manually by the test. */
function fakeAudio() {
  return {
    src: "",
    paused: true,
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
