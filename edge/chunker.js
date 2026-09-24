'use strict';

/**
 * Document chunking for AeroEdge ingestion.
 *
 * Splits plain-text documents into overlapping, sentence-aware chunks sized
 * by characters so they embed well as standalone passages. Chunk size is
 * conservative for the default embedding model (nomic-embed-text, 8192-token
 * context) while keeping each chunk focused enough to retrieve cleanly.
 *
 * Pure string manipulation only: no I/O, no model calls, fully deterministic,
 * trivially unit-testable.
 */

/** Default max characters per chunk (~500 tokens for most models). */
export const DEFAULT_MAX_CHARS = 1600;
/** Default overlap characters between consecutive chunks (~2 sentences). */
export const DEFAULT_OVERLAP_CHARS = 200;

/**
 * Collapse CRLF/CR to LF, normalize non-breaking spaces, and trim trailing
 * whitespace on each line so chunk boundaries are stable across sources.
 * @param {string} text
 * @returns {string}
 */
export function normalizeText(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n');
}

/**
 * Split text into sentences. Deliberately simple and dependency-free:
 * a sentence ends at [.!?] followed by whitespace + an uppercase letter or
 * an opening quote/bracket, or at end of text. Digits after the period are
 * deliberately NOT treated as a boundary so decimals (45.5 N·m) and
 * reference numbers (no. 2 filter, rev 2.4) stay intact in maintenance text.
 * @param {string} text
 * @returns {string[]}
 */
export function splitSentences(text) {
  const matches = text.match(/[^.!?]+[.!?]+(?=\s+[A-Z"'\[(]|$)|[^.!?]+$/g);
  if (!matches) return text.trim() === '' ? [] : [text.trim()];
  return matches.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Greedy packer: fills one chunk with as many sentences as fit under
 * maxChars. Sentences longer than maxChars are hard-split (with an
 * ellipsis-free cut at a word boundary) so no sentence is ever dropped.
 * @param {string[]} sentences
 * @param {number} maxChars
 * @returns {string[]}
 */
function packSentences(sentences, maxChars) {
  /** @type {string[]} */
  const chunks = [];
  let current = '';

  /** @param {string} long */
  const hardSplit = (long) => {
    let rest = long;
    while (rest.length > maxChars) {
      let cut = rest.lastIndexOf(' ', maxChars);
      if (cut < Math.floor(maxChars * 0.5)) cut = maxChars;
      chunks.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    return rest;
  };

  for (const sentence of sentences) {
    let piece = sentence;
    if (piece.length > maxChars) {
      if (current.trim() !== '') chunks.push(current.trim());
      current = '';
      piece = hardSplit(piece);
      if (piece.length > 0) current = piece + ' ';
      continue;
    }
    const candidate = current === '' ? piece : current + ' ' + piece;
    if (candidate.length > maxChars) {
      chunks.push(current.trim());
      current = piece + ' ';
    } else {
      current = candidate + ' ';
    }
  }
  if (current.trim() !== '') chunks.push(current.trim());
  return chunks.filter((c) => c.length > 0);
}

/**
 * Chunk a document into passages.
 *
 * Paragraph boundaries are HARD boundaries: each output chunk belongs to
 * exactly one paragraph. Paragraphs larger than maxChars are split
 * sentence-by-sentence (never dropping text; over-long sentences are
 * hard-split at word boundaries). Paragraphs at or under the limit are kept
 * whole so retrieved passages stay semantically coherent.
 *
 * @param {string} text Raw document text.
 * @param {Object} [options]
 * @param {number} [options.maxChars] Maximum chunk length in characters.
 * @param {number} [options.overlapChars] Tail of the previous chunk prepended to the next one.
 * @returns {string[]} Chunk texts, in document order.
 */
export function chunkText(text, { maxChars = DEFAULT_MAX_CHARS, overlapChars = DEFAULT_OVERLAP_CHARS } = {}) {
  if (typeof text !== 'string') {
    throw new TypeError('chunkText expects a string');
  }
  if (!Number.isInteger(maxChars) || maxChars < 100) {
    throw new RangeError('maxChars must be an integer >= 100');
  }
  if (!Number.isInteger(overlapChars) || overlapChars < 0 || overlapChars >= maxChars) {
    throw new RangeError('overlapChars must be an integer in [0, maxChars)');
  }

  const normalized = normalizeText(text);
  if (normalized.trim() === '') return [];

  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((p) => p.replace(/\n/g, ' ').replace(/\s{2,}/g, ' ').trim())
    .filter((p) => p.length > 0);

  // Chunk PER PARAGRAPH: a paragraph larger than maxChars is packed
  // sentence-by-sentence (with hard splits for over-long sentences); smaller
  // paragraphs each become their own chunk. This keeps chunks semantically
  // coherent — a retrieved chunk never mixes two sections — which matters
  // more for grounded retrieval than hitting the exact size limit.
  /** @type {string[]} */
  const packed = [];
  for (const paragraph of paragraphs) {
    const sentences = splitSentences(paragraph);
    if (sentences.length === 0) continue;
    if (paragraph.length <= maxChars) {
      packed.push(paragraph);
    } else {
      packed.push(...packSentences(sentences, maxChars));
    }
  }

  if (overlapChars === 0 || packed.length <= 1) return packed;

  /** @type {string[]} */
  const overlapped = [packed[0]];
  for (let i = 1; i < packed.length; i++) {
    const prev = packed[i - 1];
    const tail = prev.slice(-overlapChars);
    const cut = tail.indexOf(' ');
    const tailTrimmed = (cut === -1 ? tail : tail.slice(cut + 1)).trim();
    const head = packed[i];
    overlapped.push(tailTrimmed === '' || head.startsWith(tailTrimmed) ? head : `${tailTrimmed} ${head}`);
  }
  return overlapped;
}
