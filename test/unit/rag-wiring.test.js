'use strict';

/**
 * Unit tests for the edge/rag.js pipeline wiring.
 *
 * Uses in-memory fakes that implement the same interfaces as the real
 * Ollama/Qdrant clients, plus a deny-all fetch, so the full
 * chunk → embed → validate → store → retrieve → prompt → generate loop is
 * exercised with ZERO network. Live-service behavior is covered separately
 * in test/integration/rag.test.js.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createRagPipeline } from '../../edge/rag.js';
import { createOllamaClient, OllamaError } from '../../edge/ollama.js';
import { createQdrantClient, QdrantError } from '../../edge/qdrant.js';

const DOC = [
  'Hydraulic system B operates at a normal pressure range of 2800-3200 PSI.',
  'If pressure exceeds 3200 PSI, the B-system thermal relief valve opens automatically.',
  'Torque the B-nut on the pump inlet line to 45 N·m and safety-wire it.',
  'The inlet filter element has part number 88-42B and must be replaced every 500 hours.',
].join('\n\n');

// Repeated so the document exceeds the 1600-char default chunk size and
// produces several chunks through the real pipeline.
const LONG_DOC = Array.from({ length: 8 }, () => DOC).join('\n\n');

/** Deny-all fetch: any network attempt fails the test immediately. */
const denyAllFetch = /** @type {typeof fetch} */ (
  () => Promise.reject(new Error('network access denied by test'))
);

/** Deterministic fake embedder: normalized word-bucket vectors. */
function makeFakeOllama() {
  /** @type {string[][]} */
  const embedCalls = [];
  /** @type {{system: string, prompt: string}[]} */
  const generateCalls = [];

  /** @param {string} text */
  function embedOne(text) {
    const vec = new Array(32).fill(0);
    for (const word of text.toLowerCase().match(/[a-z0-9·.-]+/g) ?? []) {
      let h = 0;
      for (const ch of word) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      vec[h % 32] += 1;
    }
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    return vec.map((v) => v / (norm || 1));
  }

  return {
    embedCalls,
    generateCalls,
    /** @param {string | string[]} input */
    async embed(input) {
      const inputs = Array.isArray(input) ? input : [input];
      embedCalls.push(inputs);
      return inputs.map(embedOne);
    },
    /** Grounded-model stand-in: answers only from excerpt 1 in the prompt. */
    async generate({ prompt }) {
      generateCalls.push({ prompt });
      const start = prompt.indexOf('[_excerpt 1');
      const body = start === -1 ? '(no excerpts)' : prompt.slice(prompt.indexOf('\n', start) + 1);
      const firstLine = body.split('\n')[0];
      return `Grounded answer using: ${firstLine.slice(0, 80)}`;
    },
  };
}

/** In-memory Qdrant stand-in with real cosine ranking. */
function makeFakeQdrant() {
  /** @type {Map<string, { vector: number[], payload: Record<string, unknown> }>} */
  const points = new Map();
  /** @type {string[]} */
  const calls = [];
  return {
    calls,
    size: () => points.size,
    has: (id) => points.has(id),
    async ensureCollection(vectorSize) {
      calls.push(`ensureCollection:${vectorSize}`);
    },
    /** @param {{ id: string, vector: number[], payload: Record<string, unknown> }[]} pts */
    async upsertPoints(pts) {
      calls.push(`upsert:${pts.length}`);
      for (const p of pts) points.set(p.id, { vector: p.vector, payload: p.payload });
    },
    /**
     * @param {number[]} vector
     * @param {{ limit?: number }} [opts]
     */
    async search(vector, { limit = 4 } = {}) {
      calls.push(`search:${limit}`);
      const scored = [...points.values()].map((p) => {
        const dot = p.vector.reduce((s, v, i) => s + v * vector[i], 0);
        const nv = Math.sqrt(p.vector.reduce((s, v) => s + v * v, 0));
        return { id: String(p.payload.id), score: dot / (nv || 1), payload: p.payload };
      });
      return scored.sort((a, b) => b.score - a.score).slice(0, limit);
    },
    async deleteByDocument(documentId) {
      calls.push(`deleteByDocument:${documentId}`);
      for (const [id, p] of [...points]) {
        if (p.payload.document_id === documentId) points.delete(id);
      }
    },
  };
}

