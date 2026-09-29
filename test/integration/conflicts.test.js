'use strict';

/**
 * LIVE integration test for Phase 9: simulate an edge/cloud version
 * conflict — "Manual M-204: edge v4 / cloud v5" — against real Qdrant
 * instances, and confirm it is detected and recorded as an OPEN Conflict,
 * never silently overwritten in either direction.
 *
 * Skips cleanly when Qdrant endpoints are unreachable (see the header of
 * test/integration/rag.test.js for setup).
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

const TRACKER = { memoryId: '', conflictIds: [] };

test('conflicts live: Manual M-204 edge v4 vs cloud v5 is detected and recorded open — never overwritten', async (t) => {
  if (SKIP) {
    t.skip(SKIP_REASON);
    return;
  }
  const { createMemoryStore } = await import('../../edge/memoryStore.js');
  const { createSyncEngine, createInMemoryLedger, fingerprintMemory } = await import('../../edge/syncEngine.js');
  const { createReconciler } = await import('../../edge/reconciliation.js');
  const { createQdrantClient } = await import('../../edge/qdrant.js');

  const store = createMemoryStore({ config: loaded.config });
  const cloudMemoriesClient = createQdrantClient({
    baseUrl: loaded.config.QDRANT_CLOUD_URL,
    collection: loaded.config.QDRANT_CLOUD_MEMORY_COLLECTION,
  });
  const cloudConflictsClient = createQdrantClient({
    baseUrl: loaded.config.QDRANT_CLOUD_URL,
    collection: loaded.config.QDRANT_CLOUD_CONFLICT_COLLECTION,
  });
  const ledger = createInMemoryLedger();
  const engine = createSyncEngine({ memoryStore: store, ledger, deviceId: 'integration-edge' });
  const reconciler = createReconciler({ memoryStore: store, ledger, cloudMemories: cloudMemoriesClient, cloudConflicts: cloudConflictsClient });

  try {
    // The common ancestor: M-204 v3 synced to both sides.
    const ancestor = {
      memory_id: 'mem-m204-live',
      memory_type: 'manual',
      content: 'Manual M-204: pump overhaul interval 2000 h.',
      asset_id: 'FLEET-STANDARD',
      source: 'M-204 rev 3',
      version: '3',
      importance: 0.9,
      confidence: 1,
      created_at: '2026-09-29T10:00:00.000Z',
      updated_at: '2026-09-29T10:00:00.000Z',
      sync_status: 'synced',
      lifecycle_status: 'synced',
      jev_status: 'not_applicable',
    };
    await store.putMemory(ancestor);
    await cloudMemoriesClient.upsertPoints([{ id: ancestor.memory_id, vector: [1], payload: { ...ancestor } }]);
    await trueLedger.recordSynced(ancestor.memory_id, fingerprintMemory(ancestor));

    // Edge edits to v4 (field-confirmed); cloud is edited to v5 (engineering).
    const edgeV4 = {
      ...ancestor,
      content: 'Manual M-204: pump overhaul interval 2500 h (field-confirmed).',
      version: '4',
      updated_at: '2026-09-29T12:00:00.000Z',
    };
    await store.putMemory(edgeV4);
    TRACKER.memoryId = edgeV4.memory_id;
    const cloudV5 = {
      ...ancestor,
      content: 'Manual M-204: pump overhaul interval 2200 h (engineering update).',
      version: '5',
      updated_at: '2026-09-29T12:30:00.000Z',
    };
    await cloudMemoriesClient.upsertPoints([{ id: cloudV5.memory_id, vector: [1], payload: { ...cloudV5 } }]);

    // The Phase 8 delta proposes uploading edge v4.
    const pkg = await engine.buildDelta();
    assert.equal(pkg.items.length, 1, 'the edited manual shows up as a change');

    // The cloud ingest WOULD apply it — the reconciler must withhold instead.
    const { createCloudSyncIngest } = await import('../../cloud/sync.js');
    const cloud = createCloudSyncIngest({ config: loaded.config });
    const result = await reconciler.reconcileDelta(pkg, (upload) => cloud.ingestDelta(upload));

    // DETECTED: divergence classified, conflict recorded, nothing uploaded.
    assert.equal(result.conflicts, 1);
    assert.equal(result.uploaded, 0, 'edge v4 NOT uploaded — cloud not overwritten');
    TRACKER.conflictIds = result.conflictIds;

    const edgeAfter = await store.getMemory('mem-m204-live');
    assert.equal(edgeAfter.version, '4', 'edge keeps its v4 (not overwritten by cloud v5)');
    const cloudHits = await cloudMemoriesClient.scrollWithFilter(
      { must: [{ key: 'memory_id', match: { value: 'mem-m204-live' } }] },
      { limit: 5 }
    );
    assert.equal(cloudHits.length, 1);
    assert.equal(cloudHits[0].payload.version, '5', 'cloud keeps its v5 (not overwritten by edge v4)');

    // RECORDED: an OPEN Conflict, contract-clean, referencing both versions.
    const open = await reconciler.listOpenConflicts({ memoryId: 'mem-m204-live' });
    assert.equal(open.length, 1);
    assert.equal(open[0].status, 'open');
    assert.equal(open[0].conflict_type, 'version_divergence');
    assert.notEqual(open[0].edge_version, open[0].cloud_version, 'both versions cited in the record');
    assert.equal(open[0].memory_id, 'mem-m204-live');
  } finally {
    await store.deleteMemory(TRACKER.memoryId);
    if (TRACKER.memoryId) await cloudMemoriesClient.deleteByIds([TRACKER.memoryId]);
    if (TRACKER.conflictIds.length > 0) await cloudConflictsClient.deleteByIds(TRACKER.conflictIds);
  }
});
