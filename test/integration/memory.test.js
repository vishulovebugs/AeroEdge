'use strict';

/**
 * Live integration test for Phase 4 (real Ollama embeddings not required —
 * this phase stores payload-only memories — but real Qdrant Edge is).
 *
 * Setup: start Qdrant Edge and copy .env.example to .env (see the header of
 * test/integration/rag.test.js). If services are not reachable, tests SKIP
 * with a clear message so CI and offline dev machines stay green.
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
const qdrantUp = loaded.config ? await isUp(`${loaded.config.QDRANT_EDGE_URL}/collections`) : false;
const SKIP = Boolean(loaded.error) || !qdrantUp;
const SKIP_REASON = loaded.error
  ? `${loaded.error.message} — see the header of test/integration/rag.test.js for setup instructions.`
  : 'Qdrant Edge not reachable — start it locally to run this test. ' +
    'See the header of test/integration/rag.test.js for setup instructions.';

const DOC_ID = 'test-doc-memory-separation';

test('memory orchestrator: offline observation stored separately with explicit lifecycle (live Qdrant)', async (t) => {
  if (SKIP) {
    t.skip(SKIP_REASON);
    return;
  }

  const { createRagPipeline } = await import('../../edge/rag.js');
  const { createMemoryStore } = await import('../../edge/memoryStore.js');
  const { createMemoryOrchestrator } = await import('../../edge/orchestrator.js');

  const pipeline = createRagPipeline({ config: loaded.config });
  const memoryStore = createMemoryStore({ config: loaded.config });
  const orchestrator = createMemoryOrchestrator({ config: loaded.config, memoryStore });

  // An authoritative manual document goes into the DOCUMENT pipeline.
  await pipeline.ingestDocument({
    documentId: DOC_ID,
    text: 'Hydraulic system B on aircraft MSN4453 operates at a normal pressure range of 2800-3200 PSI (fictional test fixture).',
    assetId: 'MSN4453',
    component: 'hydraulics',
    source: 'SkyRay fictional manual rev T-42 (test fixture)',
    version: 'T-42',
  });

  // The technician records an observation OFFLINE through the memory pipeline.
  const observation = await orchestrator.captureObservation({
    content: 'B-nut on pump inlet line seeped at 38 N·m; re-torque to 45 N·m cleared it.',
    assetId: 'MSN4453',
    source: 'technician-jane',
    importance: 0.6,
  });

  try {
    // Acceptance criterion 1: stored as a field_observation.
    assert.equal(observation.memory_type, 'field_observation');

    // Acceptance criterion 2: explicit, STORED lifecycle — not inferred.
    assert.equal(observation.lifecycle_status, 'new', 'initial lifecycle stored on the record');
    assert.equal(observation.jev_status, 'pending', 'JEV awareness stored from birth');
    assert.equal(observation.sync_status, 'local');

    // Acceptance criterion 3: architecturally separate from authoritative
    // documents — different collection, retrievable only through the memory
    // store, invisible to document hybrid retrieval.
    const fetched = await memoryStore.getMemory(observation.memory_id);
    assert.equal(fetched.memory_id, observation.memory_id);
    assert.equal(memoryStore.collection, loaded.config.QDRANT_EDGE_MEMORY_COLLECTION);
    assert.notEqual(memoryStore.collection, loaded.config.QDRANT_EDGE_COLLECTION);

    // The manual document and the observation never cross stores: the docs
    // pipeline never produced a Memory, and the memory store holds no
    // document chunk.
    const observations = await memoryStore.listMemories({ memoryType: 'field_observation' });
    assert.ok(observations.some((m) => m.memory_id === observation.memory_id));
    const manuals = await memoryStore.listMemories({ memoryType: 'manual' });
    assert.equal(manuals.length, 0, 'no manual documents leaked into the memory store');

    // Routing with the stub verdict: importance 0.6 < 0.7 → KEEP_LOCAL,
    // stored transitions new → local / pending → accept_local.
    const decision = await orchestrator.routeWithVerdict(observation);
    assert.equal(decision.action, 'KEEP_LOCAL');
    await orchestrator.applyRoute(decision);
    const after = await memoryStore.getMemory(observation.memory_id);
    assert.equal(after.lifecycle_status, 'local', 'routing result is stored, not inferred at read time');
    assert.equal(after.jev_status, 'accept_local', 'stub verdict recorded; still NOT validated');
  } finally {
    await memoryStore.deleteMemory(observation.memory_id);
    const { createQdrantClient } = await import('../../edge/qdrant.js');
    await createQdrantClient({
      baseUrl: loaded.config.QDRANT_EDGE_URL,
      collection: loaded.config.QDRANT_EDGE_COLLECTION,
    }).deleteByDocument(DOC_ID);
  }
});
