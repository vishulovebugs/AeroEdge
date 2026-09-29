'use strict';

/**
 * Unit tests for Phase 10: the propagation gate (tested DIRECTLY, not via
 * the LLM), the fleet-context Cloud Pass prompt, verdict application via
 * legal transitions, the human-review queue, and conflict recommend /
 * confirm discipline (nothing auto-applied).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canPropagate,
  routeVerdict,
  createFleetGate,
  PROPAGATION_RULE,
} from '../../cloud/propagation.js';
import { createCloudJev, CLOUD_JEV_VERDICTS } from '../../cloud/jevCloud.js';
import { createInMemoryLedger, fingerprintMemory } from '../../edge/syncEngine.js';
import { makeFakeOllama, makeFakeQdrant, makeScriptedJev } from '../helpers/fakes.js';

const CONFIG = Object.freeze({
  OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
  EMBEDDING_MODEL: 'nomic-embed-text',
  OLLAMA_MODEL: 'llama3.1:8b',
  QDRANT_EDGE_URL: 'http://localhost:6333',
  QDRANT_CLOUD_URL: 'http://localhost:6334',
  QDRANT_CLOUD_MEMORY_COLLECTION: 'aeroedge_cloud_memories',
  QDRANT_CLOUD_COLLECTION: 'aeroedge_cloud_docs',
  QDRANT_CLOUD_SYNC_COLLECTION: 'aeroedge_cloud_sync_events',
  QDRANT_CLOUD_CONFLICT_COLLECTION: 'aeroedge_cloud_conflicts',
  QDRANT_CLOUD_REVIEW_COLLECTION: 'aeroedge_cloud_review_queue',
});

let seq = 0;
function memory(patch = {}) {
  seq += 1;
  const now = '2026-09-29T10:00:00.000Z';
  return {
    memory_id: patch.memory_id ?? `mem-cl-${String(seq).padStart(3, '0')}`,
    memory_type: patch.memory_type ?? 'field_observation',
    content: patch.content ?? 'Pump 2B inlet B-nut seeps below 40 N·m.',
    asset_id: patch.asset_id ?? 'MSN4453',
    source: patch.source ?? 'technician-jane',
    version: patch.version ?? '1',
    importance: patch.importance ?? 0.8,
    confidence: patch.confidence ?? 0.5,
    created_at: now,
    updated_at: now,
    sync_status: patch.sync_status ?? 'synced',
    lifecycle_status: patch.lifecycle_status ?? 'synced',
    jev_status: patch.jev_status ?? 'accept_local',
  };
}

// ---------------------------------------------------------------------------
// THE GATE — tested directly, not through any LLM path
// ---------------------------------------------------------------------------

test('PROPAGATION GATE: only validated passes; every other verdict is blocked at the code level', () => {
  assert.equal(canPropagate('validated'), true);
  for (const blocked of ['needs_human_review', 'rejected', 'accept_local', 'flag_risk', 'needs_more_evidence', 'pending', 'validated ', '', 'banana']) {
    assert.equal(canPropagate(blocked), false, `"${String(blocked)}" must be blocked by the gate`);
  }
  // The gate is not lenient with non-strings either.
  assert.equal(canPropagate(/** @type {any} */ (undefined)), false);
  assert.equal(canPropagate(/** @type {any} */ (null)), false);
});

test('routeVerdict: exactly three actions, fail closed on garbage', () => {
  assert.deepEqual(routeVerdict('validated').action, 'propagate');
  assert.deepEqual(routeVerdict('needs_human_review').action, 'review');
  assert.deepEqual(routeVerdict('rejected').action, 'hold_local');
  assert.deepEqual(routeVerdict('banana').action, 'hold_local', 'fail closed');
  assert.deepEqual(routeVerdict(/** @type {any} */ (null)).action, 'hold_local');
  assert.equal(PROPAGATION_RULE, 'only validated verdicts propagate to the fleet');
});

// ---------------------------------------------------------------------------
// Cloud Pass: fleet context is the point — prompt can't even be built without it
// ---------------------------------------------------------------------------

