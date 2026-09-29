'use strict';

/**
 * Unit tests for Phase 7: Edge Provisioning (cloud/provisioning.js).
 *
 * The contract under test: selection returns ONLY knowledge matching the
 * target (asset/model/subsystem/job terms) — with non-matching content
 * EXCLUDED, not just matching content included; a large matching subset is
 * prioritized and CAPPED, never dumped; the package is deterministic; and
 * transfer writes only into the Edge documents store with exact vectors.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createProvisioning,
  PROVISIONING_FORMAT,
  DEFAULT_MAX_CHUNKS,
} from '../../cloud/provisioning.js';
import { makeFakeQdrant } from '../helpers/fakes.js';

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

/** A fresh cloud+edge pair per test (no shared state between tests). */
function makeWorld() {
  const cloud = makeFakeQdrant({ collection: 'aeroedge_cloud_docs' });
  const edge = makeFakeQdrant({ collection: 'aeroedge_edge_docs' });
  const prov = createProvisioning({ config: CONFIG, cloudQdrant: cloud, edgeQdrant: edge });
  return { cloud, edge, prov };
}

let chunkCounter = 0;
/**
 * Seed a cloud chunk exactly the way Phase 6 ingestion stores it.
 * @param {ReturnType<typeof makeFakeQdrant>} cloud
 */
function cloudChunk(cloud, patch = {}) {
  chunkCounter += 1;
  const id = patch.id ?? `00000000-0000-4000-8000-${String(chunkCounter).padStart(12, '0')}`;
  cloud.upsertPoints([
    {
      id,
      vector: patch.vector ?? [chunkCounter / 100, 0.5],
      payload: {
        id,
        document_id: patch.documentId ?? 'ent-doc',
        version: patch.version ?? '1',
        content: patch.content ?? 'Generic enterprise content.',
        asset_id: patch.assetId ?? 'FLEET-STANDARD',
        component: patch.component ?? 'hydraulics',
        source: patch.source ?? 'Enterprise standard rev 12',
        jev_status: patch.jevStatus ?? 'not_applicable',
        ...(patch.importance !== undefined ? { importance: patch.importance } : {}),
        ...(patch.equipmentModel !== undefined ? { equipment_model: patch.equipmentModel } : {}),
      },
    },
  ]);
  return id;
}

// ---------------------------------------------------------------------------
// Selection: matching-only, with EXPLICIT exclusion checks
// ---------------------------------------------------------------------------

test('selection includes only chunks matching the target subsystem and EXCLUDES the rest', async () => {
  const { cloud, prov } = makeWorld();
  const hyd = cloudChunk(cloud, { content: 'Hydraulic pump overhaul spec.', component: 'hydraulics' });
  const avio = cloudChunk(cloud, { content: 'Avionics rack cleaning procedure.', component: 'avionics' });

  const { items, totalAvailable } = await prov.selectKnowledge({ component: 'hydraulics' });
  const ids = items.map((i) => i.cloudChunkId);
  assert.ok(ids.includes(hyd), 'matching chunk included');
  assert.ok(!ids.includes(avio), 'NON-matching chunk EXCLUDED (exclusion, not inclusion luck)');
  assert.equal(totalAvailable, 1);
  assert.equal(items[0].jevStatus, 'not_applicable');
});

test('selection excludes other assets and non-pre-trusted (non-enterprise) cloud content', async () => {
  const { cloud, prov } = makeWorld();
  const ours = cloudChunk(cloud, { assetId: 'MSN4453', content: 'ours' });
  const otherAsset = cloudChunk(cloud, { assetId: 'MSN9999', content: 'other asset' });
  const fieldKnowledge = cloudChunk(cloud, { assetId: 'MSN4453', content: 'fleet memory', jevStatus: 'validated' });

  const { items } = await prov.selectKnowledge({ assetId: 'MSN4453', component: 'hydraulics' });
  const ids = items.map((i) => i.cloudChunkId);
  assert.ok(ids.includes(ours));
  assert.ok(!ids.includes(otherAsset), 'different asset EXCLUDED');
  assert.ok(!ids.includes(fieldKnowledge), 'JEV-evaluated cloud content EXCLUDED (not enterprise input)');
});

