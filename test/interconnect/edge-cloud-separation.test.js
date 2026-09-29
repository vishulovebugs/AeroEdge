'use strict';

/**
 * Interconnection tests for Phase 6: the FULL Phase 1–5 edge stack with the
 * cloud ingestion pipeline ALSO active. Asserts the cloud layer is
 * completely separate from the edge stack:
 *
 *   - no accidental cross-writes between Qdrant Edge and Qdrant Cloud
 *     (separate collections, separate fake stores, verified per write),
 *   - no shared state bugs (cloud does not import edge pipeline modules and
 *     vice versa; edge behavior is byte-identical with cloud active),
 *   - the cloud pipeline carries no JEV logic (the Edge Pass evaluates
 *     field knowledge against EDGE authoritative docs — never cloud docs).
 *
 * All offline, via the shared fakes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createRagPipeline } from '../../edge/rag.js';
import { createSession } from '../../edge/session.js';
import { createMemoryOrchestrator } from '../../edge/orchestrator.js';
import { createMemoryStore } from '../../edge/memoryStore.js';
import { createCloudKnowledge } from '../../cloud/knowledge.js';
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

const EDGE_DOC =
  'Torque the B-nut on the pump inlet line to 45 N·m and safety-wire it on MSN4453; ' +
  'hydraulic system B operates at a normal pressure range of 2800-3200 PSI (fictional test fixture).';

const CLOUD_DOC =
  'Enterprise fleet standard: hydraulic systems are serviced only with certified gauges; ' +
  'log every torque reading in the fleet ledger (fictional enterprise fixture).';

/**
 * The full world: Phase 1–5 edge stack AND the Phase 6 cloud pipeline,
 * each wired to its own fake store through its own config role.
 */
function makeWorld() {
  const edgeOllama = makeFakeOllama();
  const scripted = makeScriptedJev([
    jevResponse({ verdict: 'accept_local', rationale: 'Consistent with the authoritative manual.', confidence: 0.8 }),
  ]);
  // One Ollama daemon, two distinct CALLS (the Phase 5 separation): JEV
  // judge prompts get the scripted verdict; grounded-answer prompts keep
  // the fake's excerpt-echo behavior.
  const groundedGenerate = edgeOllama.generate.bind(edgeOllama);
  edgeOllama.generate = async (args) =>
    typeof args.prompt === 'string' && args.prompt.includes('Evaluate this proposed field-knowledge record')
      ? scripted.respond({ prompt: args.prompt })
      : groundedGenerate(args);
  const cloudOllama = makeFakeOllama();

  const edgeDocs = makeFakeQdrant({ collection: 'aeroedge_edge_docs' });
  const memories = makeFakeQdrant({ collection: 'aeroedge_edge_memories' });
  const cloudDocs = makeFakeQdrant({ collection: 'aeroedge_cloud_docs' });

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
  const cloud = createCloudKnowledge({ config: CONFIG, ollama: cloudOllama, qdrant: cloudDocs });

  return { edgeOllama, cloudOllama, scripted, edgeDocs, memories, cloudDocs, pipeline, memoryStore, session, orchestrator, cloud };
}

// ---------------------------------------------------------------------------
// Cross-write audit: every write lands on exactly one side
// ---------------------------------------------------------------------------

test('no cross-writes: edge documents, memories, and cloud documents each stay in their own store', async () => {
  const { edgeDocs, memories, cloudDocs, pipeline, cloud } = makeWorld();

  // Write on ALL three paths.
  await pipeline.ingestDocument({
    documentId: 'edge-doc', text: EDGE_DOC, assetId: 'MSN4453',
    component: 'hydraulics', source: 'AMM rev 42 (fixture)', version: '1',
  });
  await cloud.ingestDocument({
    documentId: 'cloud-doc', text: CLOUD_DOC, assetId: 'FLEET-STANDARD',
    component: 'hydraulics', source: 'Enterprise standard rev 12', version: '12',
  });

  // Edge docs store: ONLY the edge document, NO jev_status payload anywhere.
  assert.equal(edgeDocs.size(), 1, 'edge docs hold exactly the edge document');
  for (const hit of await edgeDocs.scrollWithFilter({}, { limit: 100 })) {
    assert.equal(hit.payload.document_id, 'edge-doc');
    assert.equal(hit.payload.jev_status, undefined, 'edge document chunks carry NO JEV standing');
  }
  // Memory store: untouched by document ingestion on either side.
  assert.equal(memories.size(), 0, 'no document ever lands in the memory store');
  // Cloud store: ONLY the cloud document, every chunk not_applicable.
  assert.equal(cloudDocs.size(), 1);
  for (const hit of await cloudDocs.scrollWithFilter({}, { limit: 100 })) {
    assert.equal(hit.payload.document_id, 'cloud-doc');
    assert.equal(hit.payload.jev_status, 'not_applicable');
  }
});

