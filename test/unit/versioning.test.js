'use strict';

/**
 * Unit tests for Phase 9: version classification (shared/versioning.js) and
 * reconciliation (edge/reconciliation.js).
 *
 * The classifier must return EXACTLY one of four cases per fixture pair —
 * CLOUD_NEWER, EDGE_NEW, DIVERGED, IDENTICAL — with no defaulting to
 * last-write-wins. The reconciler must adopt cloud-newer content, upload
 * edge-new observations, WITHHOLD + RECORD diverged items (never overwrite
 * either side), and dedupe identical ones.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyVersions, VERSION_CASES } from '../../shared/versioning.js';
import {
  createReconciler,
} from '../../edge/reconciliation.js';
import { createSyncEngine, createInMemoryLedger, fingerprintMemory } from '../../edge/syncEngine.js';
import { createMemoryStore } from '../../edge/memoryStore.js';
import { makeFakeQdrant } from '../helpers/fakes.js';

const CONFIG = Object.freeze({
  OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
  EMBEDDING_MODEL: 'nomic-embed-text',
  OLLAMA_MODEL: 'llama3.1:8b',
  QDRANT_EDGE_URL: 'http://localhost:6333',
  QDRANT_CLOUD_URL: 'http://localhost:6334',
  QDRANT_EDGE_COLLECTION: 'aeroedge_edge_docs',
  QDRANT_EDGE_MEMORY_COLLECTION: 'aeroedge_edge_memories',
  QDRANT_CLOUD_COLLECTION: 'aeroedge_cloud_docs',
  QDRANT_CLOUD_MEMORY_COLLECTION: 'aeroedge_cloud_memories',
  QDRANT_CLOUD_SYNC_COLLECTION: 'aeroedge_cloud_sync_events',
  QDRANT_CLOUD_CONFLICT_COLLECTION: 'aeroedge_cloud_conflicts',
});

let seq = 0;
/** A valid Memory with defaults. */
function memory(patch = {}) {
  seq += 1;
  const now = '2026-09-29T10:00:00.000Z';
  return {
    memory_id: patch.memory_id ?? `mem-ver-${String(seq).padStart(3, '0')}`,
    memory_type: patch.memory_type ?? 'field_observation',
    content: patch.content ?? 'Pump 2B whines above 3000 PSI.',
    asset_id: patch.asset_id ?? 'MSN4453',
    source: patch.source ?? 'technician-jane',
    version: patch.version ?? '1',
    importance: patch.importance ?? 0.8,
    confidence: patch.confidence ?? 0.5,
    created_at: now,
    updated_at: patch.updated_at ?? now,
    sync_status: patch.sync_status ?? 'local',
    lifecycle_status: patch.lifecycle_status ?? 'sync_pending',
    jev_status: patch.jev_status ?? 'accept_local',
    ...(patch.revision_of !== undefined ? { revision_of: patch.revision_of } : {}),
  };
}

// ---------------------------------------------------------------------------
// Classifier: exactly the four cases, fixture by fixture
// ---------------------------------------------------------------------------

test('classifier: cloud changed, edge did not → CLOUD_NEWER (case 1)', () => {
  const out = classifyVersions({ edgeFingerprint: 'BASE', cloudFingerprint: 'CLOUDV2', baseFingerprint: 'BASE' });
  assert.equal(out.kase, 'CLOUD_NEWER');
  assert.match(out.reason, /cloud changed/);
});

test('classifier: edge changed (or new), cloud did not → EDGE_NEW (case 2)', () => {
  const changed = classifyVersions({ edgeFingerprint: 'EDGEV2', cloudFingerprint: 'BASE', baseFingerprint: 'BASE' });
  assert.equal(changed.kase, 'EDGE_NEW');
  assert.match(changed.reason, /edge changed/);

  const brandNew = classifyVersions({ edgeFingerprint: 'NEW', cloudFingerprint: '', baseFingerprint: '' });
  assert.equal(brandNew.kase, 'EDGE_NEW', 'never-synced edge knowledge is edge-new');
  assert.match(brandNew.reason, /only live version/);
});

test('classifier: both changed since the ancestor → DIVERGED (case 3, never last-write-wins)', () => {
  const out = classifyVersions({ edgeFingerprint: 'EDGEV4', cloudFingerprint: 'CLOUDV5', baseFingerprint: 'BASE' });
  assert.equal(out.kase, 'DIVERGED');
  assert.match(out.reason, /both/);
});