const CONFIG = Object.freeze({
  OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
  EMBEDDING_MODEL: 'nomic-embed-text',
  OLLAMA_MODEL: 'llama3.1:8b',
  QDRANT_EDGE_URL: 'http://localhost:6333',
  QDRANT_EDGE_COLLECTION: 'aeroedge_edge_docs',
  QDRANT_CLOUD_URL: 'http://localhost:6334',
});

test('ingest then answer: grounded answer references document-only content', async () => {
  const ollama = makeFakeOllama();
  const qdrant = makeFakeQdrant();
  const pipeline = createRagPipeline({ config: CONFIG, ollama, qdrant });

  const ingest = await pipeline.ingestDocument({
    documentId: 'doc-amm-29',
    text: DOC,
    assetId: 'aircraft-737-MSN4453',
    component: 'hydraulics',
    source: 'AMM rev 42 (test fixture)',
  });
  assert.ok(ingest.chunkCount >= 1);
  assert.equal(qdrant.size(), ingest.chunkCount);

  const result = await pipeline.answerQuestion('What pressure range does hydraulic system B operate at?');

  // Both ingestion chunks and the query went through the SAME embed path/model.
  const allEmbedded = ollama.embedCalls.flat();
  assert.ok(allEmbedded.some((t) => t.includes('2800-3200 PSI')), 'ingestion chunks were embedded');
  assert.ok(
    allEmbedded.includes('What pressure range does hydraulic system B operate at?'),
    'the query itself was embedded through the same path'
  );

  // Exactly one generation call, and the prompt contains retrieved document content verbatim.
  assert.equal(ollama.generateCalls.length, 1);
  assert.ok(
    ollama.generateCalls[0].prompt.includes('2800-3200 PSI'),
    'prompt sent to Ollama contains retrieved document content verbatim'
  );

  // The answer references content that only exists in the ingested document.
  const docOnlyMarkers = ['2800-3200 PSI', '3200 PSI', '45 N·m', '88-42B'];
  assert.ok(
    docOnlyMarkers.some((m) => result.answer.includes(m)),
    `answer should reference document-only content, got: ${result.answer}`
  );
});

test('multi-chunk document: retrieval returns scored chunks and prompt carries the top hit verbatim', async () => {
  const ollama = makeFakeOllama();
  const qdrant = makeFakeQdrant();
  const pipeline = createRagPipeline({ config: CONFIG, ollama, qdrant });

  const ingest = await pipeline.ingestDocument({
    documentId: 'doc-amm-29-long',
    text: LONG_DOC,
    assetId: 'a1',
    component: 'hydraulics',
    source: 'AMM rev 42 (long fixture)',
  });
  assert.ok(ingest.chunkCount >= 2, 'long document produces several chunks');
  assert.equal(qdrant.size(), ingest.chunkCount);

  const result = await pipeline.answerQuestion('What is the normal pressure range of hydraulic system B?');
  assert.ok(result.chunks.length >= 1 && result.chunks.length <= 4);
  // Scores sorted descending; the top chunk's content is what the prompt shows first.
  for (let i = 1; i < result.chunks.length; i++) {
    assert.ok(result.chunks[i - 1].score >= result.chunks[i].score);
  }
  assert.ok(
    ollama.generateCalls[0].prompt.includes(result.chunks[0].content),
    'top retrieved chunk appears verbatim in the prompt'
  );
});

test('re-ingesting the same document replaces its chunks (idempotent)', async () => {
  const ollama = makeFakeOllama();
  const qdrant = makeFakeQdrant();
  const pipeline = createRagPipeline({ config: CONFIG, ollama, qdrant });

  const first = await pipeline.ingestDocument({
    documentId: 'doc-amm-29', text: DOC, assetId: 'a1', component: 'hydraulics', source: 'AMM rev 42',
  });
  const again = await pipeline.ingestDocument({
    documentId: 'doc-amm-29', text: DOC + ' Updated: filter interval is now 750 hours.', assetId: 'a1', component: 'hydraulics', source: 'AMM rev 43',
  });

  assert.equal(qdrant.size(), again.chunkCount, 'old chunks were replaced, not duplicated');
  for (const id of first.chunkIds) {
    assert.equal(qdrant.has(id), false, 'stale chunk id should be gone after re-ingest');
  }
  assert.ok(qdrant.calls.some((c) => c.startsWith('deleteByDocument:doc-amm-29')));
  assert.ok(qdrant.calls.some((c) => c.startsWith('ensureCollection:')));
});