function makeJevWorld() {
  const ollama = makeFakeOllama();
  const scripted = makeScriptedJev([
    JSON.stringify({ verdict: 'validated', rationale: 'Corroborated by fleet observations 1 and 2; consistent with master doc 1.', confidence: 0.9 }),
  ]);
  ollama.generate = async ({ prompt }) => scripted.respond({ prompt });
  const cloudMemories = makeFakeQdrant({ collection: 'aeroedge_cloud_memories' });
  const cloudDocs = makeFakeQdrant({ collection: 'aeroedge_cloud_docs' });
  const cloudVerdicts = makeFakeQdrant({ collection: 'aeroedge_cloud_verdicts' });
  const cloudReview = makeFakeQdrant({ collection: 'aeroedge_cloud_review_queue' });
  const cloudConflicts = makeFakeQdrant({ collection: 'aeroedge_cloud_conflicts' });
  const cloudJev = createCloudJev({ config: CONFIG, ollama, cloudMemories, cloudDocs, cloudVerdicts });
  const gate = createFleetGate({ cloudMemories, cloudReview, cloudConflicts });
  return { ollama, scripted, cloudMemories, cloudDocs, cloudVerdicts, cloudReview, cloudConflicts, cloudJev, gate };
}

test('cloud prompt is a DIFFERENT role with fleet context the Edge Pass never had', async () => {
  const { cloudMemories, cloudDocs, cloudVerdicts, cloudJev } = makeJevWorld();
  const candidate = memory();
  // Another device's corroborating observation + a master doc + history.
  await cloudMemories.upsertPoints([
    { id: 'fleet-1', vector: new Array(32).fill(0.1), payload: { memory_id: 'mem-other-1', source: 'technician-raj (device-2)', content: 'Inlet B-nut seepage below 40 N·m observed on MSN4453.', asset_id: 'MSN4453', lifecycle_status: 'synced', jev_status: 'accept_local' } },
  ]);
  await cloudDocs.upsertPoints([
    { id: 'master-1', vector: new Array(32).fill(0.1), payload: { id: 'master-1', document_id: 'ent-std', content: 'Enterprise standard: inlet B-nut torque 45 N·m on MSN4453.', asset_id: 'MSN4453', component: 'hydraulics', source: 'Enterprise std rev 12', version: '12', jev_status: 'not_applicable' } },
  ]);
  await cloudVerdicts.upsertPoints([
    { id: 'hist-1', vector: [1], payload: { verdict_id: 'jevc-h1', memory_id: 'mem-older', asset_id: 'MSN4453', verdict: 'validated', rationale: 'Earlier corroborated finding.', evaluated_at: '2026-09-28T00:00:00.000Z' } },
  ]);

  const context = await cloudJev.gatherFleetContext(candidate);
  assert.equal(context.fleetObservations.length, 1, 'fleet observations gathered');
  assert.equal(context.fleetObservations[0].sourceDevice, 'technician-raj (device-2)');
  assert.equal(context.masterDocs.length, 1);
  assert.equal(context.jevHistory.length, 1);

  const { system, prompt } = cloudJev.buildCloudPrompt(candidate, context);
  assert.match(system, /JEV-Cloud/);
  assert.match(system, /fleet-level/);
  assert.ok(prompt.includes('OTHER DEVICES observed'), 'fleet observations in prompt');
  assert.ok(prompt.includes('technician-raj (device-2)'), 'cross-device identity visible');
  assert.ok(prompt.includes('Authoritative enterprise master documents'), 'master docs in prompt');
  assert.ok(prompt.includes('Prior JEV history'), 'history in prompt');
  assert.ok(prompt.includes('Corroboration'), 'corroboration check driven');
  assert.ok(prompt.includes('supersede, refine, or duplicate'), 'knowledge-relation check driven');
});

test('cloud prompt refuses to build without fleet context (a context-less Cloud Pass is a mislabeled Edge Pass)', () => {
  const { cloudJev } = makeJevWorld();
  assert.throws(() => cloudJev.buildCloudPrompt(memory(), /** @type {any} */ (null)), /requires gathered fleet context/);
});

