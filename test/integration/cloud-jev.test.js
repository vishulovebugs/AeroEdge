'use strict';

/**
 * LIVE integration tests for Phase 10 — matches the acceptance criteria:
 *
 *   1. Two edge devices independently upload similar observations about the
 *      same asset/component; the second upload triggers JOINT evaluation
 *      (fleet context now contains the first device's observation) and
 *      produces a `validated` verdict whose rationale cites corroboration.
 *   2. A third, unrelated, low-evidence observation is routed to
 *      `needs_human_review` instead of auto-propagating.
 *   3. Conflict resolution: Cloud JEV attaches a recommendation + rationale
 *      to an M-204-style Phase 9 conflict, and the system does NOT apply it
 *      automatically — a separate explicit confirmation is required for
 *      status "resolved".
 *
 * Skips cleanly when Qdrant/Ollama endpoints are unreachable (see the
 * header of test/integration/rag.test.js for setup). Uses the LIVE Ollama
 * model — the corroboration scenario is exactly what it is for.
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
const cloudUp = loaded.config ? await isUp(`${loaded.config.QDRANT_CLOUD_URL}/collections`) : false;
const ollamaUp = loaded.config ? await isUp(`${loaded.config.OLLAMA_BASE_URL}/api/tags`) : false;
const SKIP = Boolean(loaded.error) || !cloudUp || !ollamaUp;
const SKIP_REASON = loaded.error
  ? `${loaded.error.message} — see the header of test/integration/rag.test.js for setup instructions.`
  : `Qdrant Cloud or Ollama not reachable (cloud: ${cloudUp}, ollama: ${ollamaUp}) — start both to run this test.`;

const ASSET = 'MSN4453';
const TRACKED = { memories: [], masterDocs: [], conflicts: [], queueIds: [], verdictIds: [] };

function trackMemory(id) { TRACKED.memories.push(id); }

async function cleanup() {
  if (!loaded.config) return;
  const { createQdrantClient } = await import('../../edge/qdrant.js');
  const mk = (collection) => createQdrantClient({ baseUrl: loaded.config.QDRANT_CLOUD_URL, collection });
  const memories = mk(loaded.config.QDRANT_CLOUD_MEMORY_COLLECTION);
  const docs = mk(loaded.config.QDRANT_CLOUD_COLLECTION);
  const conflicts = mk(loaded.config.QDRANT_CLOUD_CONFLICT_COLLECTION);
  const review = mk(loaded.config.QDRANT_CLOUD_REVIEW_COLLECTION);
  const verdicts = mk('aeroedge_cloud_verdicts');
  for (const id of TRACKED.memories) await memories.deleteByIds([id]);
  for (const id of TRACKED.masterDocs) await docs.deleteByDocument(id);
  if (TRACKED.conflicts.length > 0) await conflicts.deleteByIds(TRACKED.conflicts);
  if (TRACKED.queueIds.length > 0) await review.deleteByIds(TRACKED.queueIds);
  if (TRACKED.verdictIds.length > 0) await verdicts.deleteByIds(TRACKED.verdictIds);
}

/** Ingest the shared master doc once (authoritative context for all tests). */
async function ingestMasterDoc(cloud) {
  const res = await cloud.ingestDocument({
    documentId: 'ent-std-jev10',
    text:
      'Enterprise standard for ' + ASSET + ' hydraulic system B: the pump inlet line B-nut is torqued to 45 N·m ' +
      'and safety-wired. Seepage below 40 N·m indicates gasket wear; replace the gasket before re-torquing ' +
      '(fictional enterprise fixture).',
    assetId: ASSET,
    component: 'hydraulics',
    source: 'Enterprise engineering standard rev 12 (test fixture)',
    version: '12',
    docType: 'standard',
  });
  TRACKED.masterDocs.push('ent-std-jev10');
  return res;
}

