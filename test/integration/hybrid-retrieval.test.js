'use strict';

/**
 * Live integration test for the Phase 2 hybrid retrieval pipeline
 * (real Ollama + real Qdrant Edge).
 *
 * Setup is identical to test/integration/rag.test.js — see its header.
 * If either service is not reachable, every live test SKIPS with a clear
 * message so CI and offline dev machines stay green.
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

// One fact base, two query styles: a fictional fault code and a plain
// description of the same fault, plus identifiers that exist ONLY in text.
const DOC_ID = 'test-doc-hybrid-1';
const DOC_TEXT = [
  'SkyRay MK-IV hydraulic system — fault isolation (fictional test fixture, rev T-42).',
  'Fault code ERR-4212 (actuator over-temperature during retraction): open the left-side quench port for 8 seconds and inspect the fitting per service bulletin SB-2911-07.',
  'Part number ZX-99Q is the actuator lubrication fitting; use fluorogrease grade F-77 every 33 flight cycles.',
].join('\n\n');

/** Build a pipeline against the real local services. */
async function makePipeline() {
  const { createRagPipeline } = await import('../../edge/rag.js');
  return createRagPipeline({ config: loaded.config });
}

async function cleanup() {
  const { createQdrantClient } = await import('../../edge/qdrant.js');
  await createQdrantClient({
    baseUrl: loaded.config.QDRANT_EDGE_URL,
    collection: loaded.config.QDRANT_EDGE_COLLECTION,
  }).deleteByDocument(DOC_ID);
}

test('hybrid retrieval: exact error-code query and symptom query hit the same evidence (live)', async (t) => {
  if (SKIP) {
    t.skip(SKIP_REASON);
    return;
  }

  const pipeline = await makePipeline();
  await pipeline.ingestDocument({
    documentId: DOC_ID,
    text: DOC_TEXT,
    assetId: 'test-asset-skyray',
    component: 'hydraulics',
    source: 'SkyRay fictional manual rev T-42 (test fixture)',
    version: 'T-42',
    equipmentModel: 'SkyRay MK-IV',
    docType: 'amm',
    keywords: ['ERR-4212', 'ZX-99Q', 'SB-2911-07'],
    applicability: ['test-asset-skyray'],
  });

  try {
    // 1) Exact error-code query: identifiers matched literally, not fuzzily.
    const byCode = await pipeline.retrieveEvidence('ERR-4212');
    assert.ok(byCode.exactTerms.includes('ERR-4212'));
    assert.ok(
      byCode.chunks.length >= 1 && byCode.chunks.some((c) => c.content.includes('ERR-4212')),
      'exact-code query retrieved the fault-code evidence'
    );

    // 2) Natural-language symptom query for the SAME underlying fact.
    const bySymptom = await pipeline.retrieveEvidence(
      'actuator gets too hot when retracting, what should I do?'
    );
    assert.ok(
      bySymptom.chunks.some((c) => c.content.includes('quench port')),
      'symptom query retrieved the same fault evidence via semantic search'
    );

    // Both styles retrieve the same underlying document.
    assert.ok(byCode.chunks.some((c) => c.documentId === DOC_ID));
    assert.ok(bySymptom.chunks.some((c) => c.documentId === DOC_ID));

    // 3) A grounded answer through the full hybrid pipeline cites its sources.
    const answered = await pipeline.answerQuestion('ERR-4212: what is the immediate action?');
    assert.match(answered.answer, /quench port|8 seconds/i);
    assert.ok(answered.citations.length >= 1);
    assert.ok(
      answered.citations.some((c) => c.documentId === DOC_ID && c.chunkIds.length >= 1),
      'answer cites the ingested document'
    );

    // 4) Metadata filtering: wrong equipment model retrieves nothing.
    const empty = await pipeline.retrieveEvidence('ERR-4212', {
      filters: { equipmentModel: 'SkyRay NONEXISTENT-XV' },
    });
    assert.equal(empty.chunks.length, 0, 'metadata filter is a hard constraint');
  } finally {
    await cleanup();
  }
});
