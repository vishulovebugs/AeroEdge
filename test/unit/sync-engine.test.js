'use strict';

/**
 * Unit tests for Phase 8: the Sync Engine (edge/syncEngine.js + cloud/sync.js).
 *
 * Contracts under test:
 *   - the change detector partitions a fixture set EXACTLY (changed vs
 *     unchanged — no false positives, no false negatives),
 *   - delta eligibility follows the Phase 4/5 Orchestrator verdict table
 *     (flag_risk IN and tagged; needs_more_evidence structurally OUT),
 *   - delta packages are deterministic,
 *   - syncNow acks via legal lifecycle transitions only,
 *   - the cloud ingest applies valid items, persists SyncEvents, rejects
 *     malformed items per-item without crashing the batch.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSyncEngine,
  createInMemoryLedger,
  fingerprintMemory,
  isSyncEligible,
} from '../../edge/syncEngine.js';
import { createCloudSyncIngest } from '../../cloud/sync.js';
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
});

let seq = 0;
/** A valid Memory with defaults, per-test unique id. */
function memory(patch = {}) {
  seq += 1;
  const now = '2026-09-29T10:00:00.000Z';
  return {
    memory_id: patch.memory_id ?? `mem-sync-${String(seq).padStart(3, '0')}`,
    memory_type: patch.memory_type ?? 'field_observation',
    content: patch.content ?? 'Pump 2B whines above 3000 PSI.',
    asset_id: patch.asset_id ?? 'MSN4453',
    source: patch.source ?? 'technician-jane',
    version: patch.version ?? '1',
    importance: patch.importance ?? 0.4,
    confidence: patch.confidence ?? 0.5,
    created_at: now,
    updated_at: now,
    sync_status: patch.sync_status ?? 'local',
    lifecycle_status: patch.lifecycle_status ?? 'new',
    jev_status: patch.jev_status ?? 'pending',
    ...(patch.revision_of !== undefined ? { revision_of: patch.revision_of } : {}),
  };
}

/** A fresh world: memory store backed by a fake + engine + ledger + cloud ingest. */
function makeWorld(memories = []) {
  const memoriesQdrant = makeFakeQdrant({ collection: 'aeroedge_edge_memories' });
  const cloudMemoriesQdrant = makeFakeQdrant({ collection: 'aeroedge_cloud_memories' });
  const cloudSyncQdrant = makeFakeQdrant({ collection: 'aeroedge_cloud_sync_events' });
  const store = createMemoryStore({ config: CONFIG, qdrant: memoriesQdrant });
  const ledger = createInMemoryLedger();
  const engine = createSyncEngine({ memoryStore: store, ledger, deviceId: 'test-device-01' });
  const cloud = createCloudSyncIngest({ config: CONFIG, cloudMemories: cloudMemoriesQdrant, cloudSyncEvents: cloudSyncQdrant });
  return { memoriesQdrant, cloudMemoriesQdrant, cloudSyncQdrant, store, ledger, engine, cloud };
}

// ---------------------------------------------------------------------------
// Fingerprint: content + lineage, never status bookkeeping
// ---------------------------------------------------------------------------

test('fingerprint ignores status/timestamp churn but includes content and lineage', () => {
  const base = memory({ lifecycle_status: 'new', updated_at: '2026-09-29T10:00:00.000Z' });
  const statusChanged = { ...base, lifecycle_status: 'used', jev_status: 'accept_local', updated_at: '2026-09-29T11:00:00.000Z' };
  assert.equal(fingerprintMemory(base), fingerprintMemory(statusChanged), 'status-only changes are NOT changes');

  const contentChanged = { ...base, content: 'Corrected: whine starts at 2800 PSI.' };
  assert.notEqual(fingerprintMemory(base), fingerprintMemory(contentChanged), 'content change IS a change');

  const revision = { ...base, version: '2', revision_of: 'mem-ancestor' };
  assert.notEqual(fingerprintMemory(base), fingerprintMemory(revision), 'revision lineage IS part of the fingerprint');
});

// ---------------------------------------------------------------------------
// Change detector: exact partition of a fixture set
// ---------------------------------------------------------------------------