/** Persist a memory into the cloud memory collection the way Phase 8 sync does. */
async function seedCloudMemory(memoriesClient, m) {
  await memoriesClient.upsertPoints([{ id: m.memory_id, vector: [1], payload: { ...m } }]);
  trackMemory(m.memory_id);
}

test('acceptance live: second device upload triggers joint evaluation → validated citing corroboration; third low-evidence → review', async (t) => {
  if (SKIP) {
    t.skip(SKIP_REASON);
    return;
  }
  const { createCloudKnowledge } = await import('../../cloud/knowledge.js');
  const { createCloudJev } = await import('../../cloud/jevCloud.js');
  const { createFleetGate, canPropagate } = await import('../../cloud/propagation.js');
  const { createQdrantClient } = await import('../../edge/qdrant.js');
  const { createOllamaClient } = await import('../../edge/ollama.js');

  const cloud = createCloudKnowledge({ config: loaded.config });
  await ingestMasterDoc(cloud);

  const ollama = createOllamaClient({
    baseUrl: loaded.config.OLLAMA_BASE_URL,
    embedModel: loaded.config.EMBEDDING_MODEL,
    generateModel: loaded.config.OLLAMA_MODEL,
  });
  const cloudMemories = createQdrantClient({ baseUrl: loaded.config.QDRANT_CLOUD_URL, collection: loaded.config.QDRANT_CLOUD_MEMORY_COLLECTION });
  const cloudDocs = createQdrantClient({ baseUrl: loaded.config.QDRANT_CLOUD_URL, collection: loaded.config.QDRANT_CLOUD_COLLECTION });
  const cloudVerdicts = createQdrantClient({ baseUrl: loaded.config.QDRANT_CLOUD_URL, collection: 'aeroedge_cloud_verdicts' });
  const cloudReview = createQdrantClient({ baseUrl: loaded.config.QDRANT_CLOUD_URL, collection: loaded.config.QDRANT_CLOUD_REVIEW_COLLECTION });
  const cloudJev = createCloudJev({ config: loaded.config, ollama, cloudMemories, cloudDocs, cloudVerdicts });
  const gate = createFleetGate({ cloudMemories, cloudReview, cloudConflicts: createQdrantClient({ baseUrl: loaded.config.QDRANT_CLOUD_URL, collection: loaded.config.QDRANT_CLOUD_CONFLICT_COLLECTION }) });

  // DEVICE 1 uploads its observation (synced, not yet fleet-trusted).
  const device1 = {
    memory_id: 'mem-j10-device1',
    memory_type: 'field_observation',
    content: ASSET + ' hydraulic system B: found the inlet line B-nut seeping below 40 N·m; gasket showed wear marks.',
    asset_id: ASSET,
    source: 'technician-jane (device-1)',
    version: '1', importance: 0.8, confidence: 0.6,
    created_at: '2026-09-29T08:00:00.000Z', updated_at: '2026-09-29T08:00:00.000Z',
    sync_status: 'synced', lifecycle_status: 'synced', jev_status: 'accept_local',
  };
  await seedCloudMemory(cloudMemories, device1);

  // DEVICE 2 — INDEPENDENTLY — records the same finding (second upload).
  const device2 = {
    memory_id: 'mem-j10-device2',
    memory_type: 'field_observation',
    content: ASSET + ' system B: during scheduled check, inlet B-nut showed seepage under 40 N·m and the gasket is worn.',
    asset_id: ASSET,
    source: 'technician-raj (device-2)',
    version: '1', importance: 0.8, confidence: 0.6,
    created_at: '2026-09-29T09:00:00.000Z', updated_at: '2026-09-29T09:00:00.000Z',
    sync_status: 'synced', lifecycle_status: 'synced', jev_status: 'accept_local',
  };

  // The SECOND upload triggers the joint Cloud Pass evaluation.
  const context = await cloudJev.gatherFleetContext(device2);
  assert.ok(
    context.fleetObservations.some((o) => o.memoryId === device1.memory_id),
    'fleet context contains device 1\u2019s observation — the pair is evaluated TOGETHER'
  );
  const result2 = await cloudJev.evaluateMemory(device2);
  const record2 = cloudJev.verdictRecord(result2, device2.memory_id);
  await cloudJev.persistVerdict(record2);
  TRACKED.verdictIds.push(record2.verdict_id);
  const applied2 = await gate.applyCloudVerdict(record2, device2);
  trackMemory(device2.memory_id);

  // ACCEPTANCE: the pair evaluated together produces `validated` whose
  // rationale cites corroboration — and the gate lets it propagate.
  assert.equal(result2.verdict, 'validated', `rationale was: ${result2.rationale}`);
  assert.match(result2.rationale, /corroborat/i, 'the rationale CITES corroboration');
  assert.equal(applied2.action, 'propagate');
  assert.equal(canPropagate(result2.verdict), true);
  const propagated = await cloudMemories.scrollWithFilter(
    { must: [{ key: 'memory_id', match: { value: device2.memory_id } }] }, { limit: 2 }
  );
  assert.equal(propagated[0].payload.jev_status, 'validated', 'fleet-trusted in the cloud store');

  // THIRD observation: unrelated, low-evidence, single device → review, NOT auto-propagation.
  const device3 = {
    memory_id: 'mem-j10-device3',
    memory_type: 'field_observation',
    content: 'Galley coffee maker on some aircraft sometimes runs a bit slow.',
    asset_id: 'VARIOUS',
    source: 'technician-sam (device-3)',
    version: '1', importance: 0.3, confidence: 0.3,
    created_at: '2026-09-29T09:30:00.000Z', updated_at: '2026-09-29T09:30:00.000Z',
    sync_status: 'synced', lifecycle_status: 'synced', jev_status: 'accept_local',
  };
  const result3 = await cloudJev.evaluateMemory(device3);
  const record3 = cloudJev.verdictRecord(result3, device3.memory_id);
  TRACKED.verdictIds.push(record3.verdict_id);
  const applied3 = await gate.applyCloudVerdict(record3, device3);
  trackMemory(device3.memory_id);

  assert.equal(result3.verdict, 'needs_human_review', 'unrelated low-evidence observation is NOT auto-validated');
  assert.equal(applied3.action, 'review');
  assert.equal(canPropagate(result3.verdict), false, 'blocked by the gate');
  const queue = await gate.listReviewQueue();
  assert.ok(queue.some((e) => e.memory_id === device3.memory_id), 'routed to the human-review queue');
  if (applied3.queueId) TRACKED.queueIds.push(applied3.queueId);
});

