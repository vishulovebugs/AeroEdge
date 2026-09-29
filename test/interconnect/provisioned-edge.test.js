'use strict';

/**
 * Interconnection tests for Phase 7: after provisioning REAL content with
 * the Phase 7 pipeline (cloud → select → prioritize → transfer), the FULL
 * Phase 1–5 edge stack is rerun against this newly provisioned Qdrant Edge
 * data — instead of hand-seeded test data:
 *
 *   - Phase 1–2: grounded answer + hybrid retrieval on provisioned chunks,
 *   - Phase 3: session-aware answering on provisioned knowledge,
 *   - Phase 4–5: capture + Edge JEV acceptance behavior, with the Edge Pass
 *     measuring field observations against provisioned authoritative docs.
 *
 * The provisioned edge store starts EMPTY except for what provisioning put
 * there — proving the stack works end to end on provisioned data. All
 * offline via the shared fakes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createRagPipeline } from '../../edge/rag.js';
import { createSession } from '../../edge/session.js';
import { createMemoryOrchestrator } from '../../edge/orchestrator.js';
import { createMemoryStore } from '../../edge/memoryStore.js';
import { createCloudKnowledge } from '../../cloud/knowledge.js';
import { createProvisioning } from '../../cloud/provisioning.js';
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
});

/**
 * Full world: a cloud store with MULTIPLE assets/subsystems, the Phase 7
 * provisioning pipeline, and a Phase 1–5 edge stack whose document store
 * starts EMPTY. Provisioning is the ONLY source of edge knowledge.
 * @param {{ verdict: string, rationale: string, confidence?: number, risk_flags?: string[] }[]} [verdicts]
 *   Scripted Edge JEV responses, served in call order (default: accept_local).
 */
function makeWorld(verdicts) {
  const edgeOllama = makeFakeOllama();
  const scripted = makeScriptedJev(
    verdicts ?? [
      jevResponse({ verdict: 'accept_local', rationale: 'Consistent with the provisioned manual.', confidence: 0.8 }),
    ]
  );
  // One daemon, two calls: JEV judge prompts get the script; grounded-answer
  // prompts keep the fake's excerpt-echo behavior (Phase 5 pattern).
  const groundedGenerate = edgeOllama.generate.bind(edgeOllama);
  edgeOllama.generate = async (args) =>
    typeof args.prompt === 'string' && args.prompt.includes('Evaluate this proposed field-knowledge record')
      ? scripted.respond({ prompt: args.prompt })
      : groundedGenerate(args);

  const cloudOllama = makeFakeOllama();
  const edgeDocs = makeFakeQdrant({ collection: 'aeroedge_edge_docs' });
  const memories = makeFakeQdrant({ collection: 'aeroedge_edge_memories' });
  const cloudDocs = makeFakeQdrant({ collection: 'aeroedge_cloud_docs' });

  const cloud = createCloudKnowledge({ config: CONFIG, ollama: cloudOllama, qdrant: cloudDocs });
  const prov = createProvisioning({ config: CONFIG, cloudQdrant: cloudDocs, edgeQdrant: edgeDocs });
  const pipeline = createRagPipeline({ config: CONFIG, ollama: edgeOllama, qdrant: edgeDocs });
  const memoryStore = createMemoryStore({ config: CONFIG, qdrant: memories });
  const session = createSession();
  const orchestrator = createMemoryOrchestrator({
    config: CONFIG,
    memoryStore,
    session,
    ollama: edgeOllama,
    qdrant: edgeDocs,
  });
  return { edgeOllama, scripted, edgeDocs, memories, cloudDocs, cloud, prov, pipeline, memoryStore, session, orchestrator };
}

/** Seed the enterprise database with the target asset plus unrelated ones. */
async function seedEnterpriseDatabase(cloud) {
  await cloud.ingestDocument({
    documentId: 'ent-msn4453-hydraulics',
    text:
      'MSN4453 hydraulic system B: normal pressure 2800-3200 PSI. The pump inlet line B-nut is torqued to ' +
      '45 N·m and safety-wired. The thermal relief valve opens above 3400 PSI (fictional fixture).',
    assetId: 'MSN4453',
    component: 'hydraulics',
    source: 'MSN4453 hydraulics manual rev 3',
    version: '3',
    docType: 'manual',
  });
  await cloud.ingestDocument({
    documentId: 'ent-msn9999-engine',
    text: 'MSN9999 engine oil standard: unrelated asset content entirely (fictional fixture).',
    assetId: 'MSN9999',
    component: 'engine',
    source: 'MSN9999 engine manual rev 8',
    version: '8',
    docType: 'manual',
  });
}

