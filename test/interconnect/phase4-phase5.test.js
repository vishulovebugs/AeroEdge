'use strict';

/**
 * Interconnection tests: Phase 4 (memory orchestrator) ↔ Phase 5 (JEV Edge
 * Pass). Phase 4's routing semantics are rerun here with the REAL Edge JEV
 * verdict source driving them (no stub), confirming the full verdict table:
 *
 *   accept_local + importance ≥ 0.7 → SYNC
 *   accept_local + importance < 0.7 → KEEP_LOCAL
 *   needs_more_evidence             → KEEP_LOCAL only, NEVER sync-eligible
 *   flag_risk                       → KEEP_LOCAL, stored flag, sync-eligible
 *   evaluator crash / empty rationale → coerced, recording still succeeds
 *
 * All three verdicts flow through the same production wiring the stub used:
 * getVerdict → routeMemory → applyRoute, with the jev_status transition
 * stored via shared/lifecycle.js.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryOrchestrator, stubVerdictSource } from '../../edge/orchestrator.js';
import { createMemoryStore } from '../../edge/memoryStore.js';
import { makeFakeOllama, makeFakeQdrant, jevResponse, makeScriptedJev } from '../helpers/fakes.js';

const CONFIG = Object.freeze({
  OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
  EMBEDDING_MODEL: 'nomic-embed-text',
  OLLAMA_MODEL: 'llama3.1:8b',
  QDRANT_EDGE_URL: 'http://localhost:6333',
  QDRANT_EDGE_COLLECTION: 'aeroedge_edge_docs',
  QDRANT_EDGE_MEMORY_COLLECTION: 'aeroedge_edge_memories',
  QDRANT_CLOUD_URL: 'http://localhost:6334',
});

/**
 * Build the full Phase 4+5 world offline: the orchestrator's DEFAULT Edge
 * JEV (no verdictSource injected) runs against scripted model responses.
 * @param {string[]} responses Raw model responses, in order.
 */
function makeWorld(responses) {
  const ollama = makeFakeOllama();
  const scripted = makeScriptedJev(responses);
  ollama.generate = async ({ prompt, system }) => {
    ollama.generateCalls.push({ prompt, ...(system !== undefined ? { system } : {}) });
    return scripted.respond({ prompt });
  };
  const docsQdrant = makeFakeQdrant({ collection: 'aeroedge_edge_docs' });
  const memoriesQdrant = makeFakeQdrant({ collection: 'aeroedge_edge_memories' });
  const memoryStore = createMemoryStore({ config: CONFIG, qdrant: memoriesQdrant });
  const orchestrator = createMemoryOrchestrator({
    config: CONFIG,
    memoryStore,
    ollama,
    qdrant: docsQdrant,
  });
  return { ollama, scripted, docsQdrant, memoriesQdrant, memoryStore, orchestrator };
}

// ---------------------------------------------------------------------------
// Verdict-driven routing: all three edge verdict types through the real source
// ---------------------------------------------------------------------------

test('accept_local + importance ≥ 0.7 → SYNC (stub-free, real Edge JEV verdict)', async () => {
  const { memoryStore, orchestrator } = makeWorld([
    jevResponse({ verdict: 'accept_local', rationale: 'Consistent, well-evidenced, no conflicts found.', confidence: 0.85 }),
  ]);
  const observation = await orchestrator.captureObservation({
    content: 'Crack pattern repeats on every third shackle.',
    assetId: 'rig-07',
    source: 'technician-raj',
    importance: 0.85,
  });
  const decision = await orchestrator.routeWithVerdict(observation);
  assert.equal(decision.verdict, 'accept_local');
  assert.equal(decision.action, 'SYNC');

  const applied = await orchestrator.applyRoute(decision);
  assert.deepEqual(applied.transitions, [
    'lifecycle new → local',
    'jev pending → accept_local',
    'lifecycle local → sync_pending',
  ]);
  const stored = await memoryStore.getMemory(observation.memory_id);
  assert.equal(stored.lifecycle_status, 'sync_pending');
  assert.equal(stored.jev_status, 'accept_local');
});

