'use strict';

/**
 * Interconnection tests for Phase 5 ↔ Phase 8: the Edge JEV verdict
 * attached to each memory (Phase 5) drives sync eligibility (Phase 8),
 * exactly per the Orchestrator table:
 *
 *   - a flag_risk memory IS sync-eligible and APPEARS in the delta package,
 *     tagged high-visibility (a human must see it; never auto-propagatable);
 *   - a needs_more_evidence memory MUST NOT appear in the sync-eligible
 *     delta at all;
 *   - both flow through captureAndRoute → syncNow → cloud with their
 *     verdicts intact and SyncEvents recorded.
 *
 * All offline via the shared fakes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryOrchestrator } from '../../edge/orchestrator.js';
import { createMemoryStore } from '../../edge/memoryStore.js';
import { createSyncEngine, createInMemoryLedger } from '../../edge/syncEngine.js';
import { createCloudSyncIngest } from '../../cloud/sync.js';
import { makeFakeOllama, makeFakeQdrant, jevResponse, makeScriptedJev } from '../helpers/fakes.js';

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

/**
 * Full Phase 4+5+8 world: real capture + Edge JEV verdicts (scripted),
 * verdict-driven routing, sync engine, cloud ingest.
 * @param {{ verdict: string, rationale: string, confidence?: number, risk_flags?: string[] }[]} verdicts
 */
function makeWorld(verdicts) {
  const ollama = makeFakeOllama();
  const scripted = makeScriptedJev(
    verdicts ?? [jevResponse({ verdict: 'accept_local', rationale: 'ok', confidence: 0.7 })]
  );
  ollama.generate = async ({ prompt }) => scripted.respond({ prompt });

  const edgeMemories = makeFakeQdrant({ collection: 'aeroedge_edge_memories' });
  const edgeDocs = makeFakeQdrant({ collection: 'aeroedge_edge_docs' });
  const cloudMemories = makeFakeQdrant({ collection: 'aeroedge_cloud_memories' });
  const cloudSync = makeFakeQdrant({ collection: 'aeroedge_cloud_sync_events' });

  const memoryStore = createMemoryStore({ config: CONFIG, qdrant: edgeMemories });
  const orchestrator = createMemoryOrchestrator({
    config: CONFIG,
    memoryStore,
    ollama,
    qdrant: edgeDocs,
  });
  const syncEngine = createSyncEngine({ memoryStore, deviceId: 'interconnect-edge' });
  const cloud = createCloudSyncIngest({ config: CONFIG, cloudMemories, cloudSyncEvents: cloudSync });
  return { edgeMemories, edgeDocs, cloudMemories, cloudSync, memoryStore, orchestrator, syncEngine, cloud };
}

test('flag_risk memory from Edge JEV IS sync-eligible: appears in the delta tagged high-visibility, reaches cloud', async () => {
  const { cloudMemories, memoryStore, orchestrator, syncEngine, cloud } = makeWorld([
    jevResponse({
      verdict: 'flag_risk',
      rationale: 'Contradicts the torque spec in excerpt 1 — safety-critical.',
      confidence: 0.8,
      risk_flags: ['safety_critical_conflict', 'torque_spec_conflict'],
    }),
  ]);

  // Phase 5: an observation that contradicts authoritative knowledge.
  const result = await orchestrator.captureAndRoute({
    content: 'Tightened the B-nut to 90 N·m — far past the spec, seats better.',
    assetId: 'MSN4453',
    source: 'technician-jane',
    importance: 0.6,
  });
  assert.equal(result.recorded, true);
  assert.equal(result.verdict.verdict, 'flag_risk');
  assert.equal(result.applied.action, 'KEEP_LOCAL', 'routed KEEP_LOCAL, high-visibility');

  // Phase 8: it IS in the sync-eligible delta, tagged high-visibility.
  const pkg = await syncEngine.buildDelta();
  assert.equal(pkg.items.length, 1, 'the flagged memory is sync-eligible per the Orchestrator table');
  const item = pkg.items[0];
  assert.equal(item.memoryId, result.memory.memory_id);
  assert.equal(item.edgeJevVerdict, 'flag_risk');
  assert.equal(item.highVisibility, true, 'EXPLICIT: flagged memory tagged high-visibility in the delta');
  assert.equal(item.operation, 'create');

  // And it reaches the cloud through the real flow.
  const syncResult = await syncEngine.syncNow((p) => cloud.ingestDelta(p));
  assert.equal(syncResult.synced, 1);
  const cloudHits = await cloudMemories.scrollWithFilter(
    { must: [{ key: 'memory_id', match: { value: result.memory.memory_id } }] },
    { limit: 5 }
  );
  assert.equal(cloudHits.length, 1, 'flagged memory IS in the cloud (a human must see it)');
  assert.equal(cloudHits[0].payload.jev_status, 'flag_risk', 'verdict travels to the cloud intact');

  // The audit trail agrees.
  const events = await cloud.listSyncEvents({ memoryId: result.memory.memory_id });
  assert.equal(events.length, 1);

  // Phase 5 hard rule still holds on the edge record.
  const stored = await memoryStore.getMemory(result.memory.memory_id);
  assert.equal(stored.jev_status, 'flag_risk', 'still flagged after sync');
});

