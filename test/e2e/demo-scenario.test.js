'use strict';

/**
 * Phase 11 END-TO-END demo scenario — the Section-14 acceptance run,
 * headless: it starts the real Phase 11 API server (server/app.js) with
 * every subsystem from Phases 1–10 injected as in-memory fakes, and drives
 * EXACTLY the endpoints the browser UI calls. No browser, no network
 * beyond loopback, no manual data patching.
 *
 * The scenario, with the status transition asserted at EVERY step:
 *
 *   1.  connect + provision the edge device from the enterprise store
 *   2.  disconnect — the device is now fully offline
 *   3.  offline grounded query: answer cites provisioned sources
 *   4.  session follow-up: elliptical query resolves via context
 *   5.  record a field observation — Edge JEV verdict visible immediately
 *   6.  Memory Orchestrator routes it (verdict-driven, stored lifecycle)
 *   7.  reconnect + delta sync (Phase 8+9 classify → reconcile → ingest)
 *   8.  Cloud JEV pass: fleet-context verdict visible → gate propagates
 *   9.  diverged versions → OPEN Conflict + JEV recommendation (nothing applied)
 *   10. explicit human confirmation — the ONLY path to resolved
 *   11. fleet propagation state: validated shareable, everything else held
 *   12. needs_human_review queued — never auto-propagated
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../../shared/config.js';
import { createRagPipeline } from '../../edge/rag.js';
import { createSession } from '../../edge/session.js';
import { createMemoryStore } from '../../edge/memoryStore.js';
import { createMemoryOrchestrator } from '../../edge/orchestrator.js';
import { createSyncEngine } from '../../edge/syncEngine.js';
import { createReconciler } from '../../edge/reconciliation.js';
import { createCloudKnowledge } from '../../cloud/knowledge.js';
import { createProvisioning } from '../../cloud/provisioning.js';
import { createCloudSyncIngest } from '../../cloud/sync.js';
import { createCloudJev } from '../../cloud/jevCloud.js';
import { createFleetGate } from '../../cloud/propagation.js';
import { makeFakeOllama, makeFakeQdrant, makeScriptedJev, jevResponse } from '../helpers/fakes.js';
import { startApiServer } from '../../server/app.js';

/** Small fetch-style JSON helper for the loopback API. */
async function api(port, method, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const json = await res.json();
  return { status: res.status, ok: res.ok, body: json };
}

