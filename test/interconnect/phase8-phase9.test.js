'use strict';

/**
 * Interconnection tests for Phase 8 ↔ Phase 9: the delta package produced
 * by Phase 8's sync flow is fed DIRECTLY into Phase 9's reconciler.
 *
 *   - a normal, non-conflicting synced observation from Phase 8 completes
 *     cleanly — never incorrectly flagged as a conflict;
 *   - a genuine conflict fixture is correctly caught (DIVERGED → open
 *     Conflict, withheld from upload, neither side overwritten).
 *
 * All offline via the shared fakes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryStore } from '../../edge/memoryStore.js';
import { createMemoryOrchestrator } from '../../edge/orchestrator.js';
import { createSyncEngine, createInMemoryLedger, fingerprintMemory } from '../../edge/syncEngine.js';
import { createCloudSyncIngest } from '../../cloud/sync.js';
import { createReconciler } from '../../edge/reconciliation.js';
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
  QDRANT_CLOUD_CONFLICT_COLLECTION: 'aeroedge_cloud_conflicts',
});

function makeWorld(verdicts) {
  const scripted = makeScriptedJev(
    verdicts ?? [jevResponse({ verdict: 'accept_local', rationale: 'consistent', confidence: 0.8 })]
  );
  const ollama = makeFakeOllama();
  ollama.generate = async ({ prompt }) => scripted.respond({ prompt });

  const edgeMemories = makeFakeQdrant({ collection: 'aeroedge_edge_memories' });
  const edgeDocs = makeFakeQdrant({ collection: 'aeroedge_edge_docs' });
  const cloudMemories = makeFakeQdrant({ collection: 'aeroedge_cloud_memories' });
  const cloudSync = makeFakeQdrant({ collection: 'aeroedge_cloud_sync_events' });
  const cloudConflicts = makeFakeQdrant({ collection: 'aeroedge_cloud_conflicts' });

  const memoryStore = createMemoryStore({ config: CONFIG, qdrant: edgeMemories });
  const orchestrator = createMemoryOrchestrator({ config: CONFIG, memoryStore, ollama, qdrant: edgeDocs });
  const ledger = createInMemoryLedger();
  const syncEngine = createSyncEngine({ memoryStore, ledger, deviceId: 'device-01' });
  const cloud = createCloudSyncIngest({ config: CONFIG, cloudMemories, cloudSyncEvents: cloudSync });
  const reconciler = createReconciler({ memoryStore, ledger, cloudMemories, cloudConflicts });
  return { edgeMemories, cloudMemories, cloudSync, cloudConflicts, memoryStore, orchestrator, ledger, syncEngine, cloud, reconciler };
}

test('interconnect: a normal Phase 8 observation flows capture → delta → reconcile → cloud with NO conflict flag', async () => {
  const { cloudMemories, memoryStore, cloudConflicts, orchestrator, syncEngine, cloud, reconciler } = makeWorld();

  // Phase 4/5: capture an important, consistent observation (routes SYNC).
  const result = await orchestrator.captureAndRoute({
    content: 'Hydraulic system B held 2900-3100 PSI through the full test cycle.',
    assetId: 'MSN4453',
    source: 'technician-jane',
    importance: 0.85,
  });
  assert.equal(result.applied?.action, 'SYNC');

  // Phase 8: build the REAL delta from the REAL store.
  const pkg = await syncEngine.buildDelta();
  assert.equal(pkg.items.length, 1);

  // Phase 9: reconcile — with the CLOUD ingest as the target. The classify
  // step must see EDGE_NEW (cloud has no copy), not DIVERGED.
  const classification = await reconciler.classifyDelta(pkg);
  assert.equal(classification.items[0].kase, 'EDGE_NEW', 'a fresh synced observation is edge-new, NOT a conflict');

  const outcome = await reconciler.reconcileDelta(pkg, (upload) => cloud.ingestDelta(upload));
  assert.equal(outcome.conflicts, 0, 'NEVER incorrectly flagged as a conflict');
  assert.equal(outcome.uploaded, 1);
  assert.equal(outcome.adopted, 0);
  assert.equal(outcome.deduped, 0);

  // The observation is in the cloud; edge is synced; no conflicts anywhere.
  const cloudHits = await cloudMemories.scrollWithFilter(
    { must: [{ key: 'memory_id', match: { value: result.memory.memory_id } }] },
    { limit: 5 }
  );
  assert.equal(cloudHits.length, 1);
  const stored = await memoryStore.getMemory(result.memory.memory_id);
  assert.equal(stored.lifecycle_status, 'synced');
  assert.equal(cloudConflicts.size(), 0, 'zero Conflict records for a clean sync');

  // Reconciling the same state again is a no-op (acked, deduped-clean).
  const again = await reconciler.reconcileDelta(await syncEngine.buildDelta(), (u) => cloud.ingestDelta(u));
  assert.equal(again.uploaded, 0);
  assert.equal(again.conflicts, 0);
});

test('interconnect: a genuine divergence inside a REAL Phase 8 flow is caught, withheld, and recorded', async () => {
  const { cloudMemories, cloudConflicts, memoryStore, ledger, orchestrator, syncEngine, cloud, reconciler } = makeWorld();

  // Round 1: sync a normal observation to the cloud (establishes the ancestor).
  const base = await orchestrator.captureAndRoute({
    content: 'Inlet B-nut torque verified at 45 N·m.',
    assetId: 'MSN4453',
    source: 'technician-jane',
    importance: 0.85,
  });
  // The composed Phase 8 → Phase 9 pipeline: delta → reconcile → ingest.
  const pkg1 = await syncEngine.buildDelta();
  await reconciler.reconcileDelta(pkg1, (u) => cloud.ingestDelta(u));
  const cloudCopy = await cloudMemories.scrollWithFilter(
    { must: [{ key: 'memory_id', match: { value: base.memory.memory_id } }] },
    { limit: 2 }
  );
  assert.equal(cloudCopy.length, 1, 'ancestor synced to cloud');

  // DIVERGENCE: the cloud copy is edited cloud-side (fleet correction) while
  // the edge records a NEW revision of the same memory lineage (offline edit).
  const cloudEdited = { ...cloudCopy[0].payload, content: 'FLEET EDIT: inlet B-nut torque is 47 N·m per fleet bulletin.', updated_at: '2026-09-29T14:00:00.000Z' };
  await cloudMemories.upsertPoints([{ id: cloudEdited.memory_id, vector: [1], payload: cloudEdited }]);

  const edgeRevised = {
    ...(await memoryStore.getMemory(base.memory.memory_id)),
    content: 'EDGE EDIT: inlet B-nut torque measured effective at 44 N·m in cold conditions.',
    version: '2',
    revision_of: base.memory.memory_id,
    updated_at: '2026-09-29T13:30:00.000Z',
  };
  await memoryStore.putMemory(edgeRevised);

  // Phase 8 detects the edge change; Phase 9 must classify DIVERGED and act.
  const pkg2 = await syncEngine.buildDelta();
  const item = pkg2.items.find((i) => i.memoryId === base.memory.memory_id);
  assert.ok(item, 'the edge revision is a real change');
  void ledger;

  const outcome = await reconciler.reconcileDelta(pkg2, (u) => cloud.ingestDelta(u));
  assert.equal(outcome.conflicts, 1, 'genuine conflict CAUGHT');
  assert.equal(outcome.uploaded, 0, 'edge revision WITHHELD (cloud not overwritten)');

  // Open Conflict record: references the memory, cites both fingerprints.
  const open = await reconciler.listOpenConflicts({ memoryId: base.memory.memory_id });
  assert.equal(open.length, 1);
  assert.equal(open[0].status, 'open');
  assert.equal(open[0].conflict_type, 'version_divergence');
  assert.notEqual(open[0].edge_version, open[0].cloud_version);
  void fingerprintMemory;
  void cloudConflicts;
});