test('the Phase 0 contract gate blocks invalid records before any Qdrant call', async () => {
  const ollama = makeFakeOllama();
  const qdrant = makeFakeQdrant();
  const pipeline = createRagPipeline({ config: CONFIG, ollama, qdrant });

  // Empty `version` passes input checks but fails validateDocumentChunk.
  await assert.rejects(
    pipeline.ingestDocument({
      documentId: 'doc-x', text: DOC, assetId: 'a1', component: 'hydraulics', source: 's', version: '  ',
    }),
    (err) => {
      assert.match(err.message, /DocumentChunk failed validation/);
      assert.match(err.message, /"version"/);
      return true;
    }
  );
  assert.equal(qdrant.calls.length, 0, 'nothing was sent to Qdrant');
});

test('input validation: empty fields and blank queries are rejected without any client calls', async () => {
  const ollama = makeFakeOllama();
  const qdrant = makeFakeQdrant();
  const pipeline = createRagPipeline({ config: CONFIG, ollama, qdrant });

  await assert.rejects(
    pipeline.ingestDocument({ documentId: ' ', text: DOC, assetId: 'a', component: 'c', source: 's' }),
    /"documentId"/
  );
  await assert.rejects(
    pipeline.ingestDocument({ documentId: 'd', text: '   ', assetId: 'a', component: 'c', source: 's' }),
    /"text"/
  );
  await assert.rejects(pipeline.answerQuestion('   '), /non-empty query/);
  assert.equal(ollama.embedCalls.length, 0);
  assert.equal(qdrant.calls.length, 0);
});

// --- Real clients against a deny-all fetch: error paths, no silent fallbacks ---

test('Ollama client surfaces a wrapped connection error (no retry magic)', async () => {
  const client = createOllamaClient({
    baseUrl: 'http://127.0.0.1:11434',
    embedModel: 'nomic-embed-text',
    generateModel: 'llama3.1:8b',
    fetchImpl: denyAllFetch,
  });
  await assert.rejects(client.embed('hello'), (err) => {
    assert.ok(err instanceof OllamaError);
    assert.match(err.message, /Cannot reach Ollama/);
    return true;
  });
  await assert.rejects(client.generate({ prompt: 'hi' }), OllamaError);
});

test('Qdrant client surfaces a wrapped connection error', async () => {
  const client = createQdrantClient({
    baseUrl: 'http://localhost:6333',
    collection: 'aeroedge_edge_docs',
    fetchImpl: denyAllFetch,
  });
  await assert.rejects(client.search([1, 2, 3]), (err) => {
    assert.ok(err instanceof QdrantError);
    assert.match(err.message, /Cannot reach Qdrant/);
    return true;
  });
});

test('pipeline with unreachable services fails loudly on both paths (no fallback answers)', async () => {
  const pipeline = createRagPipeline({
    config: CONFIG,
    ollama: createOllamaClient({
      baseUrl: CONFIG.OLLAMA_BASE_URL,
      embedModel: CONFIG.EMBEDDING_MODEL,
      generateModel: CONFIG.OLLAMA_MODEL,
      fetchImpl: denyAllFetch,
    }),
    qdrant: createQdrantClient({
      baseUrl: CONFIG.QDRANT_EDGE_URL,
      collection: CONFIG.QDRANT_EDGE_COLLECTION,
      fetchImpl: denyAllFetch,
    }),
  });
  await assert.rejects(
    pipeline.ingestDocument({ documentId: 'd', text: DOC, assetId: 'a', component: 'c', source: 's' }),
    (err) => err instanceof OllamaError && /Cannot reach Ollama/.test(err.message)
  );
  await assert.rejects(pipeline.answerQuestion('q'), OllamaError);
});
