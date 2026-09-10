/**
 * Binary-search `cues` (sorted, non-overlapping, ascending by start) for the
 * one containing `time`. Returns null if `time` falls before the first cue,
 * after the last cue, or in a gap between two cues.
 *
 * Mirrors frontend/src/lib/cues.ts.
 */
export function findActiveCueIndex(cues, time) {
  let low = 0;
  let high = cues.length - 1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    const cue = cues[mid];
    if (cue === undefined) break;
    if (time < cue.start) {
      high = mid - 1;
    } else if (time >= cue.end) {
      low = mid + 1;
    } else {
      return mid;
    }
  }

  return null;
}
