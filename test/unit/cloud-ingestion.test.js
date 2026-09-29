'use strict';

/**
 * Unit tests for Phase 6: the Cloud Knowledge Layer (cloud/knowledge.js).
 *
 * The contract under test: cloud ingestion ALWAYS stamps
 * jev_status "not_applicable" (enterprise documents arrive pre-trusted —
 * no JEV pass on controlled enterprise input), writes ONLY to the Qdrant
 * Cloud store (never an edge collection), and is queryable + idempotent.
 * All offline, via the shared fakes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createCloudKnowledge, CLOUD_JEV_STATUS } from '../../cloud/knowledge.js';
import { validateDocumentChunk } from '../../shared/schemas.js';
import { makeFakeOllama, makeFakeQdrant } from '../helpers/fakes.js';

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

function makeCloud() {
  const ollama = makeFakeOllama();
  const cloudQdrant = makeFakeQdrant({ collection: 'aeroedge_cloud_docs' });
  const cloud = createCloudKnowledge({ config: CONFIG, ollama, qdrant: cloudQdrant });
  return { ollama, cloudQdrant, cloud };
}

const DOC = {
  documentId: 'ent-hydraulics-manual',
  text: 'Enterprise hydraulic standard: system B operates at 2800-3200 PSI.\n\nThe inlet B-nut is torqued to 45 N·m and safety-wired.',
  assetId: 'FLEET-STANDARD',
  component: 'hydraulics',
  source: 'Enterprise engineering standard rev 12',
  version: '12',
  docType: 'standard',
};

// ---------------------------------------------------------------------------
// THE contract: always not_applicable, stamped in code
// ---------------------------------------------------------------------------

test('cloud ingestion stamps jev_status "not_applicable" on EVERY chunk', async () => {
  const { cloudQdrant, cloud } = makeCloud();
  await cloud.ingestDocument(DOC);

  assert.ok(cloudQdrant.size() > 1, 'document chunked into multiple points');
  for (const hit of await cloudQdrant.scrollWithFilter({}, { limit: 100 })) {
    assert.equal(hit.payload.jev_status, 'not_applicable', `chunk ${hit.id} carries the JEV standing`);
  }
});

test('CLOUD_JEV_STATUS is the exported contract value; factory reports it', () => {
  const { cloud } = makeCloud();
  assert.equal(CLOUD_JEV_STATUS, 'not_applicable');
  assert.equal(cloud.jevStatus, 'not_applicable');
});

test('no caller input can override the JEV stamp (not a caller-set field)', async () => {
  const { cloudQdrant, cloud } = makeCloud();
  // A hostile/mistaken caller attaching jev_status to the argument cannot
  // change the stamp: ingestDocument destructures only known fields, and
  // the payload stamp is set unconditionally inside the pipeline.
  const hostile = Object.assign({}, DOC);
  /** @type {any} */ (hostile).jev_status = 'validated';
  await cloud.ingestDocument(hostile);
  for (const hit of await cloudQdrant.scrollWithFilter({}, { limit: 100 })) {
    assert.equal(hit.payload.jev_status, 'not_applicable');
  }
});

test('cloud chunks pass the shared DocumentChunk contract gate with jev_status present', async () => {
  // The exact record shape the pipeline builds, validated directly.
  const check = validateDocumentChunk({
    id: '00000000-0000-4000-8000-000000000000',
    document_id: 'd',
    version: '1',
    content: 'c',
    embedding: [0.1, 0.2],
    asset_id: 'a',
    component: 'c',
    source: 's',
    jev_status: 'not_applicable',
    created_at: '2026-09-29T00:00:00.000Z',
    updated_at: '2026-09-29T00:00:00.000Z',
  });
  assert.equal(check.valid, true, check.errors.join('; '));

  // An INVALID jev_status value is rejected by the schema.
  const bad = validateDocumentChunk({
    id: '00000000-0000-4000-8000-000000000001',
    document_id: 'd',
    version: '1',
    content: 'c',
    embedding: [0.1],
    asset_id: 'a',
    component: 'c',
    source: 's',
    jev_status: 'banana',
    created_at: '2026-09-29T00:00:00.000Z',
    updated_at: '2026-09-29T00:00:00.000Z',
  });
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.some((e) => e.includes('jev_status')));
});

