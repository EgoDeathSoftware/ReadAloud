/**
 * Playback duration of an audio blob, in seconds.
 *
 * The direct TTS server reports no duration, but the character-count cue
 * heuristic needs one. Resolves to 0 if the metadata never loads, which makes
 * every cue in that chunk zero-length -- no highlight rather than a wrong one.
 */
export function measureDuration(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio();
    const finish = (duration) => {
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(duration) ? duration : 0);
    };
    audio.onloadedmetadata = () => finish(audio.duration);
    audio.onerror = () => finish(0);
    audio.src = url;
  });
}