test('needs_more_evidence memory MUST NOT appear in the sync-eligible delta at all (explicit assertion)', async () => {
  const { cloudMemories, memoryStore, orchestrator, syncEngine, cloud } = makeWorld([
    jevResponse({
      verdict: 'needs_more_evidence',
      rationale: 'The observation is too thin to accept or flag.',
      confidence: 0.3,
    }),
  ]);

  const result = await orchestrator.captureAndRoute({
    content: 'Something seemed slightly off somewhere maybe.',
    assetId: 'MSN4453',
    source: 'technician-jane',
    importance: 0.95, // would be sync-worthy if eligibility ignored the verdict
  });
  assert.equal(result.verdict.verdict, 'needs_more_evidence');

  // THE explicit assertion: not in the delta, at any importance.
  const pkg = await syncEngine.buildDelta();
  assert.equal(
    pkg.items.some((i) => i.memoryId === result.memory.memory_id),
    false,
    'needs_more_evidence MUST NOT appear in the sync-eligible delta'
  );
  assert.equal(pkg.items.length, 0);

  // The real flow confirms: nothing synced, nothing in the cloud, no event.
  const syncResult = await syncEngine.syncNow((p) => cloud.ingestDelta(p));
  assert.equal(syncResult.synced, 0);
  const cloudHits = await cloudMemories.scrollWithFilter(
    { must: [{ key: 'memory_id', match: { value: result.memory.memory_id } }] },
    { limit: 5 }
  );
  assert.equal(cloudHits.length, 0, 'under-evidenced knowledge never reaches the cloud');
  const events = await cloud.listSyncEvents({ memoryId: result.memory.memory_id });
  assert.equal(events.length, 0, 'no SyncEvent for a never-synced memory');

  // The edge record is untouched by the whole round trip.
  const stored = await memoryStore.getMemory(result.memory.memory_id);
  assert.equal(stored.jev_status, 'needs_more_evidence');
  assert.equal(stored.lifecycle_status, 'local');
});

test('accept_local ≥ 0.7 rides the delta; below-threshold accept_local does not (table complete)', async () => {
  const { memoryStore, orchestrator, syncEngine } = makeWorld([
    jevResponse({ verdict: 'accept_local', rationale: 'consistent', confidence: 0.8 }),
  ]);
  const high = await orchestrator.captureAndRoute({
    content: 'Thermal relief valve cycled at 3400 PSI as documented.',
    assetId: 'MSN4453',
    source: 'technician-jane',
    importance: 0.85,
  });
  const low = await orchestrator.captureObservation({
    content: 'Minor paint chipping on access panel 4L.',
    assetId: 'MSN4453',
    source: 'technician-jane',
    importance: 0.4,
  });
  const decision = await orchestrator.routeWithVerdict(low);
  await orchestrator.applyRoute(decision);

  const pkg = await syncEngine.buildDelta();
  const ids = pkg.items.map((i) => i.memoryId);
  assert.ok(ids.includes(high.memory.memory_id), 'importance ≥ 0.7 accept_local is sync-eligible');
  assert.ok(!ids.includes(low.memory_id), 'below-threshold accept_local is not (KEEP_LOCAL row)');
  assert.equal(high.applied?.action, 'SYNC');
  void memoryStore;
});

test('full table in ONE delta: flagged tagged, accepted synced, under-evidenced excluded — deterministically', async () => {
  const { memoryStore, orchestrator, syncEngine } = makeWorld([
    jevResponse({ verdict: 'accept_local', rationale: 'fine', confidence: 0.7 }),
    jevResponse({ verdict: 'flag_risk', rationale: 'risky', confidence: 0.7, risk_flags: ['safety_critical_conflict'] }),
    jevResponse({ verdict: 'needs_more_evidence', rationale: 'thin', confidence: 0.3 }),
  ]);
  // Capture in mixed order; the delta must still come out sorted and
  // eligibility-filtered per the table.
  const accepted = await orchestrator.captureAndRoute({
    content: 'Breather cap re-torqued to spec after B-check.', assetId: 'MSN4453', source: 'j', importance: 0.9,
  });
  const flagged = await orchestrator.captureAndRoute({
    content: 'Bypassed the interlock to reset the fault faster.', assetId: 'MSN4453', source: 'j', importance: 0.5,
  });
  await orchestrator.captureAndRoute({
    content: 'Noise near panel 2R sometimes.', assetId: 'MSN4453', source: 'j',
  });

  const pkg = await syncEngine.buildDelta();
  const ids = pkg.items.map((i) => i.memoryId);
  assert.deepEqual(ids, [accepted.memory.memory_id, flagged.memory.memory_id].sort(), 'exactly accepted + flagged, sorted');
  const flagItem = pkg.items.find((i) => i.memoryId === flagged.memory.memory_id);
  assert.equal(flagItem.highVisibility, true);
  void memoryStore;
});
