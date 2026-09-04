import { describe, expect, it } from "vitest";

import { sliceFromArticle } from "./read-from-here.js";

describe("sliceFromArticle", () => {
  it("returns the article from the exact snippet onward", () => {
    const article = "Once upon a time. The hero begins the journey. The end.";
    expect(sliceFromArticle(article, "The hero begins")).toBe(
      "The hero begins the journey. The end."
    );
  });

  it("matches a snippet whose whitespace differs from the article's", () => {
    const article = "Once upon a time.\nThe hero  begins\tthe journey. The end.";
    expect(sliceFromArticle(article, "The hero begins the journey")).toBe(
      "The hero begins the journey. The end."
    );
  });

  it("returns null when the snippet cannot be found", () => {
    const article = "Once upon a time. The hero begins the journey.";
    expect(sliceFromArticle(article, "a sentence that never appears")).toBeNull();
  });

  it("uses the first occurrence when the snippet repeats", () => {
    const article = "The end is near. Nothing happens. The end is near. Credits roll.";
    expect(sliceFromArticle(article, "The end is near")).toBe(
      "The end is near. Nothing happens. The end is near. Credits roll."
    );
  });
});
