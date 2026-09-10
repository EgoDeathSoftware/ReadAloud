import { describe, expect, it } from "vitest";

import { findActiveCueIndex } from "/lib/cues.js";

const cues = [
  { text: "one", start: 0, end: 1 },
  { text: "two", start: 1, end: 2 },
  { text: "three", start: 2, end: 3 },
];

describe("findActiveCueIndex", () => {
  it("finds the cue containing the time", () => {
    expect(findActiveCueIndex(cues, 1.5)).toBe(1);
  });

  it("treats a cue's start as inside it and its end as outside", () => {
    expect(findActiveCueIndex(cues, 1)).toBe(1);
    expect(findActiveCueIndex(cues, 2)).toBe(2);
  });

  it("returns null past the last cue", () => {
    expect(findActiveCueIndex(cues, 3)).toBeNull();
  });

  it("returns null in a gap between cues", () => {
    const gapped = [
      { text: "one", start: 0, end: 1 },
      { text: "two", start: 2, end: 3 },
    ];
    expect(findActiveCueIndex(gapped, 1.5)).toBeNull();
  });

  it("returns null for an empty cue list", () => {
    expect(findActiveCueIndex([], 0)).toBeNull();
  });
});