test('selection by equipment model excludes other models', async () => {
  const { cloud, prov } = makeWorld();
  const mk4 = cloudChunk(cloud, { equipmentModel: 'SkyRay MK-IV', content: 'MK-IV procedure' });
  const mk5 = cloudChunk(cloud, { equipmentModel: 'SkyRay MK-V', content: 'MK-V procedure' });
  const { items } = await prov.selectKnowledge({ equipmentModel: 'SkyRay MK-IV' });
  const ids = items.map((i) => i.cloudChunkId);
  assert.ok(ids.includes(mk4));
  assert.ok(!ids.includes(mk5), 'other equipment model EXCLUDED');
});

test('jobTerms select by exact term presence (OR semantics), excluding term-less chunks', async () => {
  const { cloud, prov } = makeWorld();
  const matches = cloudChunk(cloud, { content: 'The ERR-4212 fault requires a quench valve check.', assetId: 'MSN4453' });
  const noMatch = cloudChunk(cloud, { content: 'Routine inspection notes.', assetId: 'MSN4453' });
  const { items } = await prov.selectKnowledge({ assetId: 'MSN4453', jobTerms: ['ERR-4212'] });
  const ids = items.map((i) => i.cloudChunkId);
  assert.ok(ids.includes(matches));
  assert.ok(!ids.includes(noMatch), 'chunk without the term EXCLUDED');
});

test('empty target is REFUSED: provisioning everything is the enterprise database', async () => {
  const { prov } = makeWorld();
  await assert.rejects(prov.selectKnowledge({}), /enterprise database is refused/);
  await assert.rejects(prov.buildProvisioningPackage({}), /enterprise database is refused/);
  await assert.rejects(prov.provisionEdgeDevice({}), /enterprise database is refused/);
});

test('unknown target fields and malformed values are rejected loudly', async () => {
  const { prov } = makeWorld();
  await assert.rejects(prov.selectKnowledge({ assetId: 'a', hai: 1 }), /unknown field/);
  await assert.rejects(prov.selectKnowledge({ assetId: ' ' }), /"assetId"/);
  await assert.rejects(prov.selectKnowledge({ jobTerms: ['ok', ''] }), /"jobTerms"/);
  await assert.rejects(prov.selectKnowledge({ component: 'x' }, { maxChunks: 0 }), /maxChunks/);
});

// ---------------------------------------------------------------------------
// Prioritization: curated subset under a cap, never a dump
// ---------------------------------------------------------------------------

test('large matching subsets are capped to the highest-priority items, truncation reported', async () => {
  const { cloud, prov } = makeWorld();
  for (let i = 1; i <= 30; i++) {
    cloudChunk(cloud, { importance: i / 31, content: `Chunk number ${i} of the flood.` });
  }
  const { items, totalAvailable, truncated } = await prov.selectKnowledge({ component: 'hydraulics' }, { maxChunks: 10 });
  assert.equal(totalAvailable, 30);
  assert.equal(items.length, 10, 'capped, not dumped');
  assert.equal(truncated, true, 'truncation is REPORTED, never silent');
  const importances = items.map((i) => i.payload.importance);
  assert.ok(Math.min(...importances) > 20 / 31, 'lowest-importance matching chunks dropped first');
});

test('prioritization is deterministic: same cloud state, same selection order', async () => {
  const { cloud, prov } = makeWorld();
  for (let i = 1; i <= 9; i++) cloudChunk(cloud, { content: `Item ${i}.`, importance: 0.5 });
  const a = await prov.selectKnowledge({ component: 'hydraulics' }, { maxChunks: 5 });
  const b = await prov.selectKnowledge({ component: 'hydraulics' }, { maxChunks: 5 });
  assert.deepEqual(a.items.map((i) => i.cloudChunkId), b.items.map((i) => i.cloudChunkId));
});

test('under the cap, job-term relevance outranks generic content', async () => {
  const { cloud, prov } = makeWorld();
  for (let i = 1; i <= 8; i++) cloudChunk(cloud, { content: `Generic filler paragraph ${i}.`, importance: 0.9 });
  const special = cloudChunk(cloud, { content: 'Critical procedure for SB-2911-07 with step-by-step torque values.', importance: 0.5 });
  const { items } = await prov.selectKnowledge({ jobTerms: ['SB-2911-07'] }, { maxChunks: 3 });
  assert.equal(items[0].cloudChunkId, special, 'job-relevant chunk prioritized above generic filler');
});