test('accept_local + importance < 0.7 → KEEP_LOCAL (real Edge JEV verdict)', async () => {
  const { memoryStore, orchestrator } = makeWorld([
    jevResponse({ verdict: 'accept_local', rationale: 'Internally consistent; usable locally.', confidence: 0.7 }),
  ]);
  const observation = await orchestrator.captureObservation({
    content: 'Access panel 4L screw heads show paint chipping.',
    assetId: 'rig-07',
    source: 'technician-raj',
  });
  const decision = await orchestrator.routeWithVerdict(observation);
  assert.equal(decision.verdict, 'accept_local');
  assert.equal(decision.action, 'KEEP_LOCAL');
  await orchestrator.applyRoute(decision);
  const stored = await memoryStore.getMemory(observation.memory_id);
  assert.equal(stored.jev_status, 'accept_local');
  assert.equal(stored.lifecycle_status, 'local');
});

test('needs_more_evidence → KEEP_LOCAL only, NEVER sync-eligible even at importance 0.95', async () => {
  const { memoryStore, orchestrator } = makeWorld([
    jevResponse({ verdict: 'needs_more_evidence', rationale: 'Observation is vague; no excerpt supports the claim.', confidence: 0.3 }),
  ]);
  const observation = await orchestrator.captureObservation({
    content: 'Something seems off with the pump sometimes.',
    assetId: 'rig-07',
    source: 'technician-raj',
    importance: 0.95, // would SYNC under accept_local — verdict must gate it
  });
  const decision = await orchestrator.routeWithVerdict(observation);
  assert.equal(decision.verdict, 'needs_more_evidence');
  assert.equal(decision.action, 'KEEP_LOCAL', 'never sync-eligible on needs_more_evidence');
  assert.match(decision.reason, /NOT sync-eligible/);

  await orchestrator.applyRoute(decision);
  const stored = await memoryStore.getMemory(observation.memory_id);
  assert.equal(stored.lifecycle_status, 'local', 'kept local, never sync_pending');
  assert.equal(stored.jev_status, 'needs_more_evidence', 'verdict stored on the record');
});

test('flag_risk → KEEP_LOCAL, stored flag_risk jev_status, visibly flagged, still sync-eligible in the table', async () => {
  const { memoryStore, orchestrator } = makeWorld([
    jevResponse({
      verdict: 'flag_risk',
      rationale: 'Contradicts the authoritative torque spec (45 N·m) in excerpt 1 — safety-critical.',
      confidence: 0.8,
      risk_flags: ['safety_critical_conflict', 'torque_spec_conflict'],
    }),
  ]);
  const observation = await orchestrator.captureObservation({
    content: 'Tightened the B-nut to 80 N·m and the seep stopped — 45 N·m spec feels wrong.',
    assetId: 'rig-07',
    source: 'technician-raj',
    importance: 0.6,
  });
  const decision = await orchestrator.routeWithVerdict(observation);
  assert.equal(decision.verdict, 'flag_risk');
  assert.equal(decision.action, 'KEEP_LOCAL');
  assert.match(decision.reason, /high-visibility/);

  await orchestrator.applyRoute(decision);
  const stored = await memoryStore.getMemory(observation.memory_id);
  assert.equal(stored.jev_status, 'flag_risk', 'the flag is STORED, not inferred');
  assert.equal(stored.lifecycle_status, 'local', 'kept local (a human must review; sync transport is a later phase)');
  // Queryable as high-visibility: the flag survives storage and filtering.
  const flagged = await memoryStore.listMemories({ jevStatus: 'flag_risk' });
  assert.ok(flagged.some((m) => m.memory_id === observation.memory_id), 'flagged record is queryable as high-visibility');
});