/** One fully wired fake world: every subsystem Phase 1–10 built, zero network. */
function makeWorld() {
  const config = loadConfig({
    env: {},
    optional: {
      OLLAMA_MODEL: 'fake-answerer',
      EMBEDDING_MODEL: 'fake-embedder',
      QDRANT_EDGE_URL: 'http://127.0.0.1:6333',
      QDRANT_CLOUD_URL: 'http://127.0.0.1:6334',
    },
  });

  // --- CLOUD side (separate fake Qdrant instances per collection) ---
  const cloudDocs = makeFakeQdrant({ collection: 'aeroedge_cloud_docs' });
  const cloudMemories = makeFakeQdrant({ collection: 'aeroedge_cloud_memories' });
  const cloudSyncEvents = makeFakeQdrant({ collection: 'aeroedge_cloud_sync_events' });
  const cloudConflicts = makeFakeQdrant({ collection: 'aeroedge_cloud_conflicts' });
  const cloudReview = makeFakeQdrant({ collection: 'aeroedge_cloud_review_queue' });
  const cloudVerdicts = makeFakeQdrant({ collection: 'aeroedge_cloud_verdicts' });

  // Cloud JEV scripted: (1) memory1's fleet pass → validated (corroborated);
  // (2) the conflict recommendation pass → needs_human_review; (3) the second
  // device's single-source upload → needs_human_review.
  const cloudJevResponses = [
    jevResponse({
      verdict: 'validated',
      rationale: 'Corroborated by another device; consistent with the enterprise master document; refines existing knowledge.',
      confidence: 0.9,
      risk_flags: [],
    }),
    jevResponse({
      verdict: 'needs_human_review',
      rationale: 'Divergent versions disagree on a torque value; the fleet should not auto-adopt either side without a human.',
      confidence: 0.4,
      risk_flags: ['version_divergence'],
    }),
    jevResponse({
      verdict: 'needs_human_review',
      rationale: 'Single device, no corroboration on record yet — fleet trust is not earned by one report.',
      confidence: 0.4,
      risk_flags: ['single_device_unverified'],
    }),
  ];
  const cloudJevOllama = makeFakeOllama({ respond: makeScriptedJev(cloudJevResponses).respond });
  const cloudJev = createCloudJev({ config, ollama: cloudJevOllama, cloudMemories, cloudDocs, cloudVerdicts });
  const cloudSync = createCloudSyncIngest({ config, cloudMemories, cloudSyncEvents });

  // --- EDGE side ---
  const edgeDocs = makeFakeQdrant({ collection: 'aeroedge_edge_docs' });
  const edgeMemoriesQ = makeFakeQdrant({ collection: 'aeroedge_edge_memories' });
  const edgeOllama = makeFakeOllama(); // grounded answers straight from excerpts

  const pipeline = createRagPipeline({ config, ollama: edgeOllama, qdrant: edgeDocs });
  const memoryStore = createMemoryStore({ config, qdrant: edgeMemoriesQ });
  const session = createSession({ assetId: 'MSN4453', component: 'hydraulics' });

  // Edge JEV scripted: one accept_local verdict per captured observation.
  const edgeAccept = jevResponse({
    verdict: 'accept_local',
    rationale: 'Internally consistent; agrees with the authoritative standard; evidence sufficient; low provisional risk.',
    confidence: 0.82,
    risk_flags: [],
  });
  const edgeJevOllama = makeFakeOllama({ respond: makeScriptedJev([edgeAccept, edgeAccept, edgeAccept]).respond });

  const orchestrator = createMemoryOrchestrator({
    config,
    memoryStore,
    session,
    ollama: edgeJevOllama,
    qdrant: edgeDocs,
  });

  const syncEngine = createSyncEngine({ memoryStore, deviceId: 'device-e2e-01' });
  const reconciler = createReconciler({
    memoryStore,
    ledger: syncEngine.ledger,
    cloudMemories,
    cloudConflicts,
  });
  // The gate writes validated/rejected verdicts back to the device too.
  const gate = createFleetGate({ cloudMemories, cloudReview, cloudConflicts, edgeMemoryStore: memoryStore });

  return {
    config, pipeline, orchestrator, syncEngine, reconciler, cloudSync, cloudJev, gate,
    memoryStore, session,
    edgeDocs, edgeMemoriesQ, cloudDocs, cloudMemories, cloudConflicts, cloudReview, cloudVerdicts,
  };
}

/** Start the API server over a world, on an ephemeral loopback port. */
async function startWorld(world) {
  return startApiServer({
    deps: {
      config: world.config,
      pipeline: world.pipeline,
      orchestrator: world.orchestrator,
      syncEngine: world.syncEngine,
      cloudSync: world.cloudSync,
      reconciler: world.reconciler,
      cloudJev: world.cloudJev,
      gate: world.gate,
      cloudMemories: world.cloudMemories,
      deviceId: 'device-e2e-01',
    },
  });
}

