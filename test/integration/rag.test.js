'use strict';

/**
 * Live integration test for the Phase 1 RAG pipeline.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * HOW TO RUN AGAINST LOCAL SERVICES
 *
 * 1. Ollama:   `ollama serve`                      (listens on :11434)
 *    Models:   `ollama pull nomic-embed-text`
 *              `ollama pull llama3.1:8b`            (or set OLLAMA_MODEL)
 *
 * 2. Qdrant Edge: `docker run -p 6333:6333 qdrant/qdrant`
 *    (or the binary: `./qdrant`; listens on :6333)
 *
 * 3. Config:   `cp .env.example .env` (defaults match the above).
 *
 * 4. Run only this suite: `npm run test:integration`
 * ─────────────────────────────────────────────────────────────────────────
 *
 * If either service is not reachable, every live test SKIPS with a clear
 * message — CI and offline dev machines stay green.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../shared/config.js';

/** @param {string} url @returns {Promise<boolean>} */
async function isUp(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

// Missing .env is just "services not configured here" — skip, never crash.
function loadConfigOrSkip() {
  try {
    return { config: loadConfig({ envFile: '.env' }), error: null };
  } catch (err) {
    return { config: null, error: /** @type {Error} */ (err) };
  }
}

const loaded = loadConfigOrSkip();
const ollamaUp = loaded.config ? await isUp(`${loaded.config.OLLAMA_BASE_URL}/api/tags`) : false;
const qdrantUp = loaded.config ? await isUp(`${loaded.config.QDRANT_EDGE_URL}/collections`) : false;
const SKIP = Boolean(loaded.error) || !ollamaUp || !qdrantUp;
const SKIP_REASON = loaded.error
  ? `${loaded.error.message} — see the header of test/integration/rag.test.js for setup instructions.`
  : `${[!ollamaUp && 'Ollama', !qdrantUp && 'Qdrant'].filter(Boolean).join(' and ')} not reachable — ` +
    'start it locally to run this test. See the header of test/integration/rag.test.js for setup instructions.';

test('grounded answer comes from the ingested document only (live Ollama + Qdrant Edge)', async (t) => {
  if (SKIP) {
    t.skip(SKIP_REASON);
    return; // t.skip() only marks the test — execution must stop here.
  }

  const { createRagPipeline } = await import('../../edge/rag.js');
  const { createQdrantClient } = await import('../../edge/qdrant.js');
  const pipeline = createRagPipeline({ config: loaded.config });

  // A fake maintenance-manual snippet with facts that appear in no training
  // set: fictional part numbers, fictional lubricant, fictional interval.
  const documentId = 'test-doc-grounding-1';
  const text =
    'SkyRay MK-IV hydraulic actuator maintenance (fictional test fixture, rev T-42). ' +
    'The SkyRay MK-IV actuator (part number ZX-99Q) must be lubricated with ' +
    'fluorogrease grade F-77 every 33 flight cycles, no exceptions. ' +
    'If the actuator temperature exceeds 141 degrees C during retraction, ' +
    'the quench port on the left side must be opened for 8 seconds.';

  const ingest = await pipeline.ingestDocument({
    documentId,
    text,
    assetId: 'test-asset-skyray',
    component: 'hydraulics',
    source: 'SkyRay fictional manual rev T-42 (test fixture)',
  });
  assert.ok(ingest.chunkCount >= 1);

  const result = await pipeline.answerQuestion(
    'How often must the SkyRay MK-IV actuator be lubricated, and with what grease?'
  );

  // Grounding proof: the answer must carry document-only facts. A model
  // hallucinating a plausible answer would not produce "33 flight cycles"
  // and "F-77" unprompted.
  assert.match(result.answer, /33 flight cycles/i);
  assert.match(result.answer, /F-77/i);
  assert.ok(result.chunks.length >= 1);
  assert.ok(result.chunks.some((c) => c.content.includes('ZX-99Q')));

  // Cleanup: remove the test document from the Edge collection.
  await createQdrantClient({
    baseUrl: loaded.config.QDRANT_EDGE_URL,
    collection: loaded.config.QDRANT_EDGE_COLLECTION,
  }).deleteByDocument(documentId);
});

test('ingestion is idempotent against live Qdrant Edge', async (t) => {
  if (SKIP) {
    t.skip(SKIP_REASON);
    return;
  }

  const { createRagPipeline } = await import('../../edge/rag.js');
  const { createQdrantClient } = await import('../../edge/qdrant.js');
  const { createOllamaClient } = await import('../../edge/ollama.js');
  const pipeline = createRagPipeline({ config: loaded.config });
  const qdrant = createQdrantClient({
    baseUrl: loaded.config.QDRANT_EDGE_URL,
    collection: loaded.config.QDRANT_EDGE_COLLECTION,
  });

  const documentId = 'test-doc-idempotent-2';
  const text =
    'The SkyRay MK-IV nav light assembly uses bulb NX-12 rated 24V. ' +
    'Replacement requires removing two screws and disconnecting the PL-44 connector.';
  const first = await pipeline.ingestDocument({
    documentId, text, assetId: 'test-asset-skyray', component: 'electrical',
    source: 'SkyRay fictional manual rev T-42 (test fixture)',
  });
  await pipeline.ingestDocument({
    documentId, text, assetId: 'test-asset-skyray', component: 'electrical',
    source: 'SkyRay fictional manual rev T-42 (test fixture)',
  });

  const ollama = createOllamaClient({
    baseUrl: loaded.config.OLLAMA_BASE_URL,
    embedModel: loaded.config.EMBEDDING_MODEL,
    generateModel: loaded.config.OLLAMA_MODEL,
  });
  const [vector] = await ollama.embed('SkyRay MK-IV nav light bulb');
  const hits = await qdrant.search(vector, { limit: 100 });
  const docPoints = hits.filter((h) => h.payload.document_id === documentId);
  assert.equal(docPoints.length, first.chunkCount, 'exactly one copy of each chunk after re-ingest');

  await qdrant.deleteByDocument(documentId);
});