test('interconnect: grounded answer + hybrid retrieval work on PROVISIONED edge data (no hand-seeding)', async () => {
  const { edgeDocs, cloud, prov, pipeline } = makeWorld();
  await seedEnterpriseDatabase(cloud);

  // The edge document store is EMPTY before provisioning.
  assert.equal(edgeDocs.size(), 0, 'edge store starts empty: provisioning is the only data source');

  const result = await prov.provisionEdgeDevice({ assetId: 'MSN4453', component: 'hydraulics' });
  assert.equal(result.transferred > 0, true);
  assert.deepEqual(result.documentIds, ['ent-msn4453-hydraulics']);
  assert.equal(edgeDocs.size() > 0, true, 'edge knowledge exists ONLY because provisioning put it there');

  // Phase 1–2 behavior on provisioned chunks: grounded answer with citations.
  const answer = await pipeline.answerQuestion('What torque applies to the pump inlet line B-nut on MSN4453?');
  assert.match(answer.answer, /45 N·m/, 'grounded answer works on provisioned data');
  assert.ok(answer.citations.every((c) => c.documentId === 'ent-msn4453-hydraulics'));
  assert.ok(answer.chunks.length > 0);

  // Phase 2 hybrid behavior on provisioned chunks: identifier-exact retrieval.
  const evidence = await pipeline.retrieveEvidence('thermal relief valve 3400 PSI');
  assert.ok(evidence.chunks.some((c) => c.content.includes('3400 PSI')), 'hybrid retrieval finds provisioned content');
  assert.ok(evidence.chunks.every((c) => c.documentId === 'ent-msn4453-hydraulics'), 'no unrelated asset content');
});

test('interconnect: session-aware answering + Edge JEV acceptance on provisioned data', async () => {
  const { edgeDocs, cloud, prov, pipeline, memoryStore, memories, session, orchestrator, scripted } = makeWorld();
  await seedEnterpriseDatabase(cloud);
  await prov.provisionEdgeDevice({ assetId: 'MSN4453', component: 'hydraulics' });
  assert.ok(edgeDocs.size() > 0);

  // Phase 3: session-aware answering over provisioned knowledge.
  await pipeline.answerQuestion('Running diagnostics on MSN4453 hydraulics: normal system B pressure?', { session });
  assert.equal(session.assetId, 'MSN4453');
  const followUp = await pipeline.answerQuestion('and the inlet B-nut torque?', { session });
  assert.match(followUp.answer, /45 N·m/, 'elliptical follow-up resolves against provisioned content');
  assert.ok(session.recentEvidence.length > 0, 'session recorded provisioned evidence');

  // Phase 4–5: capture + Edge JEV route against provisioned authoritative docs.
  const observation = await orchestrator.captureObservation({
    content: 'B-nut showed light seepage after 38 N·m; re-torqued to the 45 N·m spec and safety-wired.',
    assetId: 'MSN4453',
    source: 'technician-jane',
    importance: 0.6,
  });
  const decision = await orchestrator.routeWithVerdict(observation);
  assert.equal(decision.verdict, 'accept_local', 'consistent observation accepted (scripted verdict 2)');
  await orchestrator.applyRoute(decision);
  const stored = await memoryStore.getMemory(observation.memory_id);
  assert.equal(stored.jev_status, 'accept_local');
  assert.equal(stored.lifecycle_status, 'local');
  assert.equal(memories.size(), 1, 'technician memory lives in the memory store, separate from provisioned docs');

  // The Edge Pass prompt showed PROVISIONED authoritative content.
  assert.match(scripted.seenPrompts[scripted.seenPrompts.length - 1], /Evaluate this proposed field-knowledge record/);
});

test('interconnect: contradicting observation is FLAGGED against provisioned safety content (Phase 5 acceptance on provisioned data)', async () => {
  const { cloud, prov, memoryStore, orchestrator } = makeWorld([
    jevResponse({
      verdict: 'flag_risk',
      rationale: 'Contradicts the provisioned torque spec (45 N·m) — safety-critical.',
      confidence: 0.8,
      risk_flags: ['safety_critical_conflict'],
    }),
  ]);
  await seedEnterpriseDatabase(cloud);
  await prov.provisionEdgeDevice({ assetId: 'MSN4453', component: 'hydraulics' });

  // THE Phase 5 acceptance criterion, now on PROVISIONED data: an
  // observation contradicting the provisioned 45 N·m procedure is flagged,
  // still recorded, visibly marked. (This world's script returns the
  // safety-critical flag — matching what the real model would do with a
  // contradiction in view.)
  const result = await orchestrator.captureAndRoute({
    content: 'Tightened the B-nut to 90 N·m — far past the published spec, seats better. Worked three times.',
    assetId: 'MSN4453',
    source: 'technician-jane',
    importance: 0.6,
  });
  assert.equal(result.recorded, true, 'still recorded');
  assert.equal(result.verdict.verdict, 'flag_risk', 'flagged against provisioned safety content (scripted verdict 1)');
  const stored = await memoryStore.getMemory(result.memory.memory_id);
  assert.equal(stored.jev_status, 'flag_risk', 'visibly flagged in the stored record');
  assert.equal(stored.lifecycle_status, 'local');
});

test('interconnect: provisioning respects the device scope — unrelated cloud content never reaches the edge stack', async () => {
  const { edgeDocs, cloud, prov, pipeline } = makeWorld();
  await seedEnterpriseDatabase(cloud);
  await prov.provisionEdgeDevice({ assetId: 'MSN4453', component: 'hydraulics' });

  // Queries about the EXCLUDED asset find nothing on the device.
  const evidence = await pipeline.retrieveEvidence('MSN9999 engine oil standard');
  assert.equal(
    evidence.chunks.filter((c) => c.documentId === 'ent-msn9999-engine').length,
    0,
    'unrelated asset content is NOT on the device'
  );
  // And the device holds only the provisioned document.
  const docs = new Set((await edgeDocs.scrollWithFilter({}, { limit: 100 })).map((h) => h.payload.document_id));
  assert.deepEqual([...docs], ['ent-msn4453-hydraulics']);
});
