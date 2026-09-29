'use strict';

/**
 * Unit tests for Phase 5: the JEV Edge Pass (edge/jev.js).
 *
 * Covers: the separate-prompt contract (JEV is a judge, never the answering
 * generator), strict response parsing, and THE hard rule of this phase —
 * an evaluation without a non-empty rationale is coerced to
 * needs_more_evidence by code, never passed through.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildJEVPrompt,
  extractJson,
  normalizeEdgeResponse,
  createEdgeJev,
} from '../../edge/jev.js';
import { stubVerdictSource, routeMemory, createMemoryOrchestrator } from '../../edge/orchestrator.js';
import { makeFakeOllama, makeFakeQdrant, jevResponse, makeScriptedJev } from '../helpers/fakes.js';

/** A valid Memory-shaped candidate for prompt/evaluation inputs. */
function candidate(patch = {}) {
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
  };
}

const PACK = {
  query: 'pump 2B whine',
  appliedFilters: {},
  exactTerms: [],
  chunks: [
    { chunkId: 'ev-1', documentId: 'doc-1', source: 'AMM rev 42', content: 'Cavitation is indicated by whining above 3000 PSI.', score: 0.9 },
  ],
};

// ---------------------------------------------------------------------------
// Prompt contract: a separate role, never the generator
// ---------------------------------------------------------------------------

test('JEV prompt is a distinct judge role: never answers questions, drives all four checks', () => {
  const { system, prompt } = buildJEVPrompt({
    candidate: candidate(),
    evidencePack: PACK,
    contradictingDocs: [
      { chunkId: 'auth-1', documentId: 'doc-9', source: 'AMM rev 42', content: 'Torque the B-nut to 45 N·m.', similarity: 0.8 },
    ],
  });

  // Distinct role from the Phase 1 generator (edge/rag.js buildGroundedPrompt).
  assert.match(system, /JEV/);
  assert.match(system, /do NOT answer questions/);
  assert.match(system, /JSON/);
  // Four checks driven by the prompt, in order.
  const consistency = prompt.indexOf('Internal consistency');
  const contradiction = prompt.indexOf('Contradiction');
  const sufficiency = prompt.indexOf('Evidence sufficiency');
  const risk = prompt.indexOf('Provisional risk');
  assert.ok(consistency !== -1 && contradiction !== -1 && sufficiency !== -1 && risk !== -1);
  assert.ok(consistency < contradiction && contradiction < sufficiency && sufficiency < risk);
  // Inputs are present verbatim.
  assert.ok(prompt.includes('Pump 2B whines above 3000 PSI'), 'candidate content verbatim');
  assert.ok(prompt.includes('Torque the B-nut to 45 N·m'), 'authoritative content verbatim');
  assert.ok(prompt.includes('Cavitation is indicated'), 'evidence pack content verbatim');
  // Safety-critical weighting is explicit.
  assert.match(prompt, /safety/);
});

test('JEV prompt degrades gracefully with no evidence pack and no authoritative docs', () => {
  const { prompt } = buildJEVPrompt({ candidate: candidate(), contradictingDocs: [] });
  assert.ok(prompt.includes('Evidence pack: (none available'));
  assert.ok(prompt.includes('Authoritative documents: (none retrieved'));
});

test('buildJEVPrompt rejects malformed candidates', () => {
  assert.throws(() => buildJEVPrompt({ candidate: null, contradictingDocs: [] }), TypeError);
  assert.throws(() => buildJEVPrompt({ candidate: { content: '   ' }, contradictingDocs: [] }), TypeError);
});

// ---------------------------------------------------------------------------
// Response parsing: strict, contract-enforcing, rationale-coercing
// ---------------------------------------------------------------------------

test('extractJson finds JSON wrapped in fences/prose and rejects garbage', () => {
  assert.deepEqual(extractJson('{"verdict":"accept_local"}'), { verdict: 'accept_local' });
  assert.deepEqual(
    extractJson('Sure! ```\n{"verdict":"flag_risk","rationale":"x"}\n```'),
    { verdict: 'flag_risk', rationale: 'x' }
  );
  assert.equal(extractJson('no json here'), null);
  assert.equal(extractJson(''), null);
});

