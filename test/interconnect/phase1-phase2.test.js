'use strict';

/**
 * Interconnection tests: Phase 1 (grounded RAG loop) ↔ Phase 2 (hybrid
 * retrieval). Reruns the Phase 1 acceptance behavior — grounded answer
 * referencing document-only content through the full pipeline — and asserts
 * the new Phase 2 requirements on top: hybrid retrieval via Qdrant
 * searchWhere/scrollWithFilter and source citations on every answer.
 *
 * Fully offline (in-memory fakes, deny-all fetch); live-service behavior is
 * covered in test/integration.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createRagPipeline } from '../../edge/rag.js';
import { makeFakeOllama, makeFakeQdrant } from '../helpers/fakes.js';

const CONFIG = Object.freeze({
  OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
  EMBEDDING_MODEL: 'nomic-embed-text',
  OLLAMA_MODEL: 'llama3.1:8b',
  QDRANT_EDGE_URL: 'http://localhost:6333',
  QDRANT_EDGE_COLLECTION: 'aeroedge_edge_docs',
  QDRANT_CLOUD_URL: 'http://localhost:6334',
});

// Phase 1's fixture: document-only facts (fictional part numbers, lubricant,
// interval) that a hallucinating model could not produce unprompted. The
// first paragraph packs the key facts so the top-ranked chunk always carries
// them regardless of toy-embedder ranking quirks.
const DOC = [
  'SkyRay MK-IV actuator (part number ZX-99Q): lubricate with fluorogrease grade F-77 every 33 flight cycles, no exceptions; if temperature exceeds 141 degrees C during retraction, open the quench port on the left side for 8 seconds.',
  'Refer to service bulletin SB-2911-07 for interim inspection of the quench port fitting and actuator torque values.',
].join('\n\n');

function makePipeline() {
  const ollama = makeFakeOllama();
  const qdrant = makeFakeQdrant();
  const pipeline = createRagPipeline({ config: CONFIG, ollama, qdrant });
  return { ollama, qdrant, pipeline };
}

async function ingestFixture(pipeline) {
  return pipeline.ingestDocument({
    documentId: 'doc-skyray-t42',
    text: DOC,
    assetId: 'aircraft-737-MSN4453',
    component: 'hydraulics',
    source: 'SkyRay fictional manual rev T-42 (test fixture)',
    version: 'T-42',
    equipmentModel: 'SkyRay MK-IV',
    docType: 'amm',
    keywords: ['ZX-99Q', 'F-77', 'SB-2911-07'],
    applicability: ['test-asset-skyray'],
  });
}

test('interconnect: Phase 1 acceptance rerun — grounded answer still correct through the hybrid pipeline', async () => {
  const { ollama, qdrant, pipeline } = makePipeline();
  const ingest = await ingestFixture(pipeline);
  assert.ok(ingest.chunkCount >= 1);

  // Phase 1's question (natural language), now answered by the hybrid pipeline.
  const result = await pipeline.answerQuestion(
    'How often must the SkyRay MK-IV actuator be lubricated, and with what grease?'
  );

  // Same embedding model/space: query and chunks all went through embedAll.
  const allEmbedded = ollama.embedCalls.flat();
  assert.ok(allEmbedded.some((t) => t.includes('ZX-99Q')), 'ingestion chunks embedded');
  assert.ok(
    allEmbedded.includes('How often must the SkyRay MK-IV actuator be lubricated, and with what grease?'),
    'the query itself was embedded through the same path'
  );

  // Grounding proof (Phase 1 acceptance, unchanged): document-only facts.
  assert.match(result.answer, /33 flight cycles/i);
  assert.match(result.answer, /F-77/i);

  // NEW (Phase 2): evidence reached the generator through hybrid retrieval.
  assert.ok(
    qdrant.calls.some((c) => c.startsWith('searchWhere:')),
    'semantic leg used the filtered-search surface'
  );

  // NEW (Phase 2): the answer carries source citations that were not
  // required in Phase 1 — every answer names its sources.
  assert.ok(result.citations.length >= 1, 'at least one citation');
  const citation = result.citations.find((c) => c.documentId === 'doc-skyray-t42');
  assert.ok(citation, 'cites the ingested document');
  assert.match(citation.source, /SkyRay fictional manual/);
  assert.ok(citation.chunkIds.length >= 1);
  assert.ok(
    result.chunks.some((c) => citation.chunkIds.includes(c.chunkId)),
    'cited chunkIds correspond to chunks in the evidence pack'
  );
});

test('interconnect: exact error-code query retrieves the same evidence as the symptom query', async () => {
  const { qdrant, pipeline } = makePipeline();
  await ingestFixture(pipeline);

  // Natural-language symptom query (Phase 1 shape).
  const symptom = await pipeline.retrieveEvidence(
    'The actuator runs hot during retraction and we had to open the quench port.'
  );
  // Exact identifier query (Phase 2 shape): the bulletin ID only exists as
  // an exact string in the fixture document.
  const exact = await pipeline.retrieveEvidence('SB-2911-07');

  assert.ok(exact.exactTerms.includes('SB-2911-07'), 'identifier extracted as an exact term');
  assert.ok(
    exact.chunks.some((c) => c.content.includes('SB-2911-07')),
    'exact-code query retrieved the bulletin evidence'
  );
  assert.ok(
    symptom.chunks.some((c) => c.content.includes('141 degrees C')),
    'symptom query retrieved the quench-port evidence'
  );
  // Same underlying document feeds both queries.
  assert.ok(symptom.chunks.some((c) => c.documentId === 'doc-skyray-t42'));
  assert.ok(exact.chunks.some((c) => c.documentId === 'doc-skyray-t42'));

  // Keyword leg really exercised the exact-match surface.
  assert.ok(
    qdrant.calls.some((c) => c.startsWith('scroll:')),
    'keyword leg used scrollWithFilter for exact matching'
  );
});

test('interconnect: metadata filters constrain retrieval on both legs (no cross-asset leakage)', async () => {
  const { pipeline } = makePipeline();
  await ingestFixture(pipeline);
  await pipeline.ingestDocument({
    documentId: 'doc-other-asset',
    text: 'SkyRay MK-V actuator part number AB-77X uses fluorogrease grade F-77 every 10 flight cycles.',
    assetId: 'aircraft-737-MSN9999',
    component: 'hydraulics',
    source: 'SkyRay MK-V manual rev 1',
    version: '1',
    equipmentModel: 'SkyRay MK-V',
    docType: 'amm',
  });

  const filtered = await pipeline.retrieveEvidence('which grease and how many flight cycles', {
    filters: { equipmentModel: 'SkyRay MK-IV' },
  });
  assert.ok(filtered.chunks.length >= 1);
  for (const chunk of filtered.chunks) {
    assert.equal(chunk.equipmentModel, 'SkyRay MK-IV', 'no evidence from other equipment models');
    assert.notEqual(chunk.documentId, 'doc-other-asset');
  }

  const unfiltered = await pipeline.retrieveEvidence('which grease and how many flight cycles', { limit: 8 });
  assert.ok(
    unfiltered.chunks.some((c) => c.documentId === 'doc-other-asset'),
    'without the filter, the other model IS retrievable (control)'
  );
});

test('interconnect: no-evidence path still answers and cites nothing (explicit, not silent)', async () => {
  // Empty store: no evidence can exist, so nothing may be cited.
  const { ollama, pipeline } = makePipeline();

  const result = await pipeline.answerQuestion('what is the fleet-wide exchange rate policy for gaskets');
  assert.equal(result.chunks.length, 0);
  assert.deepEqual(result.citations, [], 'no sources, no citations');
  assert.ok(result.evidence.exactTerms.length === 0);
  assert.ok(ollama.generateCalls.length === 1, 'generation still runs (prompt states no excerpts)');
});

test('interconnect: retrieval and generation are separate stages (direct retrieveEvidence generates nothing)', async () => {
  const { ollama, pipeline } = makePipeline();
  await ingestFixture(pipeline);

  const evidence = await pipeline.retrieveEvidence('How often must the SkyRay MK-IV actuator be lubricated?');
  assert.ok(evidence.chunks.length >= 1, 'evidence pack retrieved');
  assert.ok(evidence.chunks[0].content.length > 0, 'chunk content carried verbatim from the payload');
  assert.equal(evidence.query, 'How often must the SkyRay MK-IV actuator be lubricated?');

  // Exactly ONE embed for the query itself (ingestion already embedded the
  // chunks); zero generation calls — no answer is produced without an
  // explicit generation step. This is the seam JEV will evaluate evidence
  // at, separately from the generator.
  const lastEmbed = ollama.embedCalls[ollama.embedCalls.length - 1];
  assert.deepEqual(lastEmbed, ['How often must the SkyRay MK-IV actuator be lubricated?']);
  assert.equal(ollama.generateCalls.length, 0);
});
