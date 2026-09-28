'use strict';

/**
 * Phase 2 unit tests for edge/retrieval.js: fusion/dedup/rerank logic and
 * the metadata filter builder, exercised against synthetic result sets with
 * deliberate overlaps — no network, no models.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMetadataFilter,
  dedupeResults,
  extractExactTerms,
  fuseResults,
  rerank,
} from '../../edge/retrieval.js';
import { extractCitations } from '../../edge/rag.js';

/** Convenience: make a LegMatch with an explicit 0-based rank. */
function leg(chunkId, payload = {}, rank = 0) {
  return { chunkId, payload, rank, leg: 'semantic' };
}

test('extractExactTerms pulls identifiers from code-style queries', () => {
  assert.deepEqual(extractExactTerms('what does ERR-4212 mean'), ['ERR-4212']);
  assert.deepEqual(extractExactTerms('part number for PN 622-4901-201'), ['622-4901-201']);
  assert.deepEqual(extractExactTerms('error code 88-42B replacement procedure'), ['88-42B']);
});

test('extractExactTerms keeps prose queries clean', () => {
  assert.deepEqual(extractExactTerms('part of the pump'), []);
  assert.deepEqual(extractExactTerms('error of the day'), []);
  assert.deepEqual(extractExactTerms('actuator runs hot during retraction'), []);
  assert.deepEqual(extractExactTerms('error 4212 keeps recurring'), ['4212']);
});

test('fuseResults: overlap merges contributions, unique items survive, no duplicates', () => {
  const semantic = [
    leg('a', { content: 'alpha' }, 0),
    leg('b', { content: 'beta' }, 1),
    leg('c', { content: 'gamma' }, 2),
  ];
  const keyword = [
    leg('b', { content: 'beta' }, 0),
    leg('d', { content: 'delta' }, 1),
  ];
  const fused = fuseResults(semantic, keyword);

  const ids = fused.map((f) => f.chunkId);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate chunkIds in fused output');
  assert.ok(ids.includes('a') && ids.includes('b') && ids.includes('c') && ids.includes('d'));

  const top = fused[0];
  assert.equal(top.chunkId, 'b', 'chunk ranked high on BOTH legs wins fusion');
  assert.ok(top.semanticScore !== undefined && top.keywordScore !== undefined);
});

test('fuseResults: dedup keeps the highest-confidence (best-ranked) version', () => {
  const semantic = [leg('x', { content: 'v1' }, 3)];
  const keyword = [leg('x', { content: 'v1' }, 0)];
  const [fused] = fuseResults(semantic, keyword);
  // Both legs present: keyword rank 0 contributes more than semantic rank 3.
  assert.ok(fused.keywordScore < fused.semanticScore);
});

test('fuseResults is deterministic: same input, same order', () => {
  const semantic = [leg('a'), leg('b'), leg('c')];
  const keyword = [leg('c'), leg('a')];
  const once = fuseResults(semantic, keyword);
  const twice = fuseResults(semantic, keyword);
  assert.deepEqual(once.map((f) => f.chunkId), twice.map((f) => f.chunkId));
});

test('dedupeResults collapses repeated chunkIds to one entry per chunk', () => {
  const input = [
    { chunkId: 'z', payload: { version: '1' }, score: 0.9 },
    { chunkId: 'y', payload: { version: '1' }, score: 0.8 },
    { chunkId: 'z', payload: { version: '2' }, score: 0.7 },
  ];
  const out = dedupeResults(input);
  assert.equal(out.length, 2);
  const ids = out.map((r) => r.chunkId);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(out[0].chunkId, 'z', 'keeps the position of the first (highest-confidence) occurrence');
  assert.equal(out[0].score, 0.9, 'highest score wins');
});

test('dedupeResults tie-breaks by newer document version', () => {
  const input = [
    { chunkId: 'v', payload: { version: '1' }, score: 0.9 },
    { chunkId: 'v', payload: { version: '2' }, score: 0.9 },
  ];
  const [kept] = dedupeResults(input);
  assert.equal(kept.payload.version, '2');
});