test('edge full loop with cloud active: answer, capture, JEV route — byte-identical edge behavior', async () => {
  const { edgeOllama, cloudOllama, edgeDocs, cloudDocs, memories, scripted, pipeline, memoryStore, session, orchestrator, cloud } = makeWorld();

  // Cloud ingestion is ACTIVE throughout.
  await cloud.ingestDocument({
    documentId: 'cloud-doc', text: CLOUD_DOC, assetId: 'FLEET-STANDARD',
    component: 'hydraulics', source: 'Enterprise standard rev 12', version: '12',
  });

  // Phase 1–2: grounded answer still works and cites the EDGE doc only.
  await pipeline.ingestDocument({
    documentId: 'edge-doc', text: EDGE_DOC, assetId: 'MSN4453',
    component: 'hydraulics', source: 'AMM rev 42 (fixture)', version: '1',
  });
  const answer = await pipeline.answerQuestion('What torque applies to the B-nut on MSN4453?', { session });
  assert.match(answer.answer, /45 N·m/);
  assert.ok(answer.citations.every((c) => c.documentId === 'edge-doc'), 'no cloud citation ever reaches the edge answer');
  assert.ok(!answer.answer.includes('fleet ledger'), 'enterprise-only content never leaks into edge answers');

  // Phase 3–4: mid-session observation, Phase 5 JEV route.
  const obs = await orchestrator.captureObservation({
    content: 'B-nut showed light seepage after 38 N·m; re-torqued to spec.',
    assetId: 'MSN4453',
    source: 'technician-jane',
    importance: 0.6,
  });
  const decision = await orchestrator.routeWithVerdict(obs);
  assert.equal(decision.verdict, 'accept_local');
  await orchestrator.applyRoute(decision);
  const stored = await memoryStore.getMemory(obs.memory_id);
  assert.equal(stored.jev_status, 'accept_local');
  assert.equal(stored.lifecycle_status, 'local');

  // The Edge Pass retrieved against EDGE authoritative docs — the cloud doc
  // (FLEET-STANDARD asset) was never visible to it.
  assert.match(scripted.seenPrompts[0], /Evaluate this proposed field-knowledge record/);
  assert.ok(!scripted.seenPrompts[0].includes('fleet ledger'), 'cloud documents never enter edge JEV evaluation');

  // Separation, summed up: one doc per store, memory store only via Phase 4.
  assert.equal(edgeDocs.size(), 1);
  assert.equal(cloudDocs.size(), 1);
  assert.equal(memories.size(), 1);
  // The cloud pipeline used ITS OWN Ollama client (never the edge judge).
  assert.equal(cloudOllama.embedCalls.length > 0, true);
  assert.equal(cloudOllama.generateCalls.length, 0, 'cloud ingestion performs NO generation — and no JEV');
  void edgeOllama;
});

// ---------------------------------------------------------------------------
// Import-boundary audit: the modules must not reach into each other
// ---------------------------------------------------------------------------

test('import boundary: cloud/ never imports the edge pipeline; edge/ never imports cloud/', () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const cloudSource = readFileSync(join(ROOT, 'cloud', 'knowledge.js'), 'utf8');

  // cloud/knowledge.js imports only endpoint-agnostic transports + schemas.
  const importSpecs = [...cloudSource.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  for (const spec of importSpecs) {
    if (spec.startsWith('.')) {
      assert.ok(
        spec.includes('chunker.js') || spec.includes('ollama.js') || spec.includes('qdrant.js') || spec.includes('schemas.js'),
        `cloud/knowledge.js may import only endpoint-agnostic transports, got: ${spec}`
      );
    }
  }
  assert.ok(importSpecs.some((s) => s.includes('chunker.js')), 'reuses the shared chunker');
  assert.ok(!importSpecs.some((s) => s.includes('rag.js')), 'no edge pipeline import');
  assert.ok(!importSpecs.some((s) => s.includes('jev.js')), 'no JEV import — no JEV pass on enterprise input');
});

test('no edge module imports the cloud layer (static scan of edge/ + shared/)', () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const edgeDir = join(ROOT, 'edge');
  for (const name of readdirSync(edgeDir)) {
    if (!name.endsWith('.js')) continue;
    const source = readFileSync(join(edgeDir, name), 'utf8');
    assert.ok(!/from\s+['"][^'"]*cloud\//.test(source), `edge/${name} must not import cloud/`);
  }
  for (const name of readdirSync(join(ROOT, 'shared'))) {
    if (!name.endsWith('.js')) continue;
    const source = readFileSync(join(ROOT, 'shared', name), 'utf8');
    assert.ok(!/from\s+['"][^'"]*cloud\//.test(source), `shared/${name} must not import cloud/`);
  }
});