// ---------------------------------------------------------------------------
// Hard rule: JEV never blocks recording
// ---------------------------------------------------------------------------

test('captureAndRoute: evaluator crash still records the memory (coerced, never thrown)', async () => {
  const ollama = makeFakeOllama();
  ollama.generate = async () => {
    throw new Error('Ollama daemon is down');
  };
  const memoriesQdrant = makeFakeQdrant({ collection: 'aeroedge_edge_memories' });
  const memoryStore = createMemoryStore({ config: CONFIG, qdrant: memoriesQdrant });
  const orchestrator = createMemoryOrchestrator({
    config: CONFIG,
    memoryStore,
    ollama,
    qdrant: makeFakeQdrant({ collection: 'aeroedge_edge_docs' }),
  });

  const result = await orchestrator.captureAndRoute({
    content: 'Quench port needed 8 s, not the documented 5 s.',
    assetId: 'rig-07',
    source: 'technician-raj',
  });
  assert.equal(result.recorded, true, 'THE hard rule: recording always succeeds');
  assert.equal(result.verdict.verdict, 'needs_more_evidence', 'crash coerced, never blocked');
  assert.match(result.verdict.rationale, /never blocked/);
  assert.equal(result.decision.action, 'KEEP_LOCAL');
  assert.notEqual(result.applied, null);
  // Stored record shows the coercion, visibly.
  const stored = await memoryStore.getMemory(result.memory.memory_id);
  assert.equal(stored.jev_status, 'needs_more_evidence');
});

test('captureAndRoute: empty model rationale is coerced to needs_more_evidence in the full pipeline', async () => {
  const { memoryStore, orchestrator } = makeWorld([
    jevResponse({ verdict: 'accept_local', rationale: '   ' }), // whitespace-only rationale
  ]);
  const result = await orchestrator.captureAndRoute({
    content: 'B-nut seeped at 38 N·m; re-torque cleared it.',
    assetId: 'rig-07',
    source: 'technician-raj',
    importance: 0.9, // would be SYNC-eligible if the empty rationale passed through
  });
  assert.equal(result.recorded, true);
  assert.equal(result.verdict.verdict, 'needs_more_evidence', 'empty rationale must not ride accept_local through');
  assert.ok(result.verdict.rationale.trim() !== '');
  assert.equal(result.decision.action, 'KEEP_LOCAL');
  const stored = await memoryStore.getMemory(result.memory.memory_id);
  assert.equal(stored.jev_status, 'needs_more_evidence');
  assert.equal(stored.lifecycle_status, 'local');
});

test('captureAndRoute: full success path records, evaluates, routes, and surfaces the verdict', async () => {
  const { orchestrator, scripted } = makeWorld([
    jevResponse({ verdict: 'accept_local', rationale: 'Matches the documented behavior in the evidence.', confidence: 0.8 }),
  ]);
  const result = await orchestrator.captureAndRoute({
    content: 'Pump inlet pressure drops 200 PSI when the filter clogs.',
    assetId: 'rig-07',
    source: 'technician-raj',
    importance: 0.5,
    evidence: {
      query: 'pump inlet pressure drop',
      appliedFilters: {},
      exactTerms: [],
      chunks: [{ chunkId: 'ev-9', documentId: 'doc-2', source: 'AMM rev 7', content: 'A clogged inlet filter drops inlet pressure.', score: 0.9 }],
    },
  });
  assert.equal(result.recorded, true);
  assert.equal(result.verdict.stage, 'edge');
  assert.equal(result.verdict.verdict, 'accept_local');
  assert.equal(result.memory.memory_type, 'field_observation', 'recorded BEFORE evaluation');
  assert.equal(result.memory.jev_status, 'pending', 'the returned record is as-first-stored');
  assert.equal(result.applied.action, 'KEEP_LOCAL');
  assert.ok(result.verdict.evidence_used.includes('ev-9'), 'creation evidence stamped into the verdict');
  assert.match(scripted.seenPrompts[0], /Evaluate this proposed field-knowledge record/);
  assert.match(scripted.seenPrompts[0], /A clogged inlet filter drops inlet pressure/);
});