// ---------------------------------------------------------------------------
// Package + transfer: deterministic, exact vectors, edge-only writes
// ---------------------------------------------------------------------------

test('package is self-describing and re-transfer is idempotent (replace, never duplicate)', async () => {
  const { cloud, edge, prov } = makeWorld();
  cloudChunk(cloud, { documentId: 'ent-a', content: 'Doc A chunk 1.', assetId: 'MSN4453' });
  cloudChunk(cloud, { documentId: 'ent-a', content: 'Doc A chunk 2.', assetId: 'MSN4453' });

  const pkg = await prov.buildProvisioningPackage({ assetId: 'MSN4453' });
  assert.equal(pkg.format, PROVISIONING_FORMAT);
  assert.deepEqual(pkg.target, { assetId: 'MSN4453' });
  assert.equal(pkg.truncated, false);
  assert.equal(pkg.items.length, 2);

  const first = await prov.transferToEdge(pkg);
  const sizeAfterFirst = edge.size();
  const second = await prov.transferToEdge(pkg);
  assert.equal(second.transferred, first.transferred);
  assert.equal(edge.size(), sizeAfterFirst, 're-transfer REPLACES, never duplicates');
  assert.deepEqual(second.documentIds.sort(), ['ent-a']);
  assert.equal(second.edgeCollection, 'aeroedge_edge_docs');
});

test('transfer moves EXACT vectors (never re-embeds) and preserves the pre-trusted standing', async () => {
  const { cloud, edge, prov } = makeWorld();
  const vec = [0.25, 0.75, 0.5];
  const id = cloudChunk(cloud, { vector: vec, content: 'Vector fidelity check.' });
  const pkg = await prov.buildProvisioningPackage({ assetId: 'FLEET-STANDARD' });
  await prov.transferToEdge(pkg);

  assert.equal(edge.has(id), true);
  const [hit] = await edge.scrollWithFilter({}, { limit: 1, withVector: true });
  assert.deepEqual(hit.vector, vec, 'edge vector IS the cloud vector, verbatim');
  assert.equal(hit.payload.jev_status, 'not_applicable', 'provisioned chunks keep the pre-trusted standing');
  assert.equal(hit.payload.id, id, 'chunk identity preserved');
});

test('transfer writes ONLY to the edge documents store; cloud is untouched', async () => {
  const { cloud, edge, prov } = makeWorld();
  cloudChunk(cloud, { content: 'Only edge docs get this.' });
  const beforeCloud = cloud.size();
  const pkg = await prov.buildProvisioningPackage({ component: 'hydraulics' });
  await prov.transferToEdge(pkg);
  assert.equal(cloud.size(), beforeCloud, 'cloud store untouched by transfer');
  assert.equal(edge.collection, 'aeroedge_edge_docs');
  assert.notEqual(edge.collection, CONFIG.QDRANT_EDGE_MEMORY_COLLECTION, 'never the memory collection');
});

test('provisionEdgeDevice composes the full pipeline and reports truncation honestly', async () => {
  const { cloud, prov } = makeWorld();
  for (let i = 1; i <= 6; i++) cloudChunk(cloud, { content: `Bulk item ${i}.`, importance: i / 7 });
  const result = await prov.provisionEdgeDevice({ component: 'hydraulics' }, { maxChunks: 4 });
  assert.equal(result.transferred, 4);
  assert.equal(result.totalAvailable, 6);
  assert.equal(result.truncated, true);
  assert.equal(result.edgeCollection, 'aeroedge_edge_docs');
});

test('a target matching nothing transfers nothing (explicit no-op, not an error)', async () => {
  const { prov } = makeWorld();
  const result = await prov.provisionEdgeDevice({ assetId: 'NO-SUCH-ASSET' });
  assert.equal(result.transferred, 0);
  assert.equal(result.totalAvailable, 0);
  assert.equal(result.truncated, false);
});

test('DEFAULT_MAX_CHUNKS is a bounded device budget', () => {
  assert.ok(DEFAULT_MAX_CHUNKS > 0 && DEFAULT_MAX_CHUNKS <= 1000);
});