test('change detector partitions a fixture set exactly (no false positives, no false negatives)', async () => {
  const { store, engine, ledger } = makeWorld();

  // Fixture: two memories synced already, two never synced, one changed since.
  const syncedA = memory({ memory_id: 'mem-fx-a', content: 'Synced content A.', lifecycle_status: 'sync_pending', jev_status: 'accept_local', importance: 0.8 });
  const syncedB = memory({ memory_id: 'mem-fx-b', content: 'Synced content B.', lifecycle_status: 'synced', jev_status: 'accept_local', importance: 0.8 });
  const freshC = memory({ memory_id: 'mem-fx-c', content: 'Brand new observation C.', lifecycle_status: 'sync_pending', jev_status: 'accept_local', importance: 0.9 });
  const changedD = memory({ memory_id: 'mem-fx-d', content: 'Original D.', lifecycle_status: 'sync_pending', jev_status: 'accept_local', importance: 0.9 });
  const unchangedE = memory({ memory_id: 'mem-fx-e', content: 'Used but unchanged E.', lifecycle_status: 'used', jev_status: 'accept_local' });
  for (const m of [syncedA, syncedB, freshC, changedD, unchangedE]) await store.putMemory(m);

  // Sync point: A, B, D (original content), and E are recorded in the ledger.
  await ledger.recordSynced('mem-fx-a', fingerprintMemory(syncedA));
  await ledger.recordSynced('mem-fx-b', fingerprintMemory(syncedB));
  await ledger.recordSynced('mem-fx-d', fingerprintMemory(changedD));
  await ledger.recordSynced('mem-fx-e', fingerprintMemory(unchangedE));

  // D is edited after the sync point.
  const editedD = { ...changedD, content: 'Corrected D: seep starts at 1800 PSI.', version: '2', revision_of: 'mem-parent-d' };
  await store.putMemory(editedD);

  const { changed, scanned } = await engine.detectChanges();
  const ids = changed.map((m) => m.memory_id).sort();

  assert.equal(scanned, 5);
  assert.deepEqual(ids, ['mem-fx-c', 'mem-fx-d'], 'exactly: never-synced C + genuinely-changed D');
  assert.ok(!ids.includes('mem-fx-a'), 'no false positive: synced+unchanged A');
  assert.ok(!ids.includes('mem-fx-b'), 'no false positive: synced B');
  assert.ok(!ids.includes('mem-fx-e'), 'no false positive: used-but-unchanged E');
});

test('second detection after ack yields an EMPTY delta (true delta, not full resync)', async () => {
  const { store, engine, cloud, cloudMemoriesQdrant } = makeWorld();
  await store.putMemory(memory({ memory_id: 'mem-round', lifecycle_status: 'sync_pending', jev_status: 'accept_local', importance: 0.9 }));
  const first = await engine.syncNow((pkg) => cloud.ingestDelta(pkg));
  assert.equal(first.synced, 1);
  const second = await engine.syncNow((pkg) => cloud.ingestDelta(pkg));
  assert.equal(second.synced, 0, 'nothing changed since the sync point');
  assert.equal(cloudMemoriesQdrant.size(), 1, 'cloud still holds exactly one copy');
});

// ---------------------------------------------------------------------------
// Delta eligibility: the Phase 4/5 verdict table, enforced
// ---------------------------------------------------------------------------

test('delta includes ONLY verdict-eligible memories; needs_more_evidence is structurally absent', async () => {
  const { store, engine } = makeWorld();
  await store.putMemory(memory({ memory_id: 'mem-in-sync', lifecycle_status: 'sync_pending', jev_status: 'accept_local', importance: 0.9 }));
  await store.putMemory(memory({ memory_id: 'mem-in-flag', lifecycle_status: 'local', jev_status: 'flag_risk' }));
  await store.putMemory(memory({ memory_id: 'mem-out-nme', lifecycle_status: 'local', jev_status: 'needs_more_evidence', importance: 0.95 }));
  await store.putMemory(memory({ memory_id: 'mem-out-local', lifecycle_status: 'local', jev_status: 'accept_local', importance: 0.4 }));
  await store.putMemory(memory({ memory_id: 'mem-out-pending', lifecycle_status: 'new', jev_status: 'pending' }));
  await store.putMemory(memory({ memory_id: 'mem-out-note', memory_type: 'session_note', lifecycle_status: 'new', jev_status: 'pending' }));
  await store.putMemory(memory({ memory_id: 'mem-out-expired', lifecycle_status: 'expired', jev_status: 'accept_local' }));

  const pkg = await engine.buildDelta();
  const ids = pkg.items.map((i) => i.memoryId);
  assert.deepEqual(ids, ['mem-in-flag', 'mem-in-sync'], 'exactly the two eligible memories, sorted');
  assert.ok(!ids.includes('mem-out-nme'), 'needs_more_evidence MUST NOT appear in the delta at all');
  assert.ok(!ids.includes('mem-out-local'), 'below-threshold accept_local not eligible');
  assert.ok(!ids.includes('mem-out-pending'), 'pending (unevaluated) not eligible');
  assert.ok(!ids.includes('mem-out-note'), 'session notes never sync');
  assert.ok(!ids.includes('mem-out-expired'), 'expired never syncs');

  const flag = pkg.items.find((i) => i.memoryId === 'mem-in-flag');
  assert.equal(flag.highVisibility, true, 'flag_risk tagged high-visibility in the delta');
  assert.equal(flag.operation, 'create');
  const accepted = pkg.items.find((i) => i.memoryId === 'mem-in-sync');
  assert.equal(accepted.highVisibility, false);
});