test('captureAndRoute with route=false records and returns the verdict without applying routes', async () => {
  const { memoryStore, orchestrator } = makeWorld([
    jevResponse({ verdict: 'flag_risk', rationale: 'Risky claim, needs human review.', confidence: 0.6 }),
  ]);
  const result = await orchestrator.captureAndRoute({
    content: 'Bypassing the interlock resets the fault faster.',
    assetId: 'rig-07',
    source: 'technician-raj',
    route: false,
  });
  assert.equal(result.recorded, true);
  assert.equal(result.applied, null, 'no route applied on request');
  const stored = await memoryStore.getMemory(result.memory.memory_id);
  assert.equal(stored.jev_status, 'pending', 'still pending until routing is applied');
});

// ---------------------------------------------------------------------------
// reviseMemory: verdict-driven, no stale 'pending' left behind
// ---------------------------------------------------------------------------

test('reviseMemory: revision stores lineage AND its own verdict route (no stale pending)', async () => {
  const { memoryStore, orchestrator } = makeWorld([
    jevResponse({ verdict: 'accept_local', rationale: 'Correction matches excerpt 2.', confidence: 0.75 }),
  ]);
  const parent = await orchestrator.captureObservation({
    content: 'Filter housing gasket seeps under 2000 PSI.',
    assetId: 'rig-07',
    source: 'technician-raj',
  });
  const result = await orchestrator.reviseMemory(parent.memory_id, {
    content: 'Correction: seep starts under 1800 PSI, not 2000.',
    importance: 0.8,
  });
  assert.equal(result.action, 'UPDATE');
  // Step-2 route: the stored revision carries its OWN verdict — accept_local
  // at importance 0.8 crosses the sync threshold exactly like any memory.
  assert.equal(result.verdictRoute, 'SYNC');
  assert.equal(result.memory.revision_of, parent.memory_id);
  assert.equal(result.memory.version, '2');
  assert.notEqual(result.memory.jev_status, 'pending', 'revision is routed under its own verdict');
  assert.equal(result.memory.jev_status, 'accept_local');
  assert.equal(result.memory.lifecycle_status, 'sync_pending', 'verdict row applied end to end');
  const storedParent = await memoryStore.getMemory(parent.memory_id);
  assert.equal(storedParent.jev_status, 'pending', 'parent untouched');
});

// ---------------------------------------------------------------------------
// Guardrail: the stub stays opt-in, never the default
// ---------------------------------------------------------------------------

test('the stub verdict source is opt-in only: default wiring runs the real Edge JEV', async () => {
  const { ollama, orchestrator } = makeWorld([
    jevResponse({ verdict: 'accept_local', rationale: 'fine', confidence: 0.6 }),
  ]);
  const observation = await orchestrator.captureObservation({
    content: 'Vent line shows minor staining after shutdown.',
    assetId: 'rig-07',
    source: 'technician-raj',
  });
  await orchestrator.routeWithVerdict(observation);
  assert.equal(ollama.generateCalls.length, 1, 'exactly one JEV generate call — the real Edge Pass ran');

  // Explicit stub injection still works for tests/debug (routing unchanged).
  const stubbed = createMemoryOrchestrator({
    config: CONFIG,
    memoryStore: createMemoryStore({ config: CONFIG, qdrant: makeFakeQdrant({ collection: 'aeroedge_edge_memories' }) }),
    verdictSource: stubVerdictSource,
  });
  const obs2 = await stubbed.captureObservation({ content: 'x', assetId: 'a', source: 's' });
  const decision = await stubbed.routeWithVerdict(obs2);
  assert.equal(decision.verdict, 'accept_local');
  assert.equal(decision.action, 'KEEP_LOCAL');
});