test('classifier: same info on both sides → IDENTICAL (case 4, deduplicate)', () => {
  const out = classifyVersions({ edgeFingerprint: 'SAME', cloudFingerprint: 'SAME', baseFingerprint: 'SAME' });
  assert.equal(out.kase, 'IDENTICAL');

  // Identical WITHOUT any ancestor is still dedupe (same content is same).
  const ancestorless = classifyVersions({ edgeFingerprint: 'SAME', cloudFingerprint: 'SAME', baseFingerprint: '' });
  assert.equal(ancestorless.kase, 'IDENTICAL');
});

test('classifier: unreachable/garbage states classify honestly, never by winner-picking', () => {
  // Both sides exist, differ, no ancestor: honest divergence, not a guess.
  const noAncestor = classifyVersions({ edgeFingerprint: 'A', cloudFingerprint: 'B', baseFingerprint: '' });
  assert.equal(noAncestor.kase, 'DIVERGED');
  assert.match(noAncestor.reason, /no common ancestor/);

  // Nothing anywhere: deterministic no-op, not a throw.
  const nothing = classifyVersions({ edgeFingerprint: '', cloudFingerprint: '', baseFingerprint: '' });
  assert.equal(nothing.kase, 'IDENTICAL');

  // Cloud-only-known (never synced here): adoptable.
  const cloudOnly = classifyVersions({ edgeFingerprint: '', cloudFingerprint: 'CLOUD', baseFingerprint: '' });
  assert.equal(cloudOnly.kase, 'CLOUD_NEWER');

  // Non-string input rejected loudly.
  assert.throws(() => classifyVersions(/** @type {any} */ ({ edgeFingerprint: null, cloudFingerprint: '', baseFingerprint: '' })), TypeError);
});

test('classifier: VERSION_CASES is exactly the four cases', () => {
  assert.deepEqual([...VERSION_CASES], ['CLOUD_NEWER', 'EDGE_NEW', 'DIVERGED', 'IDENTICAL']);
});

// ---------------------------------------------------------------------------
// Reconciler: end-to-end case handling on fakes
// ---------------------------------------------------------------------------

function makeWorld() {
  const edgeMemories = makeFakeQdrant({ collection: 'aeroedge_edge_memories' });
  const cloudMemories = makeFakeQdrant({ collection: 'aeroedge_cloud_memories' });
  const cloudConflicts = makeFakeQdrant({ collection: 'aeroedge_cloud_conflicts' });
  const store = createMemoryStore({ config: CONFIG, qdrant: edgeMemories });
  const ledger = createInMemoryLedger();
  const engine = createSyncEngine({ memoryStore: store, ledger, deviceId: 'device-01' });
  const reconciler = createReconciler({ memoryStore: store, ledger, cloudMemories, cloudConflicts });
  return { edgeMemories, cloudMemories, cloudConflicts, store, ledger, engine, reconciler };
}

/** Put a copy into the cloud memory store the way Phase 8 ingest does. */
async function putCloudCopy(cloudMemories, m) {
  await cloudMemories.upsertPoints([{ id: m.memory_id, vector: [1], payload: { ...m } }]);
}