test('e2e demo: connect → provision → disconnect → offline query → session → capture/JEV → route → sync → cloud JEV → conflict → confirm → propagate', async () => {
  const world = makeWorld();
  const server = await startWorld(world);
  try {
    const call = (method, path, body) => api(server.port, method, path, body);

    /* ---------- STEP 1: connect + provision ---------- */
    let res = await call('POST', '/api/connection', { connected: true });
    assert.equal(res.status, 200);
    assert.equal(res.body.connected, true);
    res = await call('GET', '/api/health');
    assert.equal(res.body.connected, true);
    assert.equal(res.body.deviceId, 'device-e2e-01');

    // Cloud-side demo bootstrap (the launcher does this at boot): seed the
    // enterprise knowledge store (Phase 6), then provision THIS device
    // (Phase 7). Both idempotent — no manual data patching anywhere.
    const cloudKnowledge = createCloudKnowledge({ config: world.config, ollama: makeFakeOllama(), qdrant: world.cloudDocs });
    const provisioning = createProvisioning({ config: world.config, cloudQdrant: world.cloudDocs, edgeQdrant: world.edgeDocs });
    const seeded = await cloudKnowledge.ingestDocument({
      documentId: 'ent-std-hydraulics-b',
      text:
        'Enterprise hydraulic standard, system B: normal operating pressure is 2800-3200 PSI. ' +
        'The inlet B-nut of the pressure line is torqued to 45 N-m per fleet bulletin 88-42B. ' +
        'Overpressure above 3400 PSI opens the thermal relief valve.',
      assetId: 'FLEET-STANDARD',
      component: 'hydraulics',
      source: 'Enterprise engineering standard rev 12',
      docType: 'standard',
      equipmentModel: 'Boeing 737',
    });
    assert.equal(seeded.jevStatus, 'not_applicable', 'enterprise input arrives pre-trusted');
    const provisioned = await provisioning.provisionEdgeDevice(
      { assetId: 'FLEET-STANDARD', component: 'hydraulics' },
      { maxChunks: 200 }
    );
    assert.ok(provisioned.transferred > 0, 'device received provisioned knowledge');
    assert.ok(world.edgeDocs.size() > 0, 'edge document collection populated by provisioning');

    /* ---------- STEP 2: disconnect ---------- */
    res = await call('POST', '/api/connection', { connected: false });
    assert.equal(res.body.connected, false);
    res = await call('GET', '/api/health');
    assert.equal(res.body.connected, false, 'device now offline');

    /* ---------- STEP 3: offline grounded query ---------- */
    res = await call('POST', '/api/query', { query: 'What is the normal operating pressure of hydraulic system B?' });
    assert.equal(res.status, 200);
    assert.ok(res.body.answer.length > 0, 'grounded answer produced offline');
    assert.ok(res.body.citations.length > 0, 'answer cites sources');
    assert.ok(res.body.evidence.chunks.length > 0, 'evidence pack present');
    assert.ok(
      res.body.citations.every((c) => c.documentId === 'ent-std-hydraulics-b'),
      'citations come from provisioned enterprise knowledge only'
    );

    /* ---------- STEP 4: session follow-up ---------- */
    res = await call('POST', '/api/session', { assetId: 'MSN4453', component: 'hydraulics' });
    assert.equal(res.status, 200);
    assert.equal(res.body.session.assetId, 'MSN4453', 'session context indicator has its asset');

    res = await call('POST', '/api/query', { query: 'what about the inlet B-nut torque?' });
    assert.equal(res.status, 200);
    assert.equal(res.body.usedSessionContext, true, 'elliptical follow-up resolved via session context');
    assert.ok(res.body.sessionId, 'session id surfaced with the answer');

    /* ---------- STEP 5: record field observation — Edge JEV verdict IMMEDIATE ---------- */
    res = await call('POST', '/api/capture', {
      content: 'Tightened the inlet B-nut to 45 N-m and the seep stopped; matches the fleet bulletin torque.',
      source: 'technician-jane',
      importance: 0.85,
    });
    assert.equal(res.status, 200);
    const capture = res.body;
    assert.equal(capture.memory.memory_type, 'field_observation');
    assert.equal(capture.memory.jev_status, 'pending', 'recorded BEFORE evaluation: stored as pending');
    assert.equal(capture.verdict.stage, 'edge', 'Edge Pass verdict surfaced to the technician');
    assert.equal(capture.verdict.verdict, 'accept_local');
    assert.ok(capture.verdict.rationale.length > 0, 'non-empty rationale shown immediately');
    const memory1 = capture.memory.memory_id;

    /* ---------- STEP 6: the Memory Orchestrator routed it ---------- */
    assert.equal(capture.applied.action, 'SYNC', 'importance ≥ 0.7 → SYNC route');
    assert.ok(capture.applied.transitions.includes('lifecycle new → local'), 'legal transition stored');
    assert.ok(capture.applied.transitions.includes('lifecycle local → sync_pending'), 'legal transition stored');
    assert.ok(capture.applied.transitions.includes('jev pending → accept_local'), 'legal jev transition stored');

    res = await call('GET', '/api/memories?lifecycleStatus=sync_pending');
    assert.ok(res.body.memories.some((m) => m.memory_id === memory1), 'dashboard shows the memory as sync_pending');

    /* ---------- STEP 7: reconnect + delta sync ---------- */
    res = await call('POST', '/api/connection', { connected: true });
    assert.equal(res.body.connected, true, 'reconnected');
    res = await call('POST', '/api/sync/delta', {});
    assert.equal(res.status, 200);
    assert.equal(res.body.items.length, 1, 'exactly the observation rides the delta');
    assert.equal(res.body.items[0].memoryId, memory1);
    assert.equal(res.body.items[0].jevVerdict, 'accept_local');
    assert.equal(res.body.classification.counts.EDGE_NEW, 1, 'classified EDGE_NEW');
    assert.equal(res.body.outcome.uploaded, 1, 'uploaded to the cloud store');
    assert.equal(res.body.outcome.conflicts, 0, 'first sync: no conflicts');

    res = await call('GET', '/api/memories?lifecycleStatus=synced');
    assert.ok(
      res.body.memories.some((m) => m.memory_id === memory1),
      'edge record advanced to lifecycle synced after the cloud ack'
    );

    /* ---------- STEP 8: Cloud JEV pass — fleet-context verdict → gate propagates ---------- */
    // Fleet context exists only because OTHER devices sync: device-02 has
    // already uploaded an independent corroborating observation.
    await world.cloudMemories.upsertPoints([
      {
        id: 'mem-fleet-02-corroboration',
        vector: [1],
        payload: {
          memory_id: 'mem-fleet-02-corroboration',
          memory_type: 'field_observation',
          content: 'Second device: tightened the same inlet B-nut to 45 N-m and the seep stopped on our aircraft too.',
          asset_id: 'MSN4453',
          source: 'device-02 (technician-bob)',
          version: '1',
          importance: 0.7,
          confidence: 0.6,
          created_at: '2026-09-29T11:00:00.000Z',
          updated_at: '2026-09-29T11:00:00.000Z',
          sync_status: 'synced',
          lifecycle_status: 'synced',
          jev_status: 'accept_local',
        },
      },
    ]);
    res = await call('POST', '/api/cloud/jev', { memoryId: memory1 });
    assert.equal(res.status, 200);
    assert.equal(res.body.verdict.stage, 'cloud');
    assert.equal(res.body.verdict.verdict, 'validated', 'fleet context corroborates → validated');
    assert.ok(res.body.verdict.rationale.length > 0);
    assert.ok(res.body.verdict.evidence_used.length > 0, 'evidence_used cites fleet context');
    assert.equal(res.body.applied.action, 'propagate', 'the gate propagates validated knowledge');
    assert.ok(res.body.applied.transitions.includes('jev accept_local → validated'), 'legal jev transition to validated');
    res = await call('GET', '/api/memories?jevStatus=validated');
    assert.ok(
      res.body.memories.some((m) => m.memory_id === memory1),
      'validated status written back to the edge device too'
    );

    /* ---------- STEP 9: divergence → OPEN conflict + JEV recommendation ---------- */
    // A second observation syncs cleanly (edge → cloud ancestor). THEN a
    // fleet engineer corrects the CLOUD copy while the edge records an
    // offline revision of the SAME lineage: genuine divergence. This is the
    // natural live-demo path — the memory has synced but is not yet
    // cloud-validated, so it still rides the delta.
    const second = await world.orchestrator.captureAndRoute({
      content: 'Also checked the outlet B-nut: 45 N-m held with no seep after three thermal cycles.',
      assetId: 'MSN4453',
      source: 'technician-jane',
      importance: 0.8,
    });
    assert.equal(second.applied.action, 'SYNC');
    const memory2 = second.memory.memory_id;
    res = await call('POST', '/api/sync/delta', {});
    assert.equal(res.status, 200);
    assert.equal(res.body.outcome.uploaded, 1, 'second observation synced cleanly (its ancestor is recorded)');

    const cloudHits = await world.cloudMemories.scrollWithFilter(
      { must: [{ key: 'memory_id', match: { value: memory2 } }] },
      { limit: 2 }
    );
    assert.equal(cloudHits.length, 1);
    const cloudEdited = {
      ...cloudHits[0].payload,
      content: 'FLEET EDIT: outlet B-nut torque is 47 N-m per superseding fleet bulletin.',
      updated_at: '2026-09-29T14:00:00.000Z',
    };
    await world.cloudMemories.upsertPoints([{ id: cloudEdited.memory_id, vector: [1], payload: cloudEdited }]);

    const edgeRevised = {
      ...(await world.memoryStore.getMemory(memory2)),
      content: 'EDGE EDIT: outlet B-nut measured effective at 44 N-m in cold conditions.',
      version: '2',
      revision_of: memory2,
      updated_at: '2026-09-29T13:30:00.000Z',
    };
    await world.memoryStore.putMemory(edgeRevised);

    res = await call('POST', '/api/sync/delta', {});
    assert.equal(res.status, 200);
    assert.equal(res.body.classification.counts.DIVERGED, 1, 'genuine divergence classified DIVERGED');
    assert.equal(res.body.outcome.conflicts, 1, 'conflict detected, neither side overwritten');
    assert.equal(res.body.outcome.uploaded, 0, 'edge revision WITHHELD (no last-write-wins)');

    res = await call('GET', '/api/conflicts');
    assert.equal(res.status, 200);
    assert.equal(res.body.conflicts.length, 1);
    const conflict = res.body.conflicts[0];
    assert.equal(conflict.status, 'open');
    assert.equal(conflict.conflict_type, 'version_divergence');
    assert.notEqual(conflict.edge_version, conflict.cloud_version, 'two versions listed, nothing applied');

    // The UI's "Review Details" flow: the full record through the API.
    res = await call('GET', `/api/conflicts/${encodeURIComponent(conflict.conflict_id)}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.conflict.conflict_id, conflict.conflict_id);

    // JEV recommendation attaches to the SAME record; NOTHING is applied.
    res = await call('POST', `/api/conflicts/${encodeURIComponent(conflict.conflict_id)}/recommend`, {});
    assert.equal(res.status, 200);
    assert.equal(res.body.conflict.conflict_id, conflict.conflict_id, 'SAME Phase 9 record');
    assert.equal(res.body.conflict.status, 'open', 'a recommendation never resolves anything');
    assert.ok(res.body.conflict.recommended_by_verdict, 'recommendation is JEV-backed');
    assert.ok(
      !/Phase 9 version reconciliation/.test(String(res.body.conflict.jev_recommendation.rationale)),
      'Phase 9 placeholder replaced by a real Cloud JEV recommendation'
    );

    /* ---------- STEP 10: EXPLICIT human confirmation — the only path to resolved ---------- */
    res = await call('POST', `/api/conflicts/${encodeURIComponent(conflict.conflict_id)}/confirm`, {
      resolvedBy: 'fleet-engineer-x',
      winner: 'cloud',
      resolution: 'Human confirmed: adopt the fleet-bulletin torque (cloud version).',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.conflict.status, 'resolved', 'resolved ONLY by explicit human confirmation');
    assert.equal(res.body.conflict.resolution_winner, 'cloud');
    assert.equal(res.body.conflict.resolved_by, 'fleet-engineer-x');

    res = await call('GET', '/api/conflicts');
    assert.equal(res.body.conflicts.length, 0, 'no open conflicts remain');

    /* ---------- STEP 11: fleet propagation state ---------- */
    const cloudStatuses = new Map(
      (await world.cloudMemories.scrollWithFilter({ must: [] }, { limit: 100 }))
        .map((p) => [String(p.payload.memory_id), String(p.payload.jev_status)])
    );
    assert.equal(cloudStatuses.get(memory1), 'validated', 'the validated memory is fleet-propagatable');
    assert.equal(cloudStatuses.get(memory2), 'accept_local', 'the conflicted memory stays held — resolution applies versions, not trust');

    /* ---------- STEP 12: needs_human_review queued — never auto-propagated ---------- */
    // The Cloud Pass on the diverged memory's content: a version conflict
    // is about WHICH VERSION wins; fleet TRUST is a separate decision. The
    // scripted pass refuses single-source trust → the review queue.
    res = await call('POST', '/api/cloud/jev', { memoryId: memory2 });
    assert.equal(res.status, 200);
    assert.equal(res.body.verdict.verdict, 'needs_human_review');
    assert.equal(res.body.applied.action, 'review', 'the gate queues it for a human');
    assert.ok(res.body.applied.queueId, 'review queue entry created');

    res = await call('GET', '/api/review-queue');
    assert.equal(res.status, 200);
    assert.ok(
      res.body.queue.some((e) => String(e.memory_id) === memory2),
      'needs_human_review item waits in the human-review queue'
    );
    const finalStatuses = new Set(
      (await world.cloudMemories.scrollWithFilter({ must: [] }, { limit: 100 })).map((p) => String(p.payload.jev_status))
    );
    assert.ok(!finalStatuses.has('needs_human_review'), 'review items never propagate to the fleet');
  } finally {
    await server.close();
  }
});

test('e2e demo: the static UI is served from the same server (index.html + assets)', async () => {
  const world = makeWorld();
  const server = await startWorld(world);
  try {
    const index = await fetch(`${server.url}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type') ?? '', /text\/html/);
    const html = await index.text();
    assert.match(html, /AeroEdge/);
    assert.match(html, /Apply Cloud Version/);
    assert.match(html, /Keep Edge Version/);
    // The per-conflict "Review Details" button is rendered by app.js.
    const js = await fetch(`${server.url}/app.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type') ?? '', /javascript/);
    assert.match(await js.text(), /Review Details/);

    const css = await fetch(`${server.url}/styles.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type') ?? '', /text\/css/);
    const cssText = await css.text();
    assert.match(cssText, /:root/, 'CSS variables for theming');
    assert.doesNotMatch(cssText, /@import\s+url\(\s*["']?https?:/, 'no external CSS imports');

    // Path traversal is refused.
    const evil = await fetch(`${server.url}/..%2F..%2Fpackage.json`);
    assert.equal(evil.status, 403);
  } finally {
    await server.close();
  }
});

test('e2e demo: API error handling is explicit (bad input → 400, missing → 404, unknown route → 404)', async () => {
  const world = makeWorld();
  const server = await startWorld(world);
  try {
    let res = await api(server.port, 'POST', '/api/query', { query: '' });
    assert.equal(res.status, 400);
    res = await api(server.port, 'POST', '/api/capture', { content: '' });
    assert.equal(res.status, 400);
    res = await api(server.port, 'GET', '/api/nope');
    assert.equal(res.status, 404);
    res = await api(server.port, 'POST', '/api/cloud/jev', { memoryId: 'mem-missing' });
    assert.equal(res.status, 404);
  } finally {
    await server.close();
  }
});