test('rerank boosts identifier-exact hits above merely-similar ones', () => {
  const exact = {
    chunkId: 'code-hit',
    payload: { content: 'ERR-4212 indicates a quench valve fault on the left actuator.', version: '2' },
    score: 0.30,
    semanticScore: 5,
  };
  const fluent = {
    chunkId: 'fluent-hit',
    payload: { content: 'General actuator troubleshooting overview and torque tables.', version: '1' },
    score: 0.60,
    semanticScore: 0,
  };
  const ranked = rerank([fluent, exact], { exactTerms: ['ERR-4212'] });
  assert.equal(ranked[0].chunkId, 'code-hit', 'exact identifier hit outranks higher-fused generic hit');
});

test('rerank is deterministic under repeated calls', () => {
  const items = [
    { chunkId: 'a', payload: { content: 'x', version: '1' }, score: 0.5, semanticScore: 0 },
    { chunkId: 'b', payload: { content: 'y', version: '2' }, score: 0.5, semanticScore: 1 },
  ];
  const one = rerank(items, { exactTerms: [] });
  const two = rerank(items, { exactTerms: [] });
  assert.deepEqual(one.map((r) => r.chunkId), two.map((r) => r.chunkId));
});

test('buildMetadataFilter maps retrieval filters onto Qdrant must-clauses', () => {
  const f = buildMetadataFilter({
    assetId: 'aircraft-737-MSN4453',
    equipmentModel: 'SkyRay MK-IV',
    component: 'hydraulics',
    docType: 'amm',
    docVersion: '2',
    applicableTo: ['fleet-a', 'fleet-b'],
  });
  assert.deepEqual(f, {
    must: [
      { key: 'asset_id', match: { value: 'aircraft-737-MSN4453' } },
      { key: 'equipment_model', match: { value: 'SkyRay MK-IV' } },
      { key: 'component', match: { value: 'hydraulics' } },
      { key: 'doc_type', match: { value: 'amm' } },
      { key: 'version', match: { value: '2' } },
      { key: 'applicability', match: { any: ['fleet-a', 'fleet-b'] } },
    ],
  });
});

test('buildMetadataFilter returns undefined for no filters and rejects unknown fields', () => {
  assert.equal(buildMetadataFilter(undefined), undefined);
  assert.equal(buildMetadataFilter({}), undefined);
  assert.throws(() => buildMetadataFilter(/** @type {any} */ ({ hai: 1 })), /unknown filter field/);
});

test('extractCitations: one entry per document, chunkIds collected, sources named', () => {
  const citations = extractCitations({
    query: 'q',
    appliedFilters: {},
    exactTerms: [],
    chunks: [
      { chunkId: 'c1', documentId: 'doc-A', source: 'AMM rev 42', content: '...', score: 0.9, version: '1' },
      { chunkId: 'c2', documentId: 'doc-A', source: 'AMM rev 42', content: '...', score: 0.7, version: '1' },
      { chunkId: 'c3', documentId: 'doc-B', source: 'SB 29-11', content: '...', score: 0.6, version: '3' },
    ],
  });
  assert.equal(citations.length, 2);
  assert.deepEqual(citations[0], {
    documentId: 'doc-A',
    source: 'AMM rev 42',
    version: '1',
    chunkIds: ['c1', 'c2'],
  });
  assert.equal(citations[1].source, 'SB 29-11');
});

test('extractCitations: chunks without a document id still produce a per-chunk citation', () => {
  const citations = extractCitations({
    query: 'q',
    appliedFilters: {},
    exactTerms: [],
    chunks: [{ chunkId: 'solo', documentId: '', source: 'unknown', content: '...', score: 0.5 }],
  });
  assert.equal(citations.length, 1);
  assert.equal(citations[0].documentId, '');
  assert.deepEqual(citations[0].chunkIds, ['solo']);
});

test('extractCitations rejects malformed evidence packs', () => {
  assert.throws(() => extractCitations(/** @type {any} */ (null)), TypeError);
  assert.throws(() => extractCitations(/** @type {any} */ ({})), TypeError);
});