test('isSyncEligible covers the verdict table edge cases directly', () => {
  assert.equal(isSyncEligible(memory({ lifecycle_status: 'sync_pending', jev_status: 'accept_local' })), true);
  assert.equal(isSyncEligible(memory({ lifecycle_status: 'used', jev_status: 'accept_local' })), true);
  assert.equal(isSyncEligible(memory({ lifecycle_status: 'local', jev_status: 'flag_risk' })), true);
  assert.equal(isSyncEligible(memory({ lifecycle_status: 'local', jev_status: 'needs_more_evidence' })), false);
  assert.equal(isSyncEligible(memory({ lifecycle_status: 'sync_pending', jev_status: 'needs_more_evidence' })), false, 'verdict veto even on drifted lifecycle');
  assert.equal(isSyncEligible(memory({ lifecycle_status: 'local', jev_status: 'accept_local' })), false, 'below-threshold keep-local');
  assert.equal(isSyncEligible(memory({ lifecycle_status: 'new', jev_status: 'pending' })), false);
  assert.equal(isSyncEligible(memory({ memory_type: 'session_note', lifecycle_status: 'used', jev_status: 'accept_local' })), false);
  assert.equal(isSyncEligible(memory({ memory_type: 'manual', lifecycle_status: 'local', jev_status: 'not_applicable' })), false);
});

test('delta packages are deterministic (sorted by memoryId, stable fingerprints)', async () => {
  const { store, engine } = makeWorld();
  for (const id of ['mem-c', 'mem-a', 'mem-b']) {
    await store.putMemory(memory({ memory_id: id, lifecycle_status: 'sync_pending', jev_status: 'accept_local', importance: 0.9 }));
  }
  const one = await engine.buildDelta();
  const two = await engine.buildDelta();
  assert.deepEqual(one.items.map((i) => i.memoryId), ['mem-a', 'mem-b', 'mem-c']);
  assert.deepEqual(one.items, two.items);
});

// ---------------------------------------------------------------------------
// syncNow: cloud ack via legal lifecycle transitions
// ---------------------------------------------------------------------------

test('syncNow: applied items reach synced through the legal chain; the ledger records the sync point', async () => {
  const { store, engine, cloud, ledger } = makeWorld();
  await store.putMemory(memory({ memory_id: 'mem-ack', lifecycle_status: 'sync_pending', jev_status: 'accept_local', importance: 0.9 }));
  await store.putMemory(memory({ memory_id: 'mem-ack-used', lifecycle_status: 'used', jev_status: 'accept_local' }));
  await store.putMemory(memory({ memory_id: 'mem-ack-flag', lifecycle_status: 'local', jev_status: 'flag_risk' }));

  const result = await engine.syncNow((pkg) => cloud.ingestDelta(pkg));
  assert.equal(result.synced, 3);
  assert.equal(result.rejected, 0);

  for (const id of ['mem-ack', 'mem-ack-used', 'mem-ack-flag']) {
    const stored = await store.getMemory(id);
    assert.equal(stored.lifecycle_status, 'synced', `${id} advanced through the legal chain`);
    assert.equal(stored.sync_status, 'synced');
    assert.ok((await ledger.lastFingerprint(id)) !== null, 'ledger acked the sync point');
  }
});

test('syncNow: ingest rejections leave memories untouched (they ride the next delta)', async () => {
  const { store, engine, ledger } = makeWorld();
  await store.putMemory(memory({ memory_id: 'mem-rej', lifecycle_status: 'sync_pending', jev_status: 'accept_local', importance: 0.9 }));
  const result = await engine.syncNow(async () => [{ memoryId: 'mem-rej', status: 'rejected', reason: 'cloud unavailable' }]);
  assert.equal(result.rejected, 1);
  const stored = await store.getMemory('mem-rej');
  assert.equal(stored.lifecycle_status, 'sync_pending', 'untouched on rejection');
  assert.equal(await ledger.lastFingerprint('mem-rej'), null, 'no ledger ack for rejected items');
});

