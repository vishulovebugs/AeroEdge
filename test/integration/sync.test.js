'use strict';

/**
 * LIVE integration test for Phase 8: create an offline field observation on
 * the edge (real Qdrant Edge memory store), simulate reconnection by
 * running the sync flow against real cloud collections, and confirm the
 * memory appears in Qdrant Cloud with a corresponding SyncEvent.
 *
 * Skips cleanly when Qdrant endpoints are unreachable — see the header of
 * test/integration/rag.test.js for setup (any two Qdrant instances work:
 * point QDRANT_EDGE_URL and QDRANT_CLOUD_URL at them).
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
const edgeUp = loaded.config ? await isUp(`${loaded.config.QDRANT_EDGE_URL}/collections`) : false;
const cloudUp = loaded.config ? await isUp(`${loaded.config.QDRANT_CLOUD_URL}/collections`) : false;
const SKIP = Boolean(loaded.error) || !edgeUp || !cloudUp;
const SKIP_REASON = loaded.error
  ? `${loaded.error.message} — see the header of test/integration/rag.test.js for setup instructions.`
  : `Qdrant Edge or Cloud not reachable (edge: ${edgeUp}, cloud: ${cloudUp}) — start both to run this test. ` +
    'See the header of test/integration/rag.test.js for setup instructions.';

const MEM_ID_TRACKER = { id: '' };

test('sync live: offline observation reaches Qdrant Cloud after reconnection, with a SyncEvent', async (t) => {
  if (SKIP) {
    t.skip(SKIP_REASON);
    return;
  }
  const { createRagPipeline } = await import('../../edge/rag.js');
  const { createMemoryStore } = await import('../../edge/memoryStore.js');
  const { createMemoryOrchestrator, stubVerdictSource } = await import('../../edge/orchestrator.js');
  const { createSyncEngine } = await import('../../edge/syncEngine.js');
  const { createCloudSyncIngest } = await import('../../cloud/sync.js');
  const { createQdrantClient } = await import('../../edge/qdrant.js');

  // The edge world: pipeline + orchestrator with the STUB verdict source so
  // the importance rule drives routing deterministically (the live JEV
  // evaluator's verdicts are nondeterministic and have their own suite).
  const pipeline = createRagPipeline({ config: loaded.config });
  const memoryStore = createMemoryStore({ config: loaded.config });
  const orchestrator = createMemoryOrchestrator({
    config: loaded.config,
    memoryStore,
    verdictSource: stubVerdictSource,
  });
  const syncEngine = createSyncEngine({ memoryStore, deviceId: 'integration-edge-01' });
  const cloud = createCloudSyncIngest({ config: loaded.config });
  const cloudMemoriesClient = createQdrantClient({
    baseUrl: loaded.config.QDRANT_CLOUD_URL,
    collection: loaded.config.QDRANT_CLOUD_MEMORY_COLLECTION,
  });

  // 1. OFFLINE: a technician records an important observation on the device.
  const evidence = await pipeline.retrieveEvidence('hydraulic system B pressure range MSN4453');
  const captured = await orchestrator.captureAndRoute(
    {
      content: 'Hydraulic system B on MSN4453 held 2900-3100 PSI through the full test; inlet B-nut dry at 45 N·m.',
      assetId: 'MSN4453',
      source: 'technician-jane',
      importance: 0.85, // ≥ 0.7: accept_local routes SYNC → sync_pending
      evidence,
    },
  );
  MEM_ID_TRACKER.id = captured.memory.memory_id;
  assert.equal(captured.recorded, true);
  assert.equal(captured.applied?.action, 'SYNC');

  // 2. RECONNECT + SYNC: build the delta from what changed, ingest cloud-side.
  const result = await syncEngine.syncNow((pkg) => cloud.ingestDelta(pkg));
  assert.equal(result.synced, 1, 'the observation rode the delta');
  assert.equal(result.syncedIds[0], captured.memory.memory_id);

  // 3. CLOUD: the memory is THERE, with its Edge JEV verdict attached.
  const cloudHits = await cloudMemoriesClient.scrollWithFilter(
    { must: [{ key: 'memory_id', match: { value: captured.memory.memory_id } }] },
    { limit: 5 }
  );
  assert.equal(cloudHits.length, 1, 'memory present in the CLOUD memory collection');
  assert.equal(cloudHits[0].payload.content, captured.memory.content);
  assert.equal(cloudHits[0].payload.jev_status, 'accept_local', 'edge verdict travels with the memory');
  assert.equal(cloudHits[0].payload.source_device ?? cloudHits[0].payload.source, 'technician-jane');

  // 4. AUDIT: a corresponding SyncEvent exists for this memory.
  const events = await cloud.listSyncEvents({ memoryId: captured.memory.memory_id });
  assert.equal(events.length, 1);
  assert.equal(events[0].operation, 'create');
  assert.equal(events[0].source_device, 'integration-edge-01');

  // 5. EDGE: the memory advanced through the legal chain to synced.
  const stored = await memoryStore.getMemory(captured.memory.memory_id);
  assert.equal(stored.lifecycle_status, 'synced');

  // 6. DELTA semantics: a second sync round transfers nothing new.
  const again = await syncEngine.syncNow((pkg) => cloud.ingestDelta(pkg));
  assert.equal(again.synced, 0);

  // Cleanup (shared dev instances).
  await memoryStore.deleteMemory(captured.memory.memory_id);
  await cloudMemoriesClient.deleteByIds([captured.memory.memory_id]);
  const syncClient = createQdrantClient({
    baseUrl: loaded.config.QDRANT_CLOUD_URL,
    collection: loaded.config.QDRANT_CLOUD_SYNC_COLLECTION,
  });
  const eventHits = await syncClient.scrollWithFilter(
    { must: [{ key: 'memory_id', match: { value: captured.memory.memory_id } }] },
    { limit: 10 }
  );
  if (eventHits.length > 0) await syncClient.deleteByIds(eventHits.map((h) => h.id));
});
