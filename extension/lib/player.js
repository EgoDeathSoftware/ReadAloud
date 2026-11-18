/**
 * Play a stream of MP3 blobs back to back.
 *
 * Exactly one chunk of lookahead: the generator is asked for chunk N+1 as
 * soon as chunk N starts playing, so synthesis overlaps playback without
 * buffering the whole article in memory.
 *
 * One stream owns the audio element at a time. `stop()` or a new `play()`
 * bumps `generation`, so an older play() loop -- possibly still waiting on a
 * chunk its generator hasn't aborted -- exits without touching the element.
 */
export function createPlayer({ audioElement } = {}) {
  const audio = audioElement || new Audio();
  let currentUrl = null;
  let phase = "idle";
  let generation = 0;
  let settleCurrent = null;
  let rate = 1.0;
  let chunkIndex = -1;

  function releaseUrl() {
    if (currentUrl) {
      URL.revokeObjectURL(currentUrl);
      currentUrl = null;
    }
  }

  function playBlob(blob) {
    return new Promise((resolve, reject) => {
      releaseUrl();
      currentUrl = URL.createObjectURL(blob);
      settleCurrent = resolve;
      audio.onended = () => resolve();
      audio.onerror = () => reject(new Error("Audio playback failed"));
      audio.src = currentUrl;
      audio.playbackRate = rate;
      audio.play().catch(reject);
    });
  }

  function teardown() {
    audio.onended = null;
    audio.onerror = null;
    settleCurrent = null;
    releaseUrl();
    chunkIndex = -1;
    phase = "idle";
  }

  /** End the current stream: silence the element and let its play() return. */
  function abandonCurrent() {
    generation += 1;
    audio.pause();
    const settle = settleCurrent;
    teardown();
    settle?.();
  }

  return {
    get phase() {
      return phase;
    },

    async play(generator) {
      abandonCurrent();
      const ownGeneration = generation;
      const isCurrent = () => ownGeneration === generation;
      phase = "playing";
      const iterator = generator[Symbol.asyncIterator]();
      let pending = iterator.next();

      try {
        while (isCurrent()) {
          const { value, done } = await pending;
          if (done || !isCurrent()) break;
          chunkIndex = value.index;
          pending = iterator.next();
          await playBlob(value.audio);
        }
      } finally {
        // Swallow the abandoned lookahead so it cannot surface as an
        // unhandled rejection after stop().
        Promise.resolve(pending).catch(() => {});
        if (isCurrent()) teardown();
      }
    },

    pause() {
      if (phase !== "playing") return;
      audio.pause();
      phase = "paused";
    },

    resume() {
      if (phase !== "paused") return;
      phase = "playing";
      audio.play();
    },

    setSpeed(value) {
      rate = value;
      audio.playbackRate = rate;
    },

    /** Index of the chunk currently playing, or -1 when idle. */
    get currentChunkIndex() {
      return chunkIndex;
    },

    /** Playback position within the current chunk, in seconds. */
    get currentTime() {
      return audio.currentTime;
    },

    skip(seconds) {
      if (phase !== "playing" && phase !== "paused") return;
      const duration = Number.isFinite(audio.duration) ? audio.duration : Infinity;
      audio.currentTime = Math.min(Math.max(audio.currentTime + seconds, 0), duration);
    },

    stop() {
      abandonCurrent();
    },
  };
}