test('reconciler: Manual M-204 fixture — edge v4 vs cloud v5 → open Conflict, neither side overwritten', async () => {
  const { cloudMemories, cloudConflicts, store, ledger, reconciler } = makeWorld();

  // The common ancestor: manual M-204 v3 content, synced to both sides.
  const ancestor = memory({
    memory_id: 'mem-m204',
    content: 'Manual M-204: pump overhaul interval 2000 h.',
    version: '3',
    source: 'M-204 rev 3',
  });
  await store.putMemory(ancestor);
  await putCloudCopy(cloudMemories, ancestor);
  await ledger.recordSynced('mem-m204', fingerprintMemory(ancestor));

  // The edge edited to v4; the cloud was edited to v5 (different content).
  const edgeV4 = memory({
    memory_id: 'mem-m204',
    content: 'Manual M-204: pump overhaul interval 2500 h (field-confirmed).',
    version: '4',
    updated_at: '2026-09-29T12:00:00.000Z',
    lifecycle_status: 'used',
  });
  await store.putMemory(edgeV4);
  const cloudV5 = memory({
    memory_id: 'mem-m204',
    content: 'Manual M-204: pump overhaul interval 2200 h (engineering update).',
    version: '5',
    updated_at: '2026-09-29T12:30:00.000Z',
    sync_status: 'synced',
    lifecycle_status: 'synced',
  });
  await putCloudCopy(cloudMemories, cloudV5);

  // The Phase 8 delta proposes to upload the edge v4.
  const pkg = {
    format: 'aeroedge-sync-delta-v1',
    deviceId: 'device-01',
    builtAt: '2026-09-29T13:00:00.000Z',
    items: [
      {
        operation: 'update',
        memoryId: 'mem-m204',
        memory: edgeV4,
        fingerprint: fingerprintMemory(edgeV4),
        edgeJevVerdict: 'accept_local',
        highVisibility: false,
        riskFlags: [],
      },
    ],
    scanned: 1,
    changed: 1,
  };

  const cloudBefore = await cloudMemories.scrollWithFilter(
    { must: [{ key: 'memory_id', match: { value: 'mem-m204' } }] }, { limit: 5 }
  );
  const result = await reconciler.reconcileDelta(pkg, async () => {
    throw new Error('the upload must be WITHHELD for a diverged item');
  });

  assert.equal(result.conflicts, 1, 'divergence DETECTED');
  assert.equal(result.uploaded, 0, 'nothing uploaded — no silent overwrite of cloud');
  const edgeAfter = await store.getMemory('mem-m204');
  assert.equal(edgeAfter.content, edgeV4.content, 'edge copy NOT overwritten by cloud v5');
  const cloudAfter = await cloudMemories.scrollWithFilter(
    { must: [{ key: 'memory_id', match: { value: 'mem-m204' } }] }, { limit: 5 }
  );
  assert.equal(cloudAfter[0].payload.content, cloudV5.content, 'cloud copy NOT overwritten by edge v4');
  assert.deepEqual(cloudAfter.map((h) => h.payload.content), cloudBefore.map((h) => h.payload.content));

  // …and an OPEN Conflict record exists (the acceptance criterion).
  const open = await reconciler.listOpenConflicts({ memoryId: 'mem-m204' });
  assert.equal(open.length, 1);
  assert.equal(open[0].status, 'open');
  assert.equal(open[0].memory_id, 'mem-m204');
  assert.equal(open[0].conflict_type, 'version_divergence');
  assert.ok(String(open[0].jev_recommendation.rationale).length > 0, 'JEV recommendation placeholder stated honestly');
  // Contract-clean record in the store.
  assert.equal(cloudConflicts.size(), 1);
});

test('reconciler: cloud-newer adopts the cloud copy edge-side via legal transitions; no upload, no overwrite', async () => {
  const { cloudMemories, store, ledger, reconciler } = makeWorld();
  const ancestor = memory({ memory_id: 'mem-adopt', content: 'Ancestor content.', lifecycle_status: 'synced', sync_status: 'synced' });
  await store.putMemory(ancestor);
  await putCloudCopy(cloudMemories, ancestor);
  await ledger.recordSynced('mem-adopt', fingerprintMemory(ancestor));

  // Cloud moved on; edge did not change.
  const cloudV2 = memory({ memory_id: 'mem-adopt', content: 'Cloud-corrected content.', lifecycle_status: 'synced', sync_status: 'synced', updated_at: '2026-09-29T13:00:00.000Z' });
  await putCloudCopy(cloudMemories, cloudV2);

  const pkg = {
    format: 'aeroedge-sync-delta-v1',
    deviceId: 'device-01',
    builtAt: 'x',
    items: [{ operation: 'update', memoryId: 'mem-adopt', memory: ancestor, fingerprint: fingerprintMemory(ancestor), edgeJevVerdict: 'accept_local', highVisibility: false, riskFlags: [] }],
    scanned: 1,
    changed: 1,
  };
  const result = await reconciler.reconcileDelta(pkg, async () => {
    throw new Error('CLOUD_NEWER must NOT be uploaded back to the cloud');
  });

  assert.equal(result.adopted, 1);
  assert.equal(result.uploaded, 0);
  const edgeAfter = await store.getMemory('mem-adopt');
  assert.equal(edgeAfter.content, 'Cloud-corrected content.', 'edge ADOPTED the cloud copy');
  assert.equal(edgeAfter.lifecycle_status, 'synced', 'legal transition chain applied');
  assert.equal(edgeAfter.sync_status, 'synced');
  assert.ok((await ledger.lastFingerprint('mem-adopt')) === fingerprintMemory(cloudV2), 'ledger acked the ADOPTED fingerprint');
});

