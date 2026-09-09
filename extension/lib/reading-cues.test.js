import { describe, expect, it } from "vitest";

import { cuesForChunk } from "/lib/reading-cues.js";

describe("cuesForChunk with real timestamps", () => {
  it("uses server timings and keeps the submitted text", () => {
    const cues = cuesForChunk("Five dollars please.", 3, [
      { word: "Five", start: 0, end: 1 },
      { word: "dollars", start: 1, end: 2 },
      { word: "please", start: 2, end: 2.9 },
      { word: ".", start: 2.9, end: 3 },
    ]);

    expect(cues.map((c) => c.text)).toEqual(["Five", "dollars", "please."]);
    expect(cues[0].start).toBe(0);
    expect(cues[2].end).toBe(3);
  });

  it("snaps each cue's end to the next cue's start", () => {
    const cues = cuesForChunk("one two", 2, [
      { word: "one", start: 0, end: 0.8 },
      { word: "two", start: 1.0, end: 1.9 },
    ]);

    expect(cues[0].end).toBe(1.0);
    expect(cues[1].end).toBe(2);
  });

  it("clamps a negative first-word start to zero", () => {
    const cues = cuesForChunk("one two", 2, [
      { word: "one", start: -0.3, end: 0.9 },
      { word: "two", start: 0.9, end: 2 },
    ]);

    expect(cues[0].start).toBe(0);
  });

  it("merges a leading punctuation token forward", () => {
    const cues = cuesForChunk('"Stop there', 2, [
      { word: '"', start: 0, end: 0.1 },
      { word: "Stop", start: 0.1, end: 1 },
      { word: "there", start: 1, end: 2 },
    ]);

    expect(cues.map((c) => c.text)).toEqual(['"Stop', "there"]);
  });

  it("falls back to the heuristic when the token count does not match", () => {
    const cues = cuesForChunk("$5.00 please", 2, [
      { word: "five", start: 0, end: 0.5 },
      { word: "dollars", start: 0.5, end: 1 },
      { word: "please", start: 1, end: 2 },
    ]);

    expect(cues.map((c) => c.text)).toEqual(["$5.00", "please"]);
    expect(cues[1].end).toBe(2);
  });

  it("falls back to the heuristic when timestamps cover under 80% of the audio", () => {
    const cues = cuesForChunk("one two", 10, [
      { word: "one", start: 0, end: 1 },
      { word: "two", start: 1, end: 2 },
    ]);

    expect(cues[0].end).toBeCloseTo(5);
  });
});

describe("cuesForChunk heuristic", () => {
  it("splits the duration across words by character length", () => {
    const cues = cuesForChunk("aa bbbb", 6, null);

    expect(cues.map((c) => c.text)).toEqual(["aa", "bbbb"]);
    expect(cues[0].end).toBeCloseTo(2);
    expect(cues[1].end).toBeCloseTo(6);
  });

  it("marks the last word of a non-final paragraph with a break", () => {
    const cues = cuesForChunk("first para.\n\nsecond para.", 4, null);

    expect(cues.map((c) => c.text)).toEqual(["first", "para.\n\n", "second", "para."]);
  });

  it("returns nothing for empty text", () => {
    expect(cuesForChunk("   ", 4, null)).toEqual([]);
  });
});
