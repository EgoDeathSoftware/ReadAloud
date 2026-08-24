/**
 * Split text into chunks that fit within maxChars.
 *
 * Mirrors backend/src/readaloud/services/text_chunker.py. Splitting order:
 * paragraph boundaries, then sentence boundaries, then word boundaries.
 * A single word longer than maxChars is emitted whole.
 */
export function chunkText(text, maxChars) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= maxChars) return [trimmed];

  return packSegments(trimmed.split(/\n\n+/), maxChars, "\n\n", (paragraph) =>
    splitLongParagraph(paragraph, maxChars),
  );
}

function splitLongParagraph(text, maxChars) {
  return packSegments(text.split(/(?<=[.!?])\s+/), maxChars, " ", (sentence) =>
    splitLongSentence(sentence, maxChars),
  );
}

function splitLongSentence(text, maxChars) {
  const words = text.split(/\s+/).filter(Boolean);
  return packSegments(words, maxChars, " ", (word) => [word]);
}

/**
 * Greedily pack segments into chunks, delegating oversized segments to a
 * finer-grained splitter.
 */
function packSegments(segments, maxChars, joiner, splitOversized) {
  const chunks = [];
  let current = "";

  for (const segment of segments) {
    if (!segment.trim()) continue;

    if (segment.length > maxChars) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      chunks.push(...splitOversized(segment));
    } else if (current && current.length + joiner.length + segment.length > maxChars) {
      chunks.push(current);
      current = segment;
    } else if (current) {
      current = current + joiner + segment;
    } else {
      current = segment;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}