test('edge-shape chunks WITHOUT jev_status remain valid (byte compatibility, Phases 1-5)', () => {
  const check = validateDocumentChunk({
    id: '00000000-0000-4000-8000-000000000002',
    document_id: 'd',
    version: '1',
    content: 'c',
    embedding: [0.1],
    asset_id: 'a',
    component: 'c',
    source: 's',
    created_at: '2026-09-29T00:00:00.000Z',
    updated_at: '2026-09-29T00:00:00.000Z',
  });
  assert.equal(check.valid, true, 'absent jev_status must stay valid for edge chunks');
});

// ---------------------------------------------------------------------------
// Cloud-only writes; ingestion is queryable and idempotent
// ---------------------------------------------------------------------------

test('cloud pipeline writes to the CLOUD collection only (never an edge collection)', async () => {
  const { cloudQdrant, cloud } = makeCloud();
  const result = await cloud.ingestDocument(DOC);
  assert.equal(result.collection, 'aeroedge_cloud_docs');
  assert.equal(cloudQdrant.collection, 'aeroedge_cloud_docs');
  assert.ok(cloudQdrant.size() > 0, 'points live in the cloud store');
});

test('cloud ingestion is idempotent per documentId (replace-and-upsert)', async () => {
  const { cloudQdrant, cloud } = makeCloud();
  const first = await cloud.ingestDocument(DOC);
  const sizeAfterFirst = cloudQdrant.size();
  const second = await cloud.ingestDocument(DOC);
  assert.equal(cloudQdrant.size(), sizeAfterFirst, 're-ingestion replaces, never duplicates');
  assert.equal(second.chunkCount, first.chunkCount);
  assert.notDeepEqual(second.chunkIds, first.chunkIds, 'fresh chunk UUIDs per run, like the edge pipeline');
  // Content survives replacement with the JEV stamp intact.
  const out = await cloud.search('torque inlet');
  assert.equal(out.chunks[0].jevStatus, 'not_applicable');
});

test('cloud search returns ingested enterprise content with its JEV standing', async () => {
  const { cloud } = makeCloud();
  await cloud.ingestDocument(DOC);
  const out = await cloud.search('what torque applies to the inlet B-nut?');
  assert.ok(out.chunks.length > 0);
  assert.match(out.chunks[0].content, /45 N·m/);
  assert.equal(out.chunks[0].jevStatus, 'not_applicable');
});

test('cloud search respects metadata filters and rejects unknown ones', async () => {
  const { cloud } = makeCloud();
  await cloud.ingestDocument(DOC);
  const hit = await cloud.search('pressure range', { filters: { assetId: 'FLEET-STANDARD' } });
  assert.ok(hit.chunks.length > 0);
  const miss = await cloud.search('pressure range', { filters: { assetId: 'NOPE' } });
  assert.equal(miss.chunks.length, 0);
  await assert.rejects(cloud.search('q', { filters: { hai: 1 } }), /unknown filter field/);
});

test('cloud ingestion validates inputs like the edge pipeline (loud TypeErrors)', async () => {
  const { cloud } = makeCloud();
  await assert.rejects(cloud.ingestDocument({ ...DOC, documentId: ' ' }), /"documentId"/);
  await assert.rejects(cloud.ingestDocument({ ...DOC, text: '' }), /"text"/);
  await assert.rejects(cloud.ingestDocument({ ...DOC, text: '   ' }), /"text"/);
  await assert.rejects(cloud.ingestDocument({ ...DOC, keywords: ['ok', ''] }), /"keywords"/);
});

test('factory builds a CLOUD-bound client from bare config (no injection)', () => {
  const cloud = createCloudKnowledge({ config: CONFIG });
  assert.equal(cloud.qdrantClient.collection, 'aeroedge_cloud_docs');
});
