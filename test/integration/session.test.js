'use strict';

/**
 * Live integration test for Phase 3 session-aware answering
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

const DOC_IDS = ['test-doc-session-pressure', 'test-doc-session-sensor'];

/** Build a pipeline against the real local services. */
async function makePipeline() {
  const { createRagPipeline } = await import('../../edge/rag.js');
  return createRagPipeline({ config: loaded.config });
}

async function cleanup() {
  const { createQdrantClient } = await import('../../edge/qdrant.js');
  const qdrant = createQdrantClient({
    baseUrl: loaded.config.QDRANT_EDGE_URL,
    collection: loaded.config.QDRANT_EDGE_COLLECTION,
  });
  for (const id of DOC_IDS) await qdrant.deleteByDocument(id);
}

test('session memory: initial query establishes context, bare follow-up resolves (live)', async (t) => {
  if (SKIP) {
    t.skip(SKIP_REASON);
    return;
  }

  const pipeline = await makePipeline();
  const { createSession } = await import('../../edge/session.js');

  await pipeline.ingestDocument({
    documentId: DOC_IDS[0],
    text: [
      'SkyRay MK-IV hydraulic system B maintenance (fictional test fixture, rev T-42).',
      'Hydraulic system B on aircraft MSN4453 operates at a normal pressure range of 2800-3200 PSI.',
      'If pressure exceeds 3200 PSI, the B-system thermal relief valve opens automatically.',
    ].join('\n\n'),
    assetId: 'MSN4453',
    component: 'hydraulics',
    source: 'SkyRay fictional manual rev T-42 (test fixture)',
    version: 'T-42',
  });
  await pipeline.ingestDocument({
    documentId: DOC_IDS[1],
    text: [
      'SkyRay MK-IV pressure transducer P/N PT-88C (fictional test fixture).',
      'The hydraulic system B pressure sensor (part number PT-88C) reports 4-20 mA; a reading below 4 mA means a failed transducer and requires replacement.',
    ].join('\n\n'),
    assetId: 'MSN4453',
    component: 'hydraulics',
    source: 'SkyRay fictional manual rev T-42 (test fixture)',
    version: 'T-42',
  });

  const session = createSession();
  try {
    // Turn 1: fully specified query — establishes asset + subsystem.
    const first = await pipeline.answerQuestion(
      'Running diagnostics on aircraft MSN4453: what is the normal pressure range of hydraulic system B?',
      { session }
    );
    assert.equal(session.assetId, 'MSN4453', 'turn 1 established the session asset');
    assert.ok(session.component !== null, 'turn 1 established the session subsystem');
    assert.match(first.answer, /2800-3200 PSI/);

    // Turn 2: bare elliptical follow-up — must resolve via session context
    // (query expansion + suggested filters), not fail or ask to repeat.
    const followUp = await pipeline.answerQuestion('what about the pressure sensor?', { session });
    assert.equal(followUp.usedSessionContext, true, 'session summary was injected');
    assert.ok(
      followUp.chunks.some((c) => c.content.includes('PT-88C')),
      'follow-up retrieved the sensor evidence via session context'
    );
    assert.ok(
      followUp.citations.some((c) => c.documentId === DOC_IDS[1]),
      'follow-up answer cites the sensor document'
    );
    assert.match(followUp.answer, /PT-88C|transducer|4-20/i, 'grounded answer resolves the follow-up');
    assert.ok(followUp.prompt.prompt.includes('Diagnostic session context'));
  } finally {
    await cleanup();
  }
});
