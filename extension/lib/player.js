/**
 * Play a stream of MP3 blobs back to back.
 *
 * Exactly one chunk of lookahead: the generator is asked for chunk N+1 as
 * soon as chunk N starts playing, so synthesis overlaps playback without
 * buffering the whole article in memory.
 */
export function createPlayer({ audioElement } = {}) {
  const audio = audioElement || new Audio();
  let currentUrl = null;
  let phase = "idle";
  let stopped = false;
  let settleCurrent = null;
  let rate = 1.0;

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
    phase = "idle";
  }

  return {
    get phase() {
      return phase;
    },

    async play(generator) {
      stopped = false;
      phase = "playing";
      const iterator = generator[Symbol.asyncIterator]();
      let pending = iterator.next();

      try {
        while (!stopped) {
          const { value, done } = await pending;
          if (done || stopped) break;
          pending = iterator.next();
          await playBlob(value.audio);
        }
      } finally {
        // Swallow the abandoned lookahead so it cannot surface as an
        // unhandled rejection after stop().
        Promise.resolve(pending).catch(() => {});
        teardown();
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

    stop() {
      stopped = true;
      audio.pause();
      settleCurrent?.();
    },
  };
}
