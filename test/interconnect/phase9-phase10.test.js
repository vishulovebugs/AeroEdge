'use strict';

/**
 * Interconnection tests for Phase 9 ↔ Phase 10: the EXACT Conflict object
 * created by Phase 9's reconciler is the one carried through Cloud JEV —
 * no re-creation, jev_recommendation populated on the same object, no
 * dropped fields. Plus: the propagation gate sits between synced memories
 * and fleet trust.
 *
 * All offline via the shared fakes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryStore } from '../../edge/memoryStore.js';
import { createSyncEngine, createInMemoryLedger, fingerprintMemory } from '../../edge/syncEngine.js';
import { createReconciler } from '../../edge/reconciliation.js';
import { createCloudSyncIngest } from '../../cloud/sync.js';
import { createCloudJev } from '../../cloud/jevCloud.js';
import { createFleetGate } from '../../cloud/propagation.js';
import { makeFakeOllama, makeFakeQdrant, makeScriptedJev } from '../helpers/fakes.js';

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
  QDRANT_CLOUD_REVIEW_COLLECTION: 'aeroedge_cloud_review_queue',
});

function makeWorld(scriptedResponses) {
  const ollama = makeFakeOllama();
  const scripted = makeScriptedJev(scriptedResponses ?? [
    JSON.stringify({ verdict: 'validated', rationale: 'Corroborated by fleet observation 1; consistent with master doc 1.', confidence: 0.9 }),
  ]);
  ollama.generate = async ({ prompt }) => scripted.respond({ prompt });

  const edgeMemories = makeFakeQdrant({ collection: 'aeroedge_edge_memories' });
  const cloudMemories = makeFakeQdrant({ collection: 'aeroedge_cloud_memories' });
  const cloudDocs = makeFakeQdrant({ collection: 'aeroedge_cloud_docs' });
  const cloudSync = makeFakeQdrant({ collection: 'aeroedge_cloud_sync_events' });
  const cloudConflicts = makeFakeQdrant({ collection: 'aeroedge_cloud_conflicts' });
  const cloudReview = makeFakeQdrant({ collection: 'aeroedge_cloud_review_queue' });
  const cloudVerdicts = makeFakeQdrant({ collection: 'aeroedge_cloud_verdicts' });

  const memoryStore = createMemoryStore({ config: CONFIG, qdrant: edgeMemories });
  const ledger = createInMemoryLedger();
  const syncEngine = createSyncEngine({ memoryStore, ledger, deviceId: 'device-1' });
  const reconciler = createReconciler({ memoryStore, ledger, cloudMemories, cloudConflicts });
  const cloud = createCloudSyncIngest({ config: CONFIG, cloudMemories, cloudSyncEvents: cloudSync });
  const cloudJev = createCloudJev({ config: CONFIG, ollama, cloudMemories, cloudDocs, cloudVerdicts });
  const gate = createFleetGate({ cloudMemories, cloudReview, cloudConflicts });
  return { ollama, scripted, cloudMemories, cloudDocs, cloudConflicts, cloudReview, cloudVerdicts, memoryStore, ledger, syncEngine, reconciler, cloud, cloudJev, gate };
}

test('the EXACT Phase 9 Conflict object is carried through: same id, recommendation populated in place, no dropped fields', async () => {
  const { cloudMemories, cloudConflicts, memoryStore, ledger, syncEngine, reconciler, cloudJev, gate } = makeWorld([
    JSON.stringify({ verdict: 'validated', rationale: 'Cloud version agrees with the enterprise master doc; the edge version contradicts it.', confidence: 0.85 }),
  ]);

  // ---- Phase 9 creates the conflict for real ----
  // NOTE: a SYNCED field observation (Phase 8 never syncs manuals — those
  // are reference material), so the divergence actually rides the delta.
  const ancestor = {
    memory_id: 'mem-m204-ic',
    memory_type: 'field_observation',
    content: 'M-204 pump overhaul interval observed at 2000 h.',
    asset_id: 'FLEET-STANDARD',
    source: 'technician-original (device-0)',
    version: '3', importance: 0.9, confidence: 0.8,
    created_at: '2026-09-29T10:00:00.000Z', updated_at: '2026-09-29T10:00:00.000Z',
    sync_status: 'synced', lifecycle_status: 'synced', jev_status: 'accept_local',
  };
  await memoryStore.putMemory(ancestor);
  await cloudMemories.upsertPoints([{ id: ancestor.memory_id, vector: [1], payload: { ...ancestor } }]);
  await ledger.recordSynced(ancestor.memory_id, fingerprintMemory(ancestor));

  const edgeV4 = { ...ancestor, content: 'M-204 pump overhaul interval is 2500 h (field-confirmed on this asset).', version: '4', lifecycle_status: 'used' };
  await memoryStore.putMemory(edgeV4);
  const cloudV5 = { ...ancestor, content: 'M-204 pump overhaul interval revised to 2200 h (fleet engineering update).', version: '5' };
  await cloudMemories.upsertPoints([{ id: cloudV5.memory_id, vector: [1], payload: { ...cloudV5 } }]);

  const pkg = await syncEngine.buildDelta();
  const outcome = await reconciler.reconcileDelta(pkg, async () => []);
  assert.equal(outcome.conflicts, 1);
  const phase9ConflictId = outcome.conflictIds[0];

  // Snapshot EVERY field of the Phase 9 record before Cloud JEV touches it.
  const phase9Record = await gate.getConflict(phase9ConflictId);
  assert.equal(phase9Record.status, 'open');

  // ---- Phase 10 recommends on the SAME record ----
  const candidate = await cloudMemories.scrollWithFilter(
    { must: [{ key: 'memory_id', match: { value: ancestor.memory_id } }] }, { limit: 1 }
  );
  const cloudResult = await cloudJev.evaluateMemory(/** @type {any} */ (candidate[0].payload));
  const cloudVerdictRecord = cloudJev.verdictRecord(cloudResult, ancestor.memory_id);

  const updated = await gate.recommendConflictResolution(
    phase9ConflictId,
    { verdict: 'adopt_cloud', rationale: cloudResult.rationale },
    cloudVerdictRecord
  );

  // No re-creation: same conflict_id; every Phase 9 field preserved.
  assert.equal(updated.conflict_id, phase9ConflictId);
  assert.equal(updated.memory_id, phase9Record.memory_id);
  assert.equal(updated.edge_version, phase9Record.edge_version);
  assert.equal(updated.cloud_version, phase9Record.cloud_version);
  assert.equal(updated.conflict_type, phase9Record.conflict_type);
  assert.equal(updated.status, 'open', 'recommendation alone NEVER resolves');
  // The recommendation is populated on the SAME object.
  assert.match(updated.jev_recommendation.rationale, /master doc/i);

  // And the stored record is the same one, mutated in place (no duplicate).
  const stored = await gate.getConflict(phase9ConflictId);
  assert.equal(stored.status, 'open');
  assert.match(stored.jev_recommendation.rationale, /master doc/i);
  const all = await cloudConflicts.scrollWithFilter({}, { limit: 100 });
  const matching = all.filter((h) => h.payload.memory_id === ancestor.memory_id);
  assert.equal(matching.length, 1, 'exactly ONE conflict record exists — no re-creation');
});

