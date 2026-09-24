'use strict';

/**
 * Unit tests for edge/chunker.js: chunk counts, boundaries, overlap,
 * hard-split behavior, and edge cases.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { chunkText, splitSentences, normalizeText, DEFAULT_MAX_CHARS } from '../../edge/chunker.js';

test('splits a sample document into the expected chunk count and boundaries', () => {
  // Five sections, each ~120 chars of prose → each fills a chunk at the
  // small maxChars used here.
  const paragraph = (i) =>
    `Section ${i}. This section covers procedure ${i} for the hydraulic pump. ` +
    `Torque values must be recorded. Inspection follows the manual rev ${i}.`;

  const doc = [1, 2, 3, 4, 5].map(paragraph).join('\n\n');
  const chunks = chunkText(doc, { maxChars: 160, overlapChars: 0 });

  assert.equal(chunks.length, 5);
  for (const [i, chunk] of chunks.entries()) {
    assert.ok(chunk.length <= 160, `chunk ${i} too long: ${chunk.length}`);
    assert.match(chunk, new RegExp(`^Section ${i + 1}\\b`), `chunk ${i} starts at a section boundary`);
  }
  // Content preserved: every sentence appears in exactly one chunk.
  for (let i = 1; i <= 5; i++) {
    const count = chunks.filter((c) => c.includes(`procedure ${i} for the hydraulic pump`)).length;
    assert.equal(count, 1, `sentence ${i} should appear exactly once`);
  }
});

test('respects maxChars with a single long paragraph', () => {
  const doc = Array.from({ length: 30 }, (_, i) => `Point ${i}: inspect the filter and record the reading.`).join(' ');
  const chunks = chunkText(doc, { maxChars: 200, overlapChars: 0 });
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 200, `chunk too long: ${chunk.length}`);
  }
});

test('prepends overlap from the previous chunk', () => {
  const doc = Array.from({ length: 30 }, (_, i) => `Point ${i}: inspect the filter and record the reading.`).join(' ');
  const noOverlap = chunkText(doc, { maxChars: 200, overlapChars: 0 });
  const withOverlap = chunkText(doc, { maxChars: 200, overlapChars: 80 });

  assert.equal(withOverlap.length, noOverlap.length); // overlap does not add chunks
  // Each chunk after the first begins with words that ended the previous one.
  const firstWords = (s) => s.split(' ').slice(0, 3).join(' ');
  for (let i = 1; i < withOverlap.length; i++) {
    const overlapHead = firstWords(withOverlap[i]);
    assert.ok(
      noOverlap[i - 1].includes(overlapHead),
      `chunk ${i} overlap "${overlapHead}" should come from chunk ${i - 1}`
    );
  }
});

test('never drops text: hard-splits sentences longer than maxChars', () => {
  const longSentence = `Arg-${'x'.repeat(500)}`;
  const doc = `Intro sentence. ${longSentence} ends here. Final sentence.`;
  const chunks = chunkText(doc, { maxChars: 150, overlapChars: 0 });
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 150, `chunk too long: ${chunk.length}`);
  }
  // Chunks are separate passages, so contiguity is not preserved across them;
  // what must be preserved is every non-whitespace character.
  const contentChars = (s) => s.replace(/\s+/g, '').length;
  assert.equal(
    contentChars(chunks.join(' ')),
    contentChars(doc),
    'hard splitting must not lose a single character of content'
  );
  const rejoined = chunks.join(' ');
  assert.ok(rejoined.includes('Intro sentence.'));
  assert.ok(rejoined.includes('Final sentence.'));
});

test('normalizes CRLF and treats blank lines as hard paragraph boundaries', () => {
  const doc = 'First para here.\r\n\r\nSecond para follows.\r\n\r\nThird para ends.';
  const chunks = chunkText(doc, { maxChars: 100, overlapChars: 0 });
  assert.equal(chunks.length, 3, 'each blank-line-separated paragraph is its own chunk');
  assert.equal(chunks[0], 'First para here.');
  assert.equal(chunks[1], 'Second para follows.');
  assert.equal(chunks[2], 'Third para ends.');
  assert.ok(!chunks.some((c) => c.includes('\n')));
});

test('single line breaks inside a paragraph are joined into one chunk', () => {
  const doc = 'Line one continues\nline two continues\nline three.';
  const chunks = chunkText(doc, { maxChars: 200, overlapChars: 0 });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], 'Line one continues line two continues line three.');
});

test('returns empty array for blank input and throws on bad options', () => {
  assert.deepEqual(chunkText('   \n  \n'), []);
  assert.throws(() => chunkText('x', { maxChars: 10 }), RangeError);
  assert.throws(() => chunkText('x', { maxChars: 100, overlapChars: 100 }), RangeError);
  assert.throws(() => chunkText(/** @type {any} */ (42)), TypeError);
});

test('splitSentences keeps abbreviations-with-period glued to the next word', () => {
  const sentences = splitSentences('Check the no. 2 filter. Then Torque the bolt. Done.');
  assert.equal(sentences.length, 3);
});

test('default maxChars is conservative for nomic-embed-text', () => {
  assert.ok(DEFAULT_MAX_CHARS <= 2000);
});

test('normalizeText trims trailing whitespace per line (keeping final newline)', () => {
  assert.equal(normalizeText('a  \r\nb\t \n'), 'a\nb\n');
  assert.equal(normalizeText('a  \r\nb\t '), 'a\nb');
});
