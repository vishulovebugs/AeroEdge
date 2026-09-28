'use strict';

/**
 * Interconnection tests: Phase 3 (session memory) ↔ Phase 4 (memory
 * orchestrator). Asserts that (a) Phase 3 session-aware answering still
 * works with the orchestrator attached, (b) a field observation captured
 * mid-session updates the session's "technician observations so far" state,
 * and (c) observations stay out of the authoritative document store. Fully
 * offline via the shared fakes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createRagPipeline } from '../../edge/rag.js';
import { createSession, buildSessionSummary } from '../../edge/session.js';
import { createMemoryOrchestrator } from '../../edge/orchestrator.js';
import { createMemoryStore } from '../../edge/memoryStore.js';
import { makeFakeOllama, makeFakeQdrant } from '../helpers/fakes.js';

const CONFIG = Object.freeze({
  OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
  EMBEDDING_MODEL: 'nomic-embed-text',
  OLLAMA_MODEL: 'llama3.1:8b',
  QDRANT_EDGE_URL: 'http://localhost:6333',
  QDRANT_EDGE_COLLECTION: 'aeroedge_edge_docs',
  QDRANT_EDGE_MEMORY_COLLECTION: 'aeroedge_edge_memories',
  QDRANT_CLOUD_URL: 'http://localhost:6334',
});

const DOC_4453 = [
  'Torque the B-nut on the pump inlet line to 45 N·m and safety-wire it on MSN4453; hydraulic system B operates at a normal pressure range of 2800-3200 PSI (fictional test fixture).',
].join('\n\n');

const DOC_9999 = [
  'Torque the B-nut on the pump inlet line to 60 N·m and safety-wire it on MSN9999; hydraulic system B operates at a normal pressure range of 2800-3200 PSI (fictional test fixture).',
].join('\n\n');

function makeWorld() {
  const ollama = makeFakeOllama();
  const docsQdrant = makeFakeQdrant({ collection: 'aeroedge_edge_docs' });
  const memoriesQdrant = makeFakeQdrant({ collection: 'aeroedge_edge_memories' });
  const pipeline = createRagPipeline({ config: CONFIG, ollama, qdrant: docsQdrant });
  const memoryStore = createMemoryStore({ config: CONFIG, qdrant: memoriesQdrant });
  const session = createSession();
  const orchestrator = createMemoryOrchestrator({
    config: CONFIG,
    memoryStore,
    session,
  });
  return { ollama, docsQdrant, memoriesQdrant, pipeline, memoryStore, session, orchestrator };
}

async function ingestDocs(pipeline) {
  await pipeline.ingestDocument({
    documentId: 'doc-4453', text: DOC_4453, assetId: 'MSN4453',
    component: 'hydraulics', source: 'AMM rev 42 (fixture)', version: '1',
  });
  await pipeline.ingestDocument({
    documentId: 'doc-9999', text: DOC_9999, assetId: 'MSN9999',
    component: 'hydraulics', source: 'AMM rev 42 (fixture)', version: '1',
  });
}

test('interconnect: mid-session observation updates Phase 3 session state and shows up in the prompt context', async () => {
  const { docsQdrant, pipeline, session, orchestrator } = makeWorld();
  await ingestDocs(pipeline);

  // Turn 1: establish the session asset/subsystem (Phase 3 behavior).
  await pipeline.answerQuestion('diagnosing aircraft MSN4453 today', { session });
  assert.equal(session.assetId, 'MSN4453');
  assert.ok(!buildSessionSummary(session).includes('Technician observations'), 'no observations yet');

  // The technician records an observation MID-SESSION through Phase 4.
  const observation = await orchestrator.captureObservation({
    content: 'B-nut showed light seepage after 38 N·m; re-torqued to spec.',
    assetId: session.assetId,
    source: 'technician-jane',
    importance: 0.6,
  });

  // Phase 3 session state ("technician observations so far") updated.
  assert.equal(session.observations.length, 1);
  assert.equal(session.observations[0].memoryId, observation.memory_id);
  assert.match(session.observations[0].content, /light seepage/);

  // The observation is stored as a field_observation with initial lifecycle.
  assert.equal(observation.memory_type, 'field_observation');
  assert.equal(observation.lifecycle_status, 'new');
  assert.equal(observation.jev_status, 'pending');

  // …and it stays OUT of the authoritative document store.
  assert.equal(docsQdrant.size(), 2, 'only the two ingested documents in the docs collection');

  // Phase 3 follow-up still resolves — now with the observation in context.
  const followUp = await pipeline.answerQuestion('what torque applies to the B-nut?', { session });
  assert.match(followUp.answer, /45 N·m/, 'session-aware follow-up still resolves correctly');
  assert.ok(followUp.citations.every((c) => c.documentId === 'doc-4453'));
  const prompt = followUp.prompt.prompt;
  assert.ok(prompt.includes('Technician observations so far'), 'observations injected into context');
  assert.ok(prompt.includes('re-torqued to spec'), 'observation content reaches the prompt');
  assert.ok(!prompt.includes(observation.memory_id) || prompt.includes('re-torqued'), 'content, not raw records');
});

test('interconnect: an observation that informed an answer is marked used (explicit lifecycle)', async () => {
  const { pipeline, memoryStore, session, orchestrator } = makeWorld();
  await ingestDocs(pipeline);
  await pipeline.answerQuestion('diagnosing aircraft MSN4453 today', { session });

  const observation = await orchestrator.captureObservation({
    content: 'Thermal relief valve opened twice during checks.',
    assetId: session.assetId,
    source: 'technician-jane',
  });
  assert.equal(observation.lifecycle_status, 'new');

  const result = await orchestrator.noteMemoryUsed(observation.memory_id);
  assert.equal(result.memory.lifecycle_status, 'used', 'evidence was consumed, stored explicitly');
  assert.equal(result.memory.jev_status, 'pending', 'usage is NOT validation');

  const stored = await memoryStore.getMemory(observation.memory_id);
  assert.equal(stored.lifecycle_status, 'used', 'transition persisted');
});

test('interconnect: session observations are bounded and summarized within budget', async () => {
  const { pipeline, session, orchestrator } = makeWorld();
  await ingestDocs(pipeline);
  await pipeline.answerQuestion('diagnosing aircraft MSN4453 today', { session });

  for (let i = 1; i <= 25; i++) {
    await orchestrator.captureObservation({
      content: `Observation ${i}: gauge reading logged during inspection.`,
      assetId: session.assetId,
      source: 'technician-jane',
    });
  }
  assert.ok(session.observations.length <= 20, 'session observations bounded (MAX_SESSION_OBSERVATIONS)');
  const summary = buildSessionSummary(session);
  assert.ok(summary.length <= 700, 'summary stays within SUMMARY_MAX_CHARS');
  assert.ok(summary.includes('Observation 25'), 'most recent observation retained');
  assert.ok(!summary.includes('Observation 1:'), 'oldest observations dropped first');
});