test('normalizeEdgeResponse passes through a well-formed verdict with rationale', () => {
  const out = normalizeEdgeResponse(
    { verdict: 'accept_local', rationale: 'Consistent with excerpt 1; no conflicts.', confidence: 0.8, risk_flags: [] },
    { model: 'test-model' }
  );
  assert.equal(out.verdict, 'accept_local');
  assert.equal(out.rationale, 'Consistent with excerpt 1; no conflicts.');
  assert.equal(out.confidence, 0.8);
  assert.equal(out.stage, 'edge');
  assert.equal(out.model_used, 'test-model');
  assert.ok(Array.isArray(out.risk_flags) && Array.isArray(out.evidence_used));
});

test('HARD RULE: empty/missing rationale is coerced to needs_more_evidence, never passed through', () => {
  for (const bad of [
    { verdict: 'accept_local', rationale: '' },
    { verdict: 'accept_local', rationale: '   ' },
    { verdict: 'flag_risk', rationale: '' },
    { verdict: 'accept_local' }, // rationale missing entirely
  ]) {
    const out = normalizeEdgeResponse(bad, { model: 'test-model' });
    assert.equal(out.verdict, 'needs_more_evidence', `verdict ${JSON.stringify(bad)} must not pass`);
    assert.equal(out.confidence, 0, 'coerced verdicts carry zero confidence');
    assert.ok(typeof out.rationale === 'string' && out.rationale.trim() !== '', 'coerced rationale is non-empty');
    assert.match(out.rationale, /rationale|JSON/i);
  }
});

test('missing or out-of-scope verdict is coerced to needs_more_evidence', () => {
  for (const bad of [
    { rationale: 'a reason' },
    { verdict: 'validated', rationale: 'cloud verdict on the edge' },
    { verdict: 'banana', rationale: 'garbage' },
    {},
  ]) {
    const out = normalizeEdgeResponse(bad, { model: 'test-model' });
    assert.equal(out.verdict, 'needs_more_evidence');
    assert.ok(out.rationale.trim() !== '');
  }
});

test('unparseable model output coerces to needs_more_evidence with honest rationale', () => {
  const out = normalizeEdgeResponse(null, { model: 'test-model' });
  assert.equal(out.verdict, 'needs_more_evidence');
  assert.equal(out.confidence, 0);
  assert.ok(out.rationale.trim() !== '');
  assert.match(out.rationale, /parse/i);
});

test('confidence clamps into [0,1]; non-string risk flags are dropped', () => {
  const out = normalizeEdgeResponse(
    { verdict: 'flag_risk', rationale: 'r', confidence: 7, risk_flags: ['safety_critical_conflict', 42, ''] },
    { model: 'm' }
  );
  assert.equal(out.confidence, 1);
  assert.deepEqual(out.risk_flags, ['safety_critical_conflict']);
});

// ---------------------------------------------------------------------------
// createEdgeJev: full evaluation against fakes (zero network)
// ---------------------------------------------------------------------------

function makeJev({ responses, config } = {}) {
  const ollama = makeFakeOllama();
  const scripted = makeScriptedJev(responses ?? [jevResponse({ verdict: 'accept_local', rationale: 'ok', confidence: 0.7 })]);
  // Route the fake's generate through the scripted responder.
  ollama.generate = async ({ prompt, system }) => {
    ollama.generateCalls.push({ prompt, ...(system !== undefined ? { system } : {}) });
    return scripted.respond({ prompt });
  };
  const docsQdrant = makeFakeQdrant({ collection: 'aeroedge_edge_docs' });
  const cfg = Object.freeze({
    OLLAMA_MODEL: 'llama3.1:8b',
    EMBEDDING_MODEL: 'nomic-embed-text',
    QDRANT_EDGE_URL: 'http://localhost:6333',
    QDRANT_EDGE_COLLECTION: 'aeroedge_edge_docs',
    ...(config ?? {}),
  });
  const jev = createEdgeJev({ config: cfg, ollama, qdrant: docsQdrant });
  return { ollama, docsQdrant, jev, scripted };
}

