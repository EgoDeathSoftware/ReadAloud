import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { sha256Hex } from "./hash.js";

describe("sha256Hex", () => {
  it("matches Node's own SHA-256 for arbitrary text", async () => {
    const text = "The quick brown fox jumps over the lazy dog";
    const expected = createHash("sha256").update(text, "utf8").digest("hex");
    await expect(sha256Hex(text)).resolves.toBe(expected);
  });

  it("matches for empty text", async () => {
    const expected = createHash("sha256").update("", "utf8").digest("hex");
    await expect(sha256Hex("")).resolves.toBe(expected);
  });

  it("matches for non-ASCII text", async () => {
    const text = "Héllo wörld — café";
    const expected = createHash("sha256").update(text, "utf8").digest("hex");
    await expect(sha256Hex(text)).resolves.toBe(expected);
  });

  it("produces different hashes for different text", async () => {
    await expect(sha256Hex("a")).resolves.not.toBe(await sha256Hex("b"));
  });
});
