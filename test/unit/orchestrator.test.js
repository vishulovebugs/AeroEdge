'use strict';

/**
 * Unit tests for Phase 4: the routing function across memory type × stub
 * verdict × importance, lifecycle application, UPDATE versioning semantics,
 * and the memory store's validation + separation guarantees.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  stubVerdictSource,
  routeMemory,
  createMemoryOrchestrator,
  SYNC_IMPORTANCE_THRESHOLD,
} from '../../edge/orchestrator.js';
import { createMemoryStore } from '../../edge/memoryStore.js';
import { createSession } from '../../edge/session.js';
import { makeFakeQdrant } from '../helpers/fakes.js';

/** Build a Memory with valid defaults, overridden by `patch`. */
function memory(patch = {}) {
  const now = '2026-09-25T10:00:00.000Z';
  return {
    memory_id: patch.memory_id ?? 'mem-test-1',
    memory_type: patch.memory_type ?? 'field_observation',
    content: patch.content ?? 'Pump 2B whines above 3000 PSI; suspected cavitation.',
    asset_id: patch.asset_id ?? 'aircraft-MSN4453',
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

/** In-memory store double implementing the memoryStore surface. */
function makeMemoryStoreDouble() {
  /** @type {Map<string, Record<string, unknown>>} */
  const memories = new Map();
  return {
    memories,
    async putMemory(record) {
      memories.set(record.memory_id, { ...record });
      return { ...record };
    },
    async getMemory(id) {
      const r = memories.get(id);
      return r ? { ...r } : null;
    },
    async listMemories() {
      return [...memories.values()];
    },
    async deleteMemory(id) {
      return memories.delete(id);
    },
  };
}

function makeOrchestrator(overrides = {}) {
  const store = overrides.store ?? makeMemoryStoreDouble();
  const session = overrides.session ?? null;
  const orchestrator = createMemoryOrchestrator({
    config: {},
    memoryStore: store,
    ...(session !== null ? { session } : {}),
    ...(overrides.verdictSource !== undefined ? { verdictSource: overrides.verdictSource } : {}),
  });
  return { store, session, orchestrator };
}

// ---------------------------------------------------------------------------
// Stub verdict source
// ---------------------------------------------------------------------------

test('stub verdict source always returns accept_local and says so honestly', async () => {
  const v = await stubVerdictSource({ memory: memory(), question: 'why?', evidence: [] });
  assert.equal(v.verdict, 'accept_local');
  assert.equal(v.stub, true);
  assert.equal(v.model_used, 'aeroedge-stub-verdict');
  assert.match(v.rationale, /Stub verdict source \(Phase 4\)/);
});

// ---------------------------------------------------------------------------
// Routing table: memory type × stub verdict × importance
// ---------------------------------------------------------------------------

test('routing: field_observation + accept_local + importance below threshold → KEEP_LOCAL', () => {
  const decision = routeMemory(memory({ importance: 0.4 }), { verdict: 'accept_local' });
  assert.equal(decision.action, 'KEEP_LOCAL');
  assert.match(decision.reason, /importance 0\.4/);
});

test(`routing: field_observation + accept_local + importance ≥ ${SYNC_IMPORTANCE_THRESHOLD} → SYNC`, () => {
  const decision = routeMemory(memory({ importance: SYNC_IMPORTANCE_THRESHOLD }), { verdict: 'accept_local' });
  assert.equal(decision.action, 'SYNC');
});

test('routing: session_note + accept_local → KEEP_LOCAL regardless of importance', () => {
  const low = routeMemory(memory({ memory_type: 'session_note', importance: 0.1 }), { verdict: 'accept_local' });
  const high = routeMemory(memory({ memory_type: 'session_note', importance: 0.95 }), { verdict: 'accept_local' });
  assert.equal(low.action, 'KEEP_LOCAL');
  assert.equal(high.action, 'KEEP_LOCAL');
  assert.match(low.reason, /session note/);
});

test('routing: manual memories never ride the technician lifecycle (no SYNC from importance)', () => {
  const decision = routeMemory(memory({ memory_type: 'manual', importance: 0.95, lifecycle_status: 'local', jev_status: 'not_applicable' }), {
    verdict: 'accept_local',
  });
  assert.equal(decision.action, 'KEEP_LOCAL', 'manual is reference material, not syncable technician knowledge');
});

test('routing: already sync_pending/synced + accept_local → KEEP_LOCAL no-op', () => {
  for (const lifecycle of ['sync_pending', 'synced']) {
    const decision = routeMemory(memory({ lifecycle_status: lifecycle, sync_status: lifecycle }), {
      verdict: 'accept_local',
    });
    assert.equal(decision.action, 'KEEP_LOCAL');
    assert.match(decision.reason, /no-op/);
  }
});

test('routing: EXPIRE on explicit request (never for manual), no-op when already expired', () => {
  const decision = routeMemory(memory(), { verdict: 'accept_local' }, { expire: true });
  assert.equal(decision.action, 'EXPIRE');

  const manual = memory({ memory_type: 'manual', lifecycle_status: 'local', jev_status: 'not_applicable' });
  assert.throws(() => routeMemory(manual, { verdict: 'accept_local' }, { expire: true }), /manual/);

  const gone = routeMemory(memory({ lifecycle_status: 'expired' }), { verdict: 'accept_local' }, { expire: true });
  assert.equal(gone.action, 'EXPIRE');
  assert.match(gone.reason, /no-op/);
});

test('routing: UPDATE on explicit updateOf (never for session_note or expired parents)', () => {
  const decision = routeMemory(memory({ importance: 0.9 }), { verdict: 'accept_local' }, { updateOf: 'mem-parent' });
  assert.equal(decision.action, 'UPDATE');
  assert.equal(decision.updateOf, 'mem-parent');
  assert.match(decision.reason, /never a silent overwrite/);

  assert.throws(
    () =>
      routeMemory(memory({ memory_type: 'session_note' }), { verdict: 'accept_local' }, { updateOf: 'mem-x' }),
    /session notes/
  );
  assert.throws(
    () => routeMemory(memory({ lifecycle_status: 'expired' }), { verdict: 'accept_local' }, { updateOf: 'mem-x' }),
    /expired/
  );
});

test('routing: non-accept_local verdicts are refused loudly (Phase 5 wires them for real)', () => {
  for (const verdict of ['needs_more_evidence', 'flag_risk', 'validated', 'needs_human_review', 'rejected']) {
    assert.throws(() => routeMemory(memory(), { verdict }), new RegExp(`"${verdict}" requires the JEV/sync machinery`));
  }
  assert.throws(() => routeMemory(memory(), /** @type {any} */ ({ verdict: 'banana' })), /unknown verdict/);
  assert.throws(() => routeMemory(memory(), /** @type {any} */ (null)), TypeError);
});

// ---------------------------------------------------------------------------
// applyRoute: lifecycle transitions actually stored
// ---------------------------------------------------------------------------

test('applyRoute KEEP_LOCAL: new → local and pending → accept_local are stored', async () => {
  const { store, orchestrator } = makeOrchestrator();
  const record = memory();
  await store.putMemory(record);
  const decision = routeMemory(await store.getMemory(record.memory_id), { verdict: 'accept_local' });
  const applied = await orchestrator.applyRoute(decision);

  assert.equal(applied.action, 'KEEP_LOCAL');
  assert.deepEqual(applied.transitions, ['lifecycle new → local', 'jev pending → accept_local']);
  const stored = await store.getMemory(record.memory_id);
  assert.equal(stored.lifecycle_status, 'local');
  assert.equal(stored.jev_status, 'accept_local');
});

test('applyRoute SYNC: marks stored sync_pending (sync engine itself is a later phase)', async () => {
  const { store, orchestrator } = makeOrchestrator();
  const record = memory({ importance: 0.9 });
  await store.putMemory(record);
  const decision = routeMemory(await store.getMemory(record.memory_id), { verdict: 'accept_local' });
  const applied = await orchestrator.applyRoute(decision);

  assert.equal(applied.action, 'SYNC');
  assert.equal((await store.getMemory(record.memory_id)).lifecycle_status, 'sync_pending');
  assert.deepEqual(applied.transitions, ['lifecycle new → local', 'jev pending → accept_local', 'lifecycle local → sync_pending']);
});

test('applyRoute EXPIRE: stored expired is terminal (nothing transitions out of it)', async () => {
  const { store, orchestrator } = makeOrchestrator();
  const record = memory();
  await store.putMemory(record);
  const applied = await orchestrator.applyRoute(routeMemory(await store.getMemory(record.memory_id), { verdict: 'accept_local' }, { expire: true }));
  assert.equal(applied.memory.lifecycle_status, 'expired');
  await assert.rejects(
    orchestrator.noteMemoryUsed(record.memory_id),
    /Illegal lifecycle_status transition "expired" → "used"/
  );
});

test('applyRoute UPDATE: new version with revision_of lineage, parent untouched', async () => {
  const { store, orchestrator } = makeOrchestrator();
  const parent = memory({ memory_id: 'mem-parent', content: 'Original observation.' });
  await store.putMemory(parent);

  const revision = memory({
    content: 'Corrected: pump 2B whines above 2800 PSI (cavitation confirmed).',
    importance: 0.8,
  });
  const decision = routeMemory(revision, { verdict: 'accept_local' }, { updateOf: 'mem-parent' });
  const applied = await orchestrator.applyRoute(decision);

  assert.equal(applied.action, 'UPDATE');
  assert.notEqual(applied.memory.memory_id, 'mem-parent', 'revision is a NEW memory');
  assert.equal(applied.memory.revision_of, 'mem-parent');
  assert.equal(applied.memory.version, '2', 'version is parent version + 1');
  assert.equal(applied.memory.lifecycle_status, 'new', 'revision keeps its initial technician lifecycle');
  assert.equal(applied.memory.jev_status, 'pending');

  // Parent is byte-identical: no silent overwrite.
  const storedParent = await store.getMemory('mem-parent');
  assert.equal(storedParent.content, 'Original observation.');
  assert.equal(storedParent.version, '1');
  assert.equal(storedParent.revision_of, undefined);
  assert.ok(!('revision_of' in storedParent));
});

test('applyRoute UPDATE with missing parent fails loudly (no orphan revisions)', async () => {
  const { orchestrator } = makeOrchestrator();
  const decision = routeMemory(memory(), { verdict: 'accept_local' }, { updateOf: 'mem-ghost' });
  await assert.rejects(orchestrator.applyRoute(decision), /not found/);
});

test('applyRoute FLAG_CONFLICT is refused loudly this phase', async () => {
  const { orchestrator } = makeOrchestrator();
  await assert.rejects(
    orchestrator.applyRoute(/** @type {any} */ ({ action: 'FLAG_CONFLICT', memory: memory(), reason: 'x', verdict: 'flag_risk' })),
    /later phases/
  );
});

test('reviseMemory: full pipeline revision — new version, lineage stored, parent intact', async () => {
  const { store, orchestrator } = makeOrchestrator();
  const parent = await orchestrator.captureObservation({
    content: 'Filter housing gasket seeps under 2000 PSI.',
    assetId: 'aircraft-MSN4453',
    source: 'technician-jane',
    importance: 0.4,
  });

  const result = await orchestrator.reviseMemory(parent.memory_id, {
    content: 'Correction: seep starts under 1800 PSI, not 2000.',
    importance: 0.8,
  });
  assert.equal(result.action, 'UPDATE');
  assert.equal(result.memory.revision_of, parent.memory_id);
  assert.equal(result.memory.version, '2');
  assert.equal(result.memory.importance, 0.8);
  assert.equal((await store.getMemory(parent.memory_id)).content, 'Filter housing gasket seeps under 2000 PSI.');
});

test('noteMemoryUsed: local → used is stored; jev_status untouched (usage is not validation)', async () => {
  const { store, orchestrator } = makeOrchestrator();
  const record = await orchestrator.captureObservation({
    content: 'Quench port needs 8 s, not 5 s.',
    assetId: 'aircraft-MSN4453',
    source: 'technician-jane',
  });
  const result = await orchestrator.noteMemoryUsed(record.memory_id);
  assert.deepEqual(result.transitions, ['lifecycle new → local', 'lifecycle local → used']);
  assert.equal(result.memory.lifecycle_status, 'used');
  assert.equal(result.memory.jev_status, 'pending');

  // Second call is a no-op (already used).
  const again = await orchestrator.noteMemoryUsed(record.memory_id);
  assert.equal(again.transitions.length, 0);
  // Manual memories do not ride this lifecycle.
  const manual = await orchestrator.captureManual({ content: 'Reference document excerpt.', assetId: 'a', source: 's' });
  await assert.rejects(orchestrator.noteMemoryUsed(manual.memory_id), /manual/);
  // Unknown ids fail loudly.
  await assert.rejects(orchestrator.noteMemoryUsed('mem-ghost'), /not found/);
});

// ---------------------------------------------------------------------------
// Memory store: validation gate + separation
// ---------------------------------------------------------------------------

test('memory store rejects invalid memories before any Qdrant interaction', async () => {
  const qdrant = makeFakeQdrant();
  const store = createMemoryStore({
    config: { QDRANT_EDGE_URL: 'http://localhost:6333', QDRANT_EDGE_MEMORY_COLLECTION: 'mem' },
    qdrant,
  });
  const bad = memory({ importance: 'high' });
  await assert.rejects(store.putMemory(bad), /Memory failed validation/);
  assert.equal(qdrant.calls.length, 0, 'nothing reached Qdrant');
});

test('memory store keeps memories separate from documents and keys by payload memory_id', async () => {
  const qdrant = makeFakeQdrant({ collection: 'aeroedge_edge_memories' });
  const store = createMemoryStore({
    config: { QDRANT_EDGE_URL: 'http://localhost:6333', QDRANT_EDGE_MEMORY_COLLECTION: 'aeroedge_edge_memories' },
    qdrant,
  });
  await store.putMemory(memory({ memory_id: 'mem-a' }));
  await store.putMemory(memory({ memory_id: 'mem-a' })); // put is idempotent

  assert.equal(qdrant.collection, 'aeroedge_edge_memories', 'dedicated memories collection');
  assert.equal(await store.getMemory('mem-a') !== null, true);
  assert.equal(qdrant.size(), 1, 'idempotent put: one point per memory_id');

  const retrieved = await store.getMemory('mem-a');
  assert.equal(retrieved.memory_type, 'field_observation');
  assert.equal(retrieved.lifecycle_status, 'new', 'initial lifecycle STORED, not inferred');
  assert.equal(retrieved.jev_status, 'pending');
});

test('orchestrator capture paths enforce input validation', async () => {
  const { orchestrator } = makeOrchestrator();
  await assert.rejects(orchestrator.captureObservation({ content: ' ', assetId: 'a', source: 's' }), /"content"/);
  await assert.rejects(orchestrator.captureObservation({ content: 'c', assetId: 'a', source: 's', importance: 2 }), /"importance"/);
  await assert.rejects(orchestrator.captureObservation({ content: 'c', assetId: 'a', source: 's', confidence: -1 }), /"confidence"/);
  await assert.rejects(orchestrator.captureSessionNote({ content: '', assetId: 'a', source: 's' }), /"content"/);
  await assert.rejects(orchestrator.captureManual({ content: 'c', assetId: 'a', source: ' ' }), /"source"/);
});

test('orchestrator: importance crossing the threshold routes SYNC end-to-end (route + apply)', async () => {
  const { store, orchestrator } = makeOrchestrator();
  const record = await orchestrator.captureObservation({
    content: 'Crack pattern repeats on every third shackle.',
    assetId: 'rig-07',
    source: 'technician-raj',
    importance: 0.85,
  });
  const decision = await orchestrator.routeWithVerdict(await store.getMemory(record.memory_id));
  assert.equal(decision.action, 'SYNC');
  const applied = await orchestrator.applyRoute(decision);
  assert.equal((await store.getMemory(record.memory_id)).lifecycle_status, 'sync_pending');
  assert.equal(applied.memory.jev_status, 'accept_local');
});