test('cloud verdicts: empty/missing rationale coerces to needs_human_review (never validated)', async () => {
  for (const scriptedBody of [
    { verdict: 'validated', rationale: '   ' },
    { verdict: 'validated' },
    { verdict: 'banana', rationale: 'x' },
    'totally not json',
  ]) {
    const ollama = makeFakeOllama();
    ollama.generate = async () => (typeof scriptedBody === 'string' ? scriptedBody : JSON.stringify(scriptedBody));
    const cloudJev = createCloudJev({
      config: CONFIG, ollama,
      cloudMemories: makeFakeQdrant(), cloudDocs: makeFakeQdrant(), cloudVerdicts: makeFakeQdrant(),
    });
    const result = await cloudJev.evaluateMemory(memory());
    assert.equal(result.verdict, 'needs_human_review', `${JSON.stringify(scriptedBody).slice(0, 40)} must not pass`);
    assert.ok(result.rationale.trim() !== '');
    assert.match(result.rationale, /coerced by code/i);
  }
});

test('cloud verdict record: stage cloud, contract-clean; evidence stamped from what the model saw', async () => {
  const { cloudMemories, cloudJev } = makeJevWorld();
  await cloudMemories.upsertPoints([
    { id: 'fleet-9', vector: new Array(32).fill(0.2), payload: { memory_id: 'mem-fleet-9', source: 'device-3', content: 'Corroborating seepage report.', asset_id: 'MSN4453' } },
  ]);
  const result = await cloudJev.evaluateMemory(memory());
  assert.equal(result.stage, 'cloud');
  const record = cloudJev.verdictRecord(result, memory().memory_id);
  assert.equal(record.stage, 'cloud');
  assert.ok(String(record.verdict_id).startsWith('jevc-'));
  assert.ok(result.evidence_used.includes('mem-fleet-9'), 'fleet item stamped as evidence (by memory id)');
  assert.equal(CLOUD_JEV_VERDICTS.length, 3);
});

// ---------------------------------------------------------------------------
// Verdict application: legal transitions only; review queue; gate enforcement
// ---------------------------------------------------------------------------

test('applyCloudVerdict: validated propagates via the legal accept_local → validated transition', async () => {
  const { cloudMemories, gate } = makeJevWorld();
  const m = memory({ lifecycle_status: 'synced', jev_status: 'accept_local' });
  const verdict = {
    verdict_id: 'jevc-v1', memory_id: m.memory_id, stage: 'cloud', verdict: 'validated',
    rationale: 'corroborated', confidence: 0.9, risk_flags: [], evidence_used: [], model_used: 'm',
    evaluated_at: '2026-09-29T10:00:00.000Z',
  };
  const out = await gate.applyCloudVerdict(verdict, m);
  assert.equal(out.action, 'propagate');
  assert.deepEqual(out.transitions, ['jev accept_local → validated']);
  const stored = await cloudMemories.scrollWithFilter(
    { must: [{ key: 'memory_id', match: { value: m.memory_id } }] }, { limit: 2 }
  );
  assert.equal(stored[0].payload.jev_status, 'validated', 'the cloud copy is FLEET-TRUSTED');
  assert.equal(canPropagate(String(verdict.verdict)), true, 'gate agrees');
});

