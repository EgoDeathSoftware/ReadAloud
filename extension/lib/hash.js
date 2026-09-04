/**
 * SHA-256 hex digest of UTF-8 text, matching the backend's
 * hashlib.sha256(text.encode("utf-8")).hexdigest() byte-for-byte.
 */
export async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
