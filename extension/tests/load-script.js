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
  // Resolved via node:path rather than new URL(`../${x}`, import.meta.url):
  // under vitest's jsdom test environment, import.meta.url used in the same
  // expression as a template literal resolves to the filesystem root instead
  // of this file's directory (a Vite/Vitest transform quirk under that
  // environment, not a jsdom URL bug -- jsdom's own URL class resolves
  // relative paths correctly in isolation).
  const source = readFileSync(join(EXTENSION_ROOT, relativePath), "utf8");
  const tail = exposeNames.map((name) => `globalThis[${JSON.stringify(name)}] = ${name};`).join("");
  // eslint-disable-next-line no-new-func
  new Function(`${source}\n;${tail}`).call(globalThis);
}