test('applyCloudVerdict: needs_human_review is QUEUED, not propagated (no illegal memory transition forced)', async () => {
  const { cloudMemories, cloudReview, gate } = makeJevWorld();
  const m = memory({ lifecycle_status: 'synced', jev_status: 'accept_local' });
  const verdict = {
    verdict_id: 'jevc-r1', memory_id: m.memory_id, stage: 'cloud', verdict: 'needs_human_review',
    rationale: 'single device, no corroboration', confidence: 0.3, risk_flags: ['single_device_unverified'],
    evidence_used: [], model_used: 'm', evaluated_at: '2026-09-29T10:00:00.000Z',
  };
  const out = await gate.applyCloudVerdict(verdict, m);
  assert.equal(out.action, 'review');
  assert.notEqual(out.queueId, undefined);
  const queue = await gate.listReviewQueue();
  assert.equal(queue.length, 1);
  assert.equal(queue[0].verdict.verdict, 'needs_human_review');
  // The memory itself was NOT transitioned to a verdict state it cannot hold.
  const stored = await cloudMemories.scrollWithFilter(
    { must: [{ key: 'memory_id', match: { value: m.memory_id } }] }, { limit: 2 }
  );
  assert.equal(stored.length, 0, 'no cloud overwrite happened for a review-routed item');
  assert.equal(canPropagate('needs_human_review'), false);
});

test('applyCloudVerdict: rejected holds local history via the legal transition; never propagated', async () => {
  const { gate } = makeJevWorld();
  const m = memory({ lifecycle_status: 'synced', jev_status: 'accept_local' });
  const edgeStoreBacking = {
    putMemory: async (record) => record,
    getMemory: async () => m,
  };
  const gateWithEdge = createFleetGate({
    cloudMemories: makeFakeQdrant(),
    cloudReview: makeFakeQdrant(),
    cloudConflicts: makeFakeQdrant(),
    edgeMemoryStore: edgeStoreBacking,
  });
  const verdict = {
    verdict_id: 'jevc-x1', memory_id: m.memory_id, stage: 'cloud', verdict: 'rejected',
    rationale: 'safety-critical contradiction with the master doc', confidence: 0.9,
    risk_flags: ['safety_contradiction'], evidence_used: [], model_used: 'm',
    evaluated_at: '2026-09-29T10:00:00.000Z',
  };
  const out = await gateWithEdge.applyCloudVerdict(verdict, m);
  assert.equal(out.action, 'hold_local');
  assert.deepEqual(out.transitions, ['jev accept_local → rejected']);
  assert.equal(canPropagate('rejected'), false);
});

// ---------------------------------------------------------------------------
// Conflict resolution: recommend (same record) + confirm (human-only)
// ---------------------------------------------------------------------------

function seedConflict(cloudConflicts) {
  const conflict = {
    conflict_id: 'cfl-test-1',
    memory_id: 'mem-m204',
    edge_version: 'aaa111222333',
    cloud_version: 'bbb444555666',
    conflict_type: 'version_divergence',
    jev_recommendation: {
      verdict: 'needs_human_review',
      rationale: 'Detected by Phase 9 version reconciliation: edge and cloud hold divergent versions of the same knowledge. No JEV recommendation has been computed yet — resolution (JEV-recommended, human-confirmed) is Phase 10.',
    },
    status: 'open',
    resolution: '',
    resolved_by: '',
  };
  cloudConflicts.upsertPoints([{ id: conflict.conflict_id, vector: [1], payload: { ...conflict } }]);
  return conflict;
}

test('conflict resolution: recommendation attaches to the SAME record, status stays open', async () => {
  const { cloudConflicts, gate } = makeJevWorld();
  const original = seedConflict(cloudConflicts);

  const jevRecord = {
    verdict_id: 'jevc-c1', memory_id: 'mem-m204', stage: 'cloud', verdict: 'validated',
    rationale: 'Cloud v5 agrees with the master doc; the edge v4 contradicts it.',
    confidence: 0.85, risk_flags: [], evidence_used: [], model_used: 'm',
    evaluated_at: '2026-09-29T15:00:00.000Z',
  };
  const updated = await gate.recommendConflictResolution(
    'cfl-test-1',
    { verdict: 'adopt_cloud', rationale: 'Cloud v5 matches the authoritative M-204 rev 5; the edge v4 field edit is superseded.' },
    jevRecord
  );
  // Same identity, no dropped fields, recommendation REPLACED in place.
  assert.equal(updated.conflict_id, original.conflict_id);
  assert.equal(updated.memory_id, original.memory_id);
  assert.equal(updated.edge_version, original.edge_version);
  assert.equal(updated.cloud_version, original.cloud_version);
  assert.equal(updated.conflict_type, original.conflict_type);
  assert.equal(updated.status, 'open', 'JEV NEVER auto-applies: status stays open');
  assert.equal(updated.jev_recommendation.verdict, 'adopt_cloud');
  assert.match(updated.jev_recommendation.rationale, /Cloud v5/);
  assert.equal(updated.resolved_by, '', 'no human confirmation yet');

  // The record in the store is the same object, updated in place.
  const stored = await gate.getConflict('cfl-test-1');
  assert.equal(stored.status, 'open');
  assert.equal(stored.jev_recommendation.verdict, 'adopt_cloud');
});

