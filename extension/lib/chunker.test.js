import { describe, expect, it } from "vitest";

import { chunkText, splitSentences } from "./chunker.js";

describe("chunkText", () => {
  it("returns an empty array for blank input", () => {
    expect(chunkText("", 100)).toEqual([]);
    expect(chunkText("   \n\n  ", 100)).toEqual([]);
  });

  it("returns a single chunk when the text fits", () => {
    expect(chunkText("Hello world.", 100)).toEqual(["Hello world."]);
  });

  it("trims surrounding whitespace", () => {
    expect(chunkText("  Hello world.  ", 100)).toEqual(["Hello world."]);
  });

  it("splits on paragraph boundaries first", () => {
    const text = "A".repeat(60) + "\n\n" + "B".repeat(60);
    expect(chunkText(text, 100)).toEqual(["A".repeat(60), "B".repeat(60)]);
  });

  it("packs several short paragraphs into one chunk", () => {
    const text = "One.\n\nTwo.\n\nThree.";
    expect(chunkText(text, 100)).toEqual(["One.\n\nTwo.\n\nThree."]);
  });

  it("falls back to sentence boundaries for a long paragraph", () => {
    const text = "A".repeat(60) + ". " + "B".repeat(60) + ".";
    expect(chunkText(text, 100)).toEqual(["A".repeat(60) + ".", "B".repeat(60) + "."]);
  });

  it("falls back to word boundaries for a long sentence", () => {
    const text = Array.from({ length: 40 }, () => "word").join(" ");
    const chunks = chunkText(text, 50);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(50);
    }
    expect(chunks.join(" ")).toEqual(text);
  });

  it("never emits an empty chunk", () => {
    const text = "One.\n\n\n\n\n\nTwo.";
    expect(chunkText(text, 10).every((c) => c.trim().length > 0)).toBe(true);
  });

  it("emits a chunk for a single word longer than the limit", () => {
    expect(chunkText("X".repeat(30), 10)).toEqual(["X".repeat(30)]);
  });
});

describe("splitSentences", () => {
  it("splits on sentence-ending punctuation followed by whitespace", () => {
    expect(splitSentences("One. Two! Three?")).toEqual(["One.", "Two!", "Three?"]);
  });

  it("returns a single sentence unchanged", () => {
    expect(splitSentences("No terminator here")).toEqual(["No terminator here"]);
  });
});

describe("chunk word round trip", () => {
  it("preserves the word sequence across chunk boundaries", () => {
    const paragraph = "Alpha beta gamma delta epsilon zeta eta theta iota kappa.";
    const text = [paragraph, paragraph, paragraph, paragraph].join("\n\n");
    const words = text.split(/\s+/).filter(Boolean);

    const chunked = chunkText(text, 80).flatMap((chunk) => chunk.split(/\s+/).filter(Boolean));

    expect(chunked).toEqual(words);
  });

  it("preserves the word sequence when a single sentence exceeds the chunk size", () => {
    const text = "one two three four five six seven eight nine ten eleven twelve";
    const words = text.split(" ");

    const chunked = chunkText(text, 20).flatMap((chunk) => chunk.split(/\s+/).filter(Boolean));

    expect(chunked).toEqual(words);
  });
});
