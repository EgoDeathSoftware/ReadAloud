import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Evaluate a plain (non-module) extension script in the global scope, the way
 * tabs.executeScript does. Readability.js and content-reader.js cannot be
 * imported: executeScript has no module support, so neither file has ES
 * exports.
 *
 * @param {string} relativePath Path relative to the extension root.
 * @param {string[]} exposeNames Top-level names to publish on globalThis.
 */
export function loadScript(relativePath, exposeNames = []) {
  // jsdom's URL implementation mishandles ".." across multiple path segments
  // in file: URLs, so this joins with node:path instead of new URL(..).
  const source = readFileSync(join(EXTENSION_ROOT, relativePath), "utf8");
  const tail = exposeNames.map((name) => `globalThis[${JSON.stringify(name)}] = ${name};`).join("");
  // eslint-disable-next-line no-new-func
  new Function(`${source}\n;${tail}`).call(globalThis);
}