test('reconciler: edge-new uploads cleanly and acks; never flagged as conflict', async () => {
  const { cloudMemories, store, ledger, engine, reconciler } = makeWorld();
  const observation = memory({ memory_id: 'mem-fresh', content: 'Brand new field observation.', lifecycle_status: 'sync_pending', jev_status: 'accept_local' });
  await store.putMemory(observation);

  // Build a REAL Phase 8 delta (not a fixture) and reconcile it.
  const pkg = await engine.buildDelta();
  assert.equal(pkg.items.length, 1);
  const uploaded = [];
  const result = await reconciler.reconcileDelta(pkg, async (upload) => {
    uploaded.push(...upload.items);
    return upload.items.map((i) => ({ memoryId: i.memoryId, status: 'applied' }));
  });
  assert.equal(result.conflicts, 0, 'a normal new observation is NOT a conflict');
  assert.equal(result.uploaded, 1);
  assert.equal(uploaded[0].memoryId, 'mem-fresh');
  assert.ok((await ledger.lastFingerprint('mem-fresh')) === fingerprintMemory(observation), 'acked after applied upload');
});

test('reconciler: identical content dedupes with an ack (no upload, no conflict)', async () => {
  const { cloudMemories, store, ledger, reconciler } = makeWorld();
  const same = memory({ memory_id: 'mem-same', content: 'Identical everywhere.', lifecycle_status: 'synced', sync_status: 'synced' });
  await store.putMemory(same);
  await putCloudCopy(cloudMemories, same);
  await ledger.recordSynced('mem-same', fingerprintMemory(same));

  const pkg = {
    format: 'aeroedge-sync-delta-v1',
    deviceId: 'd',
    builtAt: 'x',
    items: [{ operation: 'update', memoryId: 'mem-same', memory: same, fingerprint: fingerprintMemory(same), edgeJevVerdict: 'accept_local', highVisibility: false, riskFlags: [] }],
    scanned: 1,
    changed: 1,
  };
  const result = await reconciler.reconcileDelta(pkg, async () => {
    throw new Error('IDENTICAL items must not be uploaded');
  });
  assert.equal(result.deduped, 1);
  assert.equal(result.conflicts, 0);
  assert.equal(result.uploaded, 0);
  assert.ok((await ledger.lastFingerprint('mem-same')) === fingerprintMemory(same), 'sync point acked');
});

test('reconciler: a withheld conflict KEEPS re-classifying as DIVERGED on the next round (never vanishes)', async () => {
  const { cloudMemories, store, ledger, reconciler } = makeWorld();
  const ancestor = memory({ memory_id: 'mem-persist', content: 'Original.', lifecycle_status: 'synced', sync_status: 'synced' });
  await store.putMemory(ancestor);
  await putCloudCopy(cloudMemories, ancestor);
  await ledger.recordSynced('mem-persist', fingerprintMemory(ancestor));

  const edgeEdit = memory({ memory_id: 'mem-persist', content: 'Edge edit.', lifecycle_status: 'used' });
  await store.putMemory(edgeEdit);
  const cloudEdit = memory({ memory_id: 'mem-persist', content: 'Cloud edit.', lifecycle_status: 'synced', sync_status: 'synced' });
  await putCloudCopy(cloudMemories, cloudEdit);

  const makePkg = () => ({
    format: 'aeroedge-sync-delta-v1',
    deviceId: 'd',
    builtAt: 'x',
    items: [{ operation: 'update', memoryId: 'mem-persist', memory: edgeEdit, fingerprint: fingerprintMemory(edgeEdit), edgeJevVerdict: 'accept_local', highVisibility: false, riskFlags: [] }],
    scanned: 1,
    changed: 1,
  });
  const first = await reconciler.reconcileDelta(makePkg(), async () => []);
  assert.equal(first.conflicts, 1);
  const second = await reconciler.reconcileDelta(makePkg(), async () => []);
  assert.equal(second.conflicts, 1, 'still diverged until Phase 10 resolves it');
  const open = await reconciler.listOpenConflicts({ memoryId: 'mem-persist' });
  assert.equal(open.length, 2, 'each round records the still-open conflict');
});

test('reconciler: expire operations pass through to the ingest untouched', async () => {
  const { store, reconciler } = makeWorld();
  const pkg = {
    format: 'aeroedge-sync-delta-v1',
    deviceId: 'd',
    builtAt: 'x',
    items: [{ operation: 'expire', memoryId: 'mem-gone', fingerprint: 'abc', edgeJevVerdict: 'accept_local', highVisibility: false, riskFlags: [] }],
    scanned: 1,
    changed: 1,
  };
  const seen = [];
  const result = await reconciler.reconcileDelta(pkg, async (upload) => {
    seen.push(...upload.items);
    return upload.items.map((i) => ({ memoryId: i.memoryId, status: 'applied' }));
  });
  assert.equal(result.uploaded, 1);
  assert.equal(seen[0].operation, 'expire');
});