test('createEdgeJev.evaluateMemory: one SEPARATE generate call, evidence_used stamped by code', async () => {
  const { ollama, docsQdrant, jev, scripted } = makeJev({
    responses: [jevResponse({ verdict: 'accept_local', rationale: 'Consistent with excerpt 1.', confidence: 0.8 })],
  });
  // Seed an authoritative doc so targeted retrieval has something to bind to.
  const vec = new Array(32).fill(0);
  vec[3] = 1;
  await docsQdrant.upsertPoints([
    { id: 'auth-1', vector: vec, payload: { id: 'auth-1', document_id: 'doc-9', content: 'Torque the B-nut to 45 N·m on MSN4453.', asset_id: 'aircraft-MSN4453', source: 'AMM rev 42', version: '1' } },
  ]);

  const result = await jev.evaluateMemory(candidate(), { evidencePack: PACK });

  assert.equal(result.verdict, 'accept_local');
  assert.equal(result.stage, 'edge');
  assert.equal(result.model_used, 'llama3.1:8b');
  assert.ok(result.rationale.includes('Consistent with excerpt 1.'));
  // Exactly ONE generate call ran (the JEV call) — the answer generator is a different caller.
  assert.equal(ollama.generateCalls.length, 1);
  // The JEV prompt is the judge prompt, not the grounded-answer prompt.
  assert.match(scripted.seenPrompts[0], /Evaluate this proposed field-knowledge record/);
  // evidence_used includes what the model was shown, stamped by code.
  assert.ok(result.evidence_used.includes('auth-1'), 'retrieved authoritative chunk stamped');
  assert.ok(result.evidence_used.includes('ev-1'), 'creation evidence pack stamped');
  assert.equal(result.retrievedContradictions.length, 1);
  assert.equal(result.retrievedContradictions[0].chunkId, 'auth-1');
});

test('createEdgeJev.evaluateMemory: evaluator crash coerces to needs_more_evidence (never throws)', async () => {
  const ollama = makeFakeOllama();
  ollama.generate = async () => {
    throw new Error('Ollama daemon is down');
  };
  const docsQdrant = makeFakeQdrant({ collection: 'aeroedge_edge_docs' });
  const jev = createEdgeJev({ config: { OLLAMA_MODEL: 'm' }, ollama, qdrant: docsQdrant });
  const result = await jev.evaluateMemory(candidate());
  assert.equal(result.verdict, 'needs_more_evidence');
  assert.equal(result.confidence, 0);
  assert.match(result.rationale, /never blocked/);
});

test('createEdgeJev.evaluateMemory: retrieval failure degrades to zero candidates, evaluation still runs', async () => {
  const ollama = makeFakeOllama();
  // Break ONLY embed (retrieval input); generate must still run.
  ollama.embed = async () => {
    throw new Error('embedder down');
  };
  const scripted = makeScriptedJev([jevResponse({ verdict: 'needs_more_evidence', rationale: 'thin evidence', confidence: 0.4 })]);
  ollama.generate = async ({ prompt }) => {
    ollama.generateCalls.push({ prompt });
    return scripted.respond({ prompt });
  };
  const docsQdrant = makeFakeQdrant({ collection: 'aeroedge_edge_docs' });
  const jev = createEdgeJev({ config: { OLLAMA_MODEL: 'm' }, ollama, qdrant: docsQdrant });
  const result = await jev.evaluateMemory(candidate(), { evidencePack: PACK });
  assert.equal(result.verdict, 'needs_more_evidence');
  assert.equal(result.retrievedContradictions.length, 0, 'no candidates without retrieval');
  assert.equal(ollama.generateCalls.length, 1, 'evaluation still ran');
  assert.ok(result.evidence_used.includes('ev-1'), 'pack evidence still stamped');
});

test('verdictRecord: contract-valid JEVVerdict with stage edge; throws on contract violations', () => {
  const { jev } = makeJev();
  const record = jev.verdictRecord(
    {
      verdict: 'flag_risk',
      rationale: 'Contradicts the torque spec in excerpt 1.',
      confidence: 0.9,
      risk_flags: ['safety_critical_conflict'],
      evidence_used: ['auth-1'],
      model_used: 'llama3.1:8b',
      evaluated_at: '2026-09-25T10:00:00.000Z',
      stage: 'edge',
    },
    'mem-42'
  );
  assert.equal(record.memory_id, 'mem-42');
  assert.equal(record.stage, 'edge');
  assert.equal(record.verdict, 'flag_risk');
  assert.ok(String(record.verdict_id).startsWith('jev-'));
  assert.throws(() => jev.verdictRecord({ verdict: 'accept_local', rationale: 'r' }, ''), TypeError);
});

