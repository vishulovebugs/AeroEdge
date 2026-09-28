'use strict';

/**
 * Interconnection tests: Phase 2 (hybrid retrieval) ↔ Phase 3 (session
 * memory). Asserts that session-aware answering (a) resolves elliptical
 * follow-ups that stateless retrieval cannot disambiguate, and (b) leaves
 * Phase 2's retrieval quality and citations intact. Fully offline via the
 * shared fakes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createRagPipeline } from '../../edge/rag.js';
import { createSession, buildSessionSummary } from '../../edge/session.js';
import { makeFakeOllama, makeFakeQdrant } from '../helpers/fakes.js';

const CONFIG = Object.freeze({
  OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
  EMBEDDING_MODEL: 'nomic-embed-text',
  OLLAMA_MODEL: 'llama3.1:8b',
  QDRANT_EDGE_URL: 'http://localhost:6333',
  QDRANT_EDGE_COLLECTION: 'aeroedge_edge_docs',
  QDRANT_CLOUD_URL: 'http://localhost:6334',
});

// Two nearly identical documents on DIFFERENT assets: the same question
// ("what torque applies to the B-nut?") is genuinely ambiguous without
// session context. Stored asset_id equals the session's extracted asset
// ("MSN4453") so session-suggested filters match exactly.
const DOC_4453 = [
  'Torque the B-nut on the pump inlet line to 45 N·m and safety-wire it on MSN4453; hydraulic system B operates at a normal pressure range of 2800-3200 PSI (fictional test fixture).',
].join('\n\n');

const DOC_9999 = [
  'Torque the B-nut on the pump inlet line to 60 N·m and safety-wire it on MSN9999; hydraulic system B operates at a normal pressure range of 2800-3200 PSI (fictional test fixture).',
].join('\n\n');

function makePipeline() {
  const ollama = makeFakeOllama();
  const qdrant = makeFakeQdrant();
  const pipeline = createRagPipeline({ config: CONFIG, ollama, qdrant });
  return { ollama, qdrant, pipeline };
}

async function ingestBothAssets(pipeline) {
  await pipeline.ingestDocument({
    documentId: 'doc-4453', text: DOC_4453, assetId: 'MSN4453',
    component: 'hydraulics', source: 'AMM rev 42 (fixture)', version: '1',
  });
  await pipeline.ingestDocument({
    documentId: 'doc-9999', text: DOC_9999, assetId: 'MSN9999',
    component: 'hydraulics', source: 'AMM rev 42 (fixture)', version: '1',
  });
}

test('interconnect: bare follow-up resolves against the session asset (stateless retrieval is ambiguous)', async () => {
  const { pipeline } = makePipeline();
  await ingestBothAssets(pipeline);

  // Control — stateless Phase 2: the identical question on both assets'
  // documents returns evidence from BOTH. A stateless system cannot know
  // which aircraft the technician means.
  const stateless = await pipeline.retrieveEvidence('what torque applies to the B-nut?', { limit: 8 });
  assert.ok(
    stateless.chunks.some((c) => c.documentId === 'doc-4453') &&
      stateless.chunks.some((c) => c.documentId === 'doc-9999'),
    'control: stateless retrieval returns ambiguous cross-asset evidence'
  );

  // Session path: establish the asset, then ask the bare follow-up.
  const session = createSession();
  const first = await pipeline.answerQuestion('diagnosing aircraft MSN4453 today', { session });
  assert.equal(session.assetId, 'MSN4453', 'turn 1 established the session asset');

  const followUp = await pipeline.answerQuestion('what torque applies to the B-nut?', { session });
  assert.equal(followUp.sessionQuery !== undefined, true);
  assert.ok(
    followUp.sessionQuery.includes('MSN4453') || followUp.sessionQuery.includes('hydraulic'),
    `follow-up was expanded with session context (got: ${followUp.sessionQuery})`
  );
  assert.ok(followUp.chunks.length >= 1, 'follow-up retrieved evidence');
  for (const chunk of followUp.chunks) {
    assert.equal(chunk.assetId, 'MSN4453', 'session-suggested filter scoped evidence to the session asset');
  }
  assert.ok(
    followUp.chunks.some((c) => c.content.includes('45 N·m')),
    'follow-up retrieved the session asset\'s torque specification'
  );
  assert.ok(followUp.citations.length >= 1, 'answer still carries Phase 2 citations');
  assert.ok(followUp.citations.every((c) => c.documentId === 'doc-4453'), 'citations scoped to the session asset');
  assert.match(followUp.answer, /45 N·m/, 'grounded answer carries the session asset\'s fact');
});

test('interconnect: session context does not break Phase 2 retrieval quality or citations', async () => {
  const { pipeline } = makePipeline();
  await ingestBothAssets(pipeline);

  const session = createSession();
  const result = await pipeline.answerQuestion(
    'What is the normal pressure range of hydraulic system B on aircraft MSN4453?',
    { session }
  );

  // Phase 1/2 acceptance behavior, unchanged under a session:
  assert.match(result.answer, /2800-3200 PSI/);
  assert.ok(result.citations.some((c) => c.documentId === 'doc-4453' && c.chunkIds.length >= 1));

  // The prompt carried the compact session summary — not the raw transcript.
  // (Turn 1 of an empty session has nothing to inject yet; turn 2 does.)
  const second = await pipeline.answerQuestion('and what about the thermal relief valve?', { session });
  assert.ok(second.prompt.prompt.includes('Diagnostic session context'), 'session summary injected from turn 2 on');
  assert.ok(!second.prompt.prompt.includes('askedAt'), 'no raw turn objects leak into the prompt');
  // Phase 2 evidence sub-scores still flow through to the caller.
  assert.ok(result.evidence.chunks.every((c) => typeof c.score === 'number'));
  assert.ok(second.citations.length >= 1, 'session-aware answers still cite their sources');
});

test('interconnect: stale session filter falls back instead of blanking the answer', async () => {
  const { pipeline } = makePipeline();
  await ingestBothAssets(pipeline);

  // Session points at MSN9999, but the technician states MSN4453 in the
  // query itself; the suggested filter over-restricts, retrieval retries
  // unfiltered, and the query's own content decides.
  const session = createSession({ assetId: 'MSN9999', component: 'hydraulics' });
  const result = await pipeline.answerQuestion(
    'diagnostics for aircraft MSN4453: what torque applies to the B-nut?',
    { session }
  );
  assert.ok(result.chunks.length >= 1, 'over-restricting session filter did not blank the result');
  assert.ok(
    result.chunks.some((c) => c.documentId === 'doc-4453' && c.content.includes('45 N·m')),
    'correct evidence retrieved despite the stale session asset'
  );
});

test('interconnect: session stays bounded across a longer sequence', async () => {
  const { pipeline } = makePipeline();
  await ingestBothAssets(pipeline);

  const session = createSession();
  for (let i = 1; i <= 7; i++) {
    await pipeline.answerQuestion(`hydraulic diagnostics question ${i} for this aircraft`, { session });
  }
  assert.equal(session.recentQueries.length, 7, 'all turns kept under MAX_RECENT_QUERIES (10)');
  assert.ok(session.recentEvidence.length <= 3, 'bounded recentEvidence (MAX_RECENT_EVIDENCE)');

  const summary = buildSessionSummary(session);
  assert.ok(summary.length <= 700, 'summary stays bounded over long sessions');
  assert.ok(summary.includes('question 7'), 'most recent turn retained in the summary');
});

test('interconnect: pipeline re-exports the session surface', () => {
  const { pipeline } = makePipeline();
  assert.equal(typeof pipeline.createSession, 'function');
  assert.equal(typeof pipeline.buildSessionSummary, 'function');
});
