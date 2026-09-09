import { splitSentences } from "/lib/chunker.js";

/**
 * Word-level cues for one synthesized chunk.
 *
 * JS port of backend/src/readaloud/services/reading_cues.py, restricted to a
 * single chunk: times start at 0, since the extension plays each chunk as its
 * own audio element rather than one stitched file.
 */

/** Matches Python's `[^\w\s]+` against a whole token. */
const PUNCTUATION_ONLY = /^[^\p{L}\p{N}_\s]+$/u;
const MIN_TIMESTAMP_COVERAGE = 0.8;

/**
 * Build one chunk's cues, timed from 0.
 *
 * Uses the TTS server's real per-word timestamps when they line up with the
 * chunk's own words, and otherwise splits `duration` across those words
 * proportional to character length. Cue text always comes from `text`, never
 * from the timestamps -- the server reports what it spoke, which its text
 * normalizer may have rewritten.
 */
export function cuesForChunk(text, duration, timestamps) {
  if (timestamps && timestamps.length) {
    const cues = cuesFromTimestamps(text, timestamps, duration);
    if (cues) return cues;
  }
  return heuristicCues(text, duration);
}

function paragraphsOf(text) {
  return text.split(/\n\n+/).filter((paragraph) => paragraph.trim());
}

function wordsOf(text) {
  return text.split(/\s+/).filter(Boolean);
}

function heuristicCues(text, duration) {
  const sentencesByParagraph = paragraphsOf(text).map((paragraph) =>
    splitSentences(paragraph).filter((sentence) => sentence.trim()),
  );
  const allSentences = sentencesByParagraph.flat();
  const totalChars = allSentences.reduce((sum, sentence) => sum + sentence.length, 0);
  if (!allSentences.length || totalChars === 0) return [];

  const cues = [];
  let start = 0;
  sentencesByParagraph.forEach((paragraphSentences, paragraphIndex) => {
    paragraphSentences.forEach((sentence, sentenceIndex) => {
      const end = start + duration * (sentence.length / totalChars);
      const lastInParagraph = sentenceIndex === paragraphSentences.length - 1;
      const lastParagraph = paragraphIndex === sentencesByParagraph.length - 1;
      const suffix = lastInParagraph && !lastParagraph ? "\n\n" : "";
      cues.push(...sentenceCues(sentence, start, end, suffix));
      start = end;
    });
  });
  return cues;
}

function sentenceCues(sentence, start, end, suffix) {
  const words = wordsOf(sentence);
  const totalChars = words.reduce((sum, word) => sum + word.length, 0);
  if (!words.length || totalChars === 0) return [];

  const duration = end - start;
  const cues = [];
  let cursor = start;
  words.forEach((word, index) => {
    const wordEnd = cursor + duration * (word.length / totalChars);
    const isLast = index === words.length - 1;
    cues.push({ text: isLast ? word + suffix : word, start: cursor, end: wordEnd });
    cursor = wordEnd;
  });
  return cues;
}

/**
 * Fold punctuation-only tokens into the adjacent word's span.
 *
 * Kokoro tokenizes punctuation separately ("test" then "."), while the source
 * text attaches it ("test."). Punctuation merges backward, or forward when it
 * opens the chunk -- a paragraph starting on a quotation mark is common enough
 * that leaving it standalone would fail alignment for the whole chunk.
 */
function mergePunctuation(timestamps) {
  const merged = [];
  let leading = [];

  for (const stamp of timestamps) {
    const isPunctuation = PUNCTUATION_ONLY.test(stamp.word);
    if (isPunctuation && merged.length) {
      const previous = merged[merged.length - 1];
      merged[merged.length - 1] = {
        word: previous.word + stamp.word,
        start: previous.start,
        end: stamp.end,
      };
    } else if (isPunctuation) {
      leading.push(stamp);
    } else if (leading.length) {
      merged.push({
        word: leading.map((entry) => entry.word).join("") + stamp.word,
        start: leading[0].start,
        end: stamp.end,
      });
      leading = [];
    } else {
      merged.push(stamp);
    }
  }

  if (leading.length) {
    merged.push({
      word: leading.map((entry) => entry.word).join(""),
      start: leading[0].start,
      end: leading[leading.length - 1].end,
    });
  }
  return merged;
}

/** The chunk's own words in order, each paragraph's last word carrying "\n\n". */
function chunkWords(text) {
  const paragraphs = paragraphsOf(text);
  const words = [];
  paragraphs.forEach((paragraph, index) => {
    const paragraphWords = wordsOf(paragraph);
    if (index < paragraphs.length - 1 && paragraphWords.length) {
      paragraphWords[paragraphWords.length - 1] += "\n\n";
    }
    words.push(...paragraphWords);
  });
  return words;
}

/** Kokoro can report a negative start for a chunk's first word. */
function clampStart(start, duration) {
  const clamped = Math.max(0, start);
  return duration > 0 ? Math.min(clamped, duration) : clamped;
}

/**
 * Returns the chunk's cues, or null when the timestamps can't be trusted: a
 * token count that doesn't match the chunk's own words (the normalizer
 * rewrote something, so no positional mapping holds), or timestamps ending
 * well before the audio does (which would freeze the highlight).
 */
function cuesFromTimestamps(text, timestamps, duration) {
  const merged = mergePunctuation(timestamps);
  const words = chunkWords(text);
  if (!merged.length || merged.length !== words.length) return null;
  if (duration > 0 && merged[merged.length - 1].end < duration * MIN_TIMESTAMP_COVERAGE) {
    return null;
  }

  const cues = words.map((word, index) => ({
    text: word,
    start: clampStart(merged[index].start, duration),
    end: merged[index].end,
  }));
  for (let index = 0; index < cues.length - 1; index++) {
    cues[index].end = cues[index + 1].start;
  }
  if (duration > 0) cues[cues.length - 1].end = duration;
  return cues;
}