test('recommendation does not auto-apply; confirmation is the separate gate to resolved', async () => {
  const { cloudConflicts, memoryStore, ledger, syncEngine, reconciler, cloudJev, gate, cloudMemories } = makeWorld([
    JSON.stringify({ verdict: 'needs_human_review', rationale: 'Corroboration is thin; the divergence needs a human.', confidence: 0.4 }),
  ]);

  const ancestor = {
    memory_id: 'mem-m204-ic2',
    memory_type: 'field_observation',
    content: 'M-204 pump overhaul interval observed at 2000 h.',
    asset_id: 'FLEET-STANDARD', source: 'technician-original (device-0)', version: '3',
    importance: 0.9, confidence: 0.8,
    created_at: '2026-09-29T10:00:00.000Z', updated_at: '2026-09-29T10:00:00.000Z',
    sync_status: 'synced', lifecycle_status: 'synced', jev_status: 'accept_local',
  };
  await memoryStore.putMemory(ancestor);
  await cloudMemories.upsertPoints([{ id: ancestor.memory_id, vector: [1], payload: { ...ancestor } }]);
  await ledger.recordSynced(ancestor.memory_id, fingerprintMemory(ancestor));
  const edgeV4 = { ...ancestor, content: 'M-204 pump overhaul interval is 2600 h on high-cycle assets.', version: '4', lifecycle_status: 'used' };
  await memoryStore.putMemory(edgeV4);
  const cloudV5 = { ...ancestor, content: 'M-204 pump overhaul interval revised to 2300 h (fleet engineering).', version: '5' };
  await cloudMemories.upsertPoints([{ id: cloudV5.memory_id, vector: [1], payload: { ...cloudV5 } }]);

  const pkg = await syncEngine.buildDelta();
  const outcome = await reconciler.reconcileDelta(pkg, async () => []);
  assert.equal(outcome.conflicts, 1);
  const conflictId = outcome.conflictIds[0];

  const candidate = await cloudMemories.scrollWithFilter(
    { must: [{ key: 'memory_id', match: { value: ancestor.memory_id } }] }, { limit: 1 }
  );
  const cloudResult = await cloudJev.evaluateMemory(/** @type {any} */ (candidate[0].payload));
  const cloudVerdictRecord = cloudJev.verdictRecord(cloudResult, ancestor.memory_id);
  await gate.recommendConflictResolution(
    conflictId,
    { verdict: 'adopt_cloud', rationale: cloudResult.rationale },
    cloudVerdictRecord
  );

  // Between recommendation and confirmation: STILL open (nothing auto-applied).
  const stillOpen = await gate.getConflict(conflictId);
  assert.equal(stillOpen.status, 'open');

  // The human confirms — the ONLY path to resolved.
  const resolved = await gate.confirmConflictResolution(conflictId, {
    resolvedBy: 'fleet-engineer-x',
    winner: 'cloud',
    resolution: 'Adopt cloud v5; devices re-provisioned.',
  });
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.resolved_by, 'fleet-engineer-x');
  assert.equal(resolved.resolution_winner, 'cloud');
  void cloudConflicts;
});