test('syncNow: expire removes the cloud copy of a previously synced memory', async () => {
  const { store, engine, cloud, cloudMemoriesQdrant } = makeWorld();
  await store.putMemory(memory({ memory_id: 'mem-die', lifecycle_status: 'sync_pending', jev_status: 'accept_local', importance: 0.9 }));
  await engine.syncNow((pkg) => cloud.ingestDelta(pkg));
  assert.equal(cloudMemoriesQdrant.size(), 1);

  const result = await engine.syncNow((pkg) => cloud.ingestDelta(pkg), { expireIds: ['mem-die'] });
  assert.equal(result.synced, 1, 'the expire is a synced operation');
  assert.equal(cloudMemoriesQdrant.size(), 0, 'cloud copy deleted');
});

// ---------------------------------------------------------------------------
// Cloud ingest: per-item validation, SyncEvents, batch safety
// ---------------------------------------------------------------------------

test('cloud ingest persists one SyncEvent per applied item (auditable trail)', async () => {
  const { store, engine, cloud, cloudSyncQdrant } = makeWorld();
  await store.putMemory(memory({ memory_id: 'mem-ev', lifecycle_status: 'sync_pending', jev_status: 'accept_local', importance: 0.9 }));
  await engine.syncNow((pkg) => cloud.ingestDelta(pkg));

  const events = await cloud.listSyncEvents({ memoryId: 'mem-ev' });
  assert.equal(events.length, 1);
  assert.equal(events[0].operation, 'create');
  assert.equal(events[0].status, 'applied');
  assert.equal(events[0].source_device, 'test-device-01');
  assert.ok(String(events[0].event_id).startsWith('sev-'));
});

test('cloud ingest rejects malformed items per-item without crashing the batch', async () => {
  const { cloud, cloudMemoriesQdrant } = makeWorld();
  const good = memory({ memory_id: 'mem-good', lifecycle_status: 'sync_pending', jev_status: 'accept_local' });
  const results = await cloud.ingestDelta({
    format: 'aeroedge-sync-delta-v1',
    deviceId: 'test-device-01',
    items: [
      { operation: 'create', memoryId: 'mem-good', memory: good, fingerprint: fingerprintMemory(good) },
      { operation: 'create', memoryId: 'mem-bad', memory: { memory_id: 'mem-bad', content: '' }, fingerprint: 'x' },
      { operation: 'create', memoryId: '', memory: good, fingerprint: 'x' },
      { operation: 'banana', memoryId: 'mem-banana', fingerprint: 'x' },
      { operation: 'update', memoryId: 'mem-good', memory: { ...good, content: 'updated' }, fingerprint: 'y' },
    ],
  });
  assert.equal(results.length, 5);
  assert.equal(results.filter((r) => r.status === 'applied').length, 2, 'valid items applied');
  assert.equal(results.filter((r) => r.status === 'rejected').length, 3, 'malformed items rejected with reasons');
  assert.ok(cloudMemoriesQdrant.size() >= 1);
});

test('cloud ingest updates replace the cloud copy (stable point identity by memory_id)', async () => {
  const { cloud, cloudMemoriesQdrant } = makeWorld();
  const m = memory({ memory_id: 'mem-upd', lifecycle_status: 'synced', jev_status: 'accept_local' });
  await cloud.ingestDelta({ format: 'aeroedge-sync-delta-v1', deviceId: 'd', items: [{ operation: 'create', memoryId: 'mem-upd', memory: m, fingerprint: 'f1' }] });
  await cloud.ingestDelta({ format: 'aeroedge-sync-delta-v1', deviceId: 'd', items: [{ operation: 'update', memoryId: 'mem-upd', memory: { ...m, content: 'revised' }, fingerprint: 'f2' }] });
  assert.equal(cloudMemoriesQdrant.size(), 1, 'update replaces, never duplicates');
});

test('cloud ingest refuses unknown package formats loudly', async () => {
  const { cloud } = makeWorld();
  await assert.rejects(cloud.ingestDelta({ format: 'nope', items: [] }), /unknown package format/);
  await assert.rejects(cloud.ingestDelta(null), /requires a delta package/);
});
