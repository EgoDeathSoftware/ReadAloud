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

  it("weights a digit-heavy word by estimated spoken length, not character count", () => {
    // "1999" (4 chars) is spoken as roughly "nineteen ninety nine" -- far more
    // speech than its literal character count suggests. Weighting it by raw
    // character count (same as "abcd", also 4 chars) makes the highlight race
    // past it while the audio is still pronouncing the year.
    const cues = cuesForChunk("1999 abcd", 2, null);

    expect(cues.map((c) => c.text)).toEqual(["1999", "abcd"]);
    const numericSpan = cues[0].end - cues[0].start;
    const plainSpan = cues[1].end - cues[1].start;
    expect(numericSpan).toBeGreaterThan(plainSpan * 1.5);
  });

  it("applies digit weighting across sentences in a chunk too", () => {
    // Both sentences are the same length (24 chars) so unweighted code would
    // give them equal spans -- any inequality here is from the digit weighting.
    const cues = cuesForChunk("The 1999 event happened. The nice event happened.", 4, null);

    const numericSentenceEnd = cues.find((c) => c.text === "happened.").end;
    const plainSentenceSpan = 4 - numericSentenceEnd;
    expect(numericSentenceEnd).toBeGreaterThan(plainSentenceSpan);
  });
});