// ---------------------------------------------------------------------------
// Orchestrator wiring: the Edge Pass is the default verdict source
// ---------------------------------------------------------------------------

test('orchestrator defaults to the real Edge JEV (stub is opt-in); injected clients are used', async () => {
  const { ollama, docsQdrant, scripted } = makeJev({
    responses: [jevResponse({ verdict: 'accept_local', rationale: 'fine', confidence: 0.7 })],
  });
  const cfg = {
    OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
    EMBEDDING_MODEL: 'nomic-embed-text',
    OLLAMA_MODEL: 'llama3.1:8b',
    QDRANT_EDGE_URL: 'http://localhost:6333',
    QDRANT_EDGE_COLLECTION: 'aeroedge_edge_docs',
    QDRANT_EDGE_MEMORY_COLLECTION: 'aeroedge_edge_memories',
  };
  const { createMemoryStore: createStore } = await import('../../edge/memoryStore.js');
  const memoryStore = createStore({ config: cfg, qdrant: makeFakeQdrant({ collection: 'aeroedge_edge_memories' }) });
  // Production shape: config + injected clients for the default Edge Pass.
  const orchestrator = createMemoryOrchestrator({ config: cfg, memoryStore, ollama, qdrant: docsQdrant });

  const stored = await orchestrator.captureObservation({ content: 'Pump 2B whines above 3000 PSI.', assetId: 'aircraft-MSN4453', source: 't' });
  const decision = await orchestrator.routeWithVerdict(stored);
  assert.equal(decision.action, 'KEEP_LOCAL');
  assert.equal(decision.verdict, 'accept_local');
  assert.equal(ollama.generateCalls.length, 1, 'default verdict source is the real Edge JEV, not the stub');
  assert.match(scripted.seenPrompts[0], /Evaluate this proposed field-knowledge record/);
});

test('orchestrator routeWithVerdict accepts a creation EvidencePack (bare or wrapped) and passes it to the Edge Pass', async () => {
  const { ollama, scripted } = makeJev({
    responses: [jevResponse({ verdict: 'accept_local', rationale: 'evidenced', confidence: 0.8 })],
  });
  const cfg = {
    OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
    EMBEDDING_MODEL: 'nomic-embed-text',
    OLLAMA_MODEL: 'llama3.1:8b',
    QDRANT_EDGE_URL: 'http://localhost:6333',
    QDRANT_EDGE_COLLECTION: 'aeroedge_edge_docs',
    QDRANT_EDGE_MEMORY_COLLECTION: 'aeroedge_edge_memories',
  };
  const { createMemoryStore: createStore } = await import('../../edge/memoryStore.js');
  const memoryStore = createStore({ config: cfg, qdrant: makeFakeQdrant({ collection: 'aeroedge_edge_memories' }) });
  const orchestrator = createMemoryOrchestrator({ config: cfg, memoryStore, ollama, qdrant: makeFakeQdrant({ collection: 'aeroedge_edge_docs' }) });
  const stored = await orchestrator.captureObservation({ content: 'Filter seep under 2000 PSI.', assetId: 'MSN4453', source: 't' });

  // Bare pack form.
  await orchestrator.routeWithVerdict(stored, { evidence: PACK });
  assert.match(scripted.seenPrompts[0], /Evidence pack retrieved when this record was created/);
  assert.match(scripted.seenPrompts[0], /Cavitation is indicated/);
  // Wrapped form (as rag.js sessions sometimes carry evidence arrays).
  await orchestrator.routeWithVerdict(stored, { evidence: [PACK] });
  assert.equal(ollama.generateCalls.length, 2);
  assert.match(scripted.seenPrompts[1], /Cavitation is indicated/);
});

test('stubVerdictSource remains available and Promise-shaped for opt-out routing', async () => {
  const v = await stubVerdictSource({ memory: candidate() });
  assert.equal(v.verdict, 'accept_local');
  assert.equal(v.stub, true);
  // And routeMemory still routes on it.
  const decision = routeMemory(candidate(), v);
  assert.equal(decision.action, 'KEEP_LOCAL');
});