test('conflict resolution live: JEV recommends on the SAME M-204 record; nothing auto-applies; human confirms', async (t) => {
  if (SKIP) {
    t.skip(SKIP_REASON);
    return;
  }
  const { createFleetGate } = await import('../../cloud/propagation.js');
  const { createCloudJev } = await import('../../cloud/jevCloud.js');
  const { createQdrantClient } = await import('../../edge/qdrant.js');
  const { createOllamaClient } = await import('../../edge/ollama.js');
  const { createCloudKnowledge } = await import('../../cloud/knowledge.js');

  const cloud = createCloudKnowledge({ config: loaded.config });
  await ingestMasterDoc(cloud);
  const ollama = createOllamaClient({
    baseUrl: loaded.config.OLLAMA_BASE_URL,
    embedModel: loaded.config.EMBEDDING_MODEL,
    generateModel: loaded.config.OLLAMA_MODEL,
  });
  const cloudConflicts = createQdrantClient({ baseUrl: loaded.config.QDRANT_CLOUD_URL, collection: loaded.config.QDRANT_CLOUD_CONFLICT_COLLECTION });
  const cloudMemories = createQdrantClient({ baseUrl: loaded.config.QDRANT_CLOUD_URL, collection: loaded.config.QDRANT_CLOUD_MEMORY_COLLECTION });
  const cloudDocs = createQdrantClient({ baseUrl: loaded.config.QDRANT_CLOUD_URL, collection: loaded.config.QDRANT_CLOUD_COLLECTION });
  const cloudVerdicts = createQdrantClient({ baseUrl: loaded.config.QDRANT_CLOUD_URL, collection: 'aeroedge_cloud_verdicts' });
  const cloudReview = createQdrantClient({ baseUrl: loaded.config.QDRANT_CLOUD_URL, collection: loaded.config.QDRANT_CLOUD_REVIEW_COLLECTION });
  const gate = createFleetGate({ cloudMemories, cloudReview, cloudConflicts });
  const cloudJev = createCloudJev({ config: loaded.config, ollama, cloudMemories, cloudDocs, cloudVerdicts });

  // The exact Phase 9-style conflict, seeded as Phase 9 stores it.
  const conflict = {
    conflict_id: 'cfl-j10-live',
    memory_id: 'mem-m204-live',
    edge_version: 'aaa111222333',
    cloud_version: 'bbb444555666',
    conflict_type: 'version_divergence',
    jev_recommendation: {
      verdict: 'needs_human_review',
      rationale: 'Detected by Phase 9 version reconciliation: edge and cloud hold divergent versions. No JEV recommendation has been computed yet — resolution (JEV-recommended, human-confirmed) is Phase 10.',
    },
    status: 'open',
    resolution: '',
    resolved_by: '',
  };
  await cloudConflicts.upsertPoints([{ id: conflict.conflict_id, vector: [1], payload: { ...conflict } }]);
  TRACKED.conflicts.push(conflict.conflict_id);

  // The two competing versions as memories (for the Cloud Pass context).
  const edgeV4 = {
    memory_id: 'mem-m204-live', memory_type: 'field_observation',
    content: 'Manual M-204: pump overhaul interval 2500 h (field-confirmed).',
    asset_id: 'FLEET-STANDARD', source: 'device-1', version: '4', importance: 0.9, confidence: 0.6,
    created_at: '2026-09-29T10:00:00.000Z', updated_at: '2026-09-29T10:00:00.000Z',
    sync_status: 'local', lifecycle_status: 'used', jev_status: 'accept_local',
  };
  await seedCloudMemory(cloudMemories, edgeV4);

  // Cloud JEV produces the recommendation (+ backing verdict record).
  const recResult = await cloudJev.evaluateMemory(edgeV4);
  const recRecord = cloudJev.verdictRecord(recResult, edgeV4.memory_id);
  TRACKED.verdictIds.push(recRecord.verdict_id);
  const updated = await gate.recommendConflictResolution(
    conflict.conflict_id,
    { verdict: recResult.verdict === 'validated' ? 'adopt_edge' : 'adopt_cloud', rationale: recResult.rationale },
    recRecord
  );

  // SAME record: identity + fields preserved, recommendation populated.
  assert.equal(updated.conflict_id, conflict.conflict_id);
  assert.equal(updated.edge_version, conflict.edge_version);
  assert.equal(updated.cloud_version, conflict.cloud_version);
  assert.equal(updated.conflict_type, conflict.conflict_type);
  assert.equal(updated.status, 'open', 'NOT auto-applied');

  // Assert the system does NOT apply it automatically: still open after time passes.
  const stillOpen = await gate.getConflict(conflict.conflict_id);
  assert.equal(stillOpen.status, 'open');

  // The separate explicit human confirmation is what resolves it.
  const resolved = await gate.confirmConflictResolution(conflict.conflict_id, {
    resolvedBy: 'fleet-engineer-live',
    winner: 'cloud',
    resolution: 'Confirmed: adopt the cloud version per the Cloud JEV recommendation.',
  });
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.resolved_by, 'fleet-engineer-live');
});