test('conflict resolution: confirmation is a SEPARATE explicit human action; without it status never resolves', async () => {
  const { cloudConflicts, gate } = makeJevWorld();
  seedConflict(cloudConflicts);
  const jevRecord = {
    verdict_id: 'jevc-c2', memory_id: 'mem-m204', stage: 'cloud', verdict: 'validated',
    rationale: 'recommendation backing', confidence: 0.8, risk_flags: [], evidence_used: [], model_used: 'm',
    evaluated_at: '2026-09-29T15:00:00.000Z',
  };
  await gate.recommendConflictResolution('cfl-test-1', { verdict: 'adopt_cloud', rationale: 'Cloud v5 is the fleet-correct version.' }, jevRecord);

  // Even WITH a recommendation, nothing auto-resolves:
  const stillOpen = await gate.getConflict('cfl-test-1');
  assert.equal(stillOpen.status, 'open');

  // A human must explicitly confirm — and only then does status move.
  const resolved = await gate.confirmConflictResolution('cfl-test-1', {
    resolvedBy: 'fleet-engineer-kim',
    winner: 'cloud',
    resolution: 'Adopted cloud v5 (matches M-204 rev 5); edge device re-provisioned.',
  });
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.resolved_by, 'fleet-engineer-kim');
  assert.equal(resolved.resolution_winner, 'cloud');
  const after = await gate.listOpenConflictsSafe?.() ?? [];
  void after;
});

test('conflict resolution: confirm REFUSES a conflict with only the Phase 9 placeholder recommendation', async () => {
  const { cloudConflicts, gate } = makeJevWorld();
  seedConflict(cloudConflicts); // has the Phase 9 "no recommendation yet" placeholder
  await assert.rejects(
    gate.confirmConflictResolution('cfl-test-1', { resolvedBy: 'h', winner: 'edge', resolution: 'r' }),
    /no Cloud JEV recommendation yet/
  );
  const still = await gate.getConflict('cfl-test-1');
  assert.equal(still.status, 'open', 'nothing auto-applied');
});

test('conflict resolution: double-confirm and confirm-without-recommendation are refused', async () => {
  const { cloudConflicts, gate } = makeJevWorld();
  seedConflict(cloudConflicts);
  const jevRecord = {
    verdict_id: 'jevc-c3', memory_id: 'm', stage: 'cloud', verdict: 'validated',
    rationale: 'r', confidence: 0.7, risk_flags: [], evidence_used: [], model_used: 'm',
    evaluated_at: '2026-09-29T15:00:00.000Z',
  };
  await gate.recommendConflictResolution('cfl-test-1', { verdict: 'adopt_edge', rationale: 'Edge v4 reflects field reality.' }, jevRecord);
  await gate.confirmConflictResolution('cfl-test-1', { resolvedBy: 'kim', winner: 'edge', resolution: 'Edge kept.' });
  await assert.rejects(
    gate.confirmConflictResolution('cfl-test-1', { resolvedBy: 'again', winner: 'cloud', resolution: 'change my mind' }),
    /already resolved/
  );
  await assert.rejects(gate.recommendConflictResolution('cfl-test-1', { verdict: 'x', rationale: 'y' }, jevRecord), /not open/);
  await assert.rejects(gate.confirmConflictResolution('cfl-missing', { resolvedBy: 'k', winner: 'edge', resolution: 'r' }), /not found/);
  void cloudConflicts;
});
