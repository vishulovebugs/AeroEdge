'use strict';

/**
 * Unit tests for prompt construction in edge/rag.js: retrieved chunk
 * content must appear VERBATIM in the prompt sent to Ollama, grounding
 * instructions must be present, and the no-evidence path must be explicit.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildGroundedPrompt } from '../../edge/rag.js';

const CHUNKS = [
  {
    chunkId: 'c1',
    documentId: 'doc-1',
    source: 'AMM rev 42',
    content: 'Hydraulic system B: normal operating pressure range 2800-3200 PSI.',
    score: 0.91,
  },
  {
    chunkId: 'c2',
    documentId: 'doc-1',
    source: 'AMM rev 42',
    content: 'If pressure exceeds 3200 PSI, relieve via the B-system thermal relief valve.',
    score: 0.74,
  },
];

test('includes retrieved chunk content verbatim in the prompt', () => {
  const { prompt } = buildGroundedPrompt('What is the B-system pressure range?', CHUNKS);
  for (const chunk of CHUNKS) {
    assert.ok(prompt.includes(chunk.content), `missing verbatim content: "${chunk.content.slice(0, 40)}..."`);
  }
});

test('preserves even whitespace-sensitive content byte-for-byte', () => {
  const awkward = [{ ...CHUNKS[0], content: 'Torque  to   45  N·m   (double  spaces   kept).' }];
  const { prompt } = buildGroundedPrompt('q', awkward);
  assert.ok(prompt.includes(awkward[0].content));
});

test('numbers the excerpts and attributes sources', () => {
  const { prompt } = buildGroundedPrompt('q', CHUNKS);
  assert.ok(prompt.includes('[_excerpt 1 | source: AMM rev 42]'));
  assert.ok(prompt.includes('[_excerpt 2 | source: AMM rev 42]'));
  assert.ok(prompt.indexOf('[_excerpt 1') < prompt.indexOf(CHUNKS[0].content));
  assert.ok(prompt.indexOf(CHUNKS[0].content) < prompt.indexOf('[_excerpt 2'));
});

test('grounding instructions and question are present in system+prompt', () => {
  const { system, prompt } = buildGroundedPrompt('What torque applies?', CHUNKS);
  assert.match(system, /ONLY from the numbered document excerpts/);
  assert.match(system, /no relevant document content/);
  assert.match(prompt, /Question: What torque applies\?/);
});

test('no-evidence path states explicitly that no excerpts exist', () => {
  const { prompt } = buildGroundedPrompt('What is the pressure range?', []);
  assert.ok(prompt.includes('Document excerpts: (none available)'));
  assert.ok(!prompt.includes('[_excerpt'));
});

test('rejects empty question or non-array chunks', () => {
  assert.throws(() => buildGroundedPrompt('   ', CHUNKS), TypeError);
  assert.throws(() => buildGroundedPrompt('q', /** @type {any} */ ('not an array')), TypeError);
});
