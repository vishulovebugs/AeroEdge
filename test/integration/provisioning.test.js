'use strict';

/**
 * LIVE integration test for Phase 7: provision an edge device for
 * "hydraulic subsystem, Asset X" from a Qdrant Cloud store seeded with
 * MULTIPLE unrelated assets/subsystems, then confirm the resulting Qdrant
 * Edge contains ONLY the relevant subset.
 *
 * Skips cleanly when the Cloud or Edge Qdrant endpoints are unreachable —
 * see the header of test/integration/rag.test.js for setup (any two Qdrant
 * instances work: point QDRANT_CLOUD_URL and QDRANT_EDGE_URL at them).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../shared/config.js';

/** @param {string} url @returns {Promise<boolean>} */
async function isUp(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

function loadConfigOrSkip() {
  try {
    return { config: loadConfig({ envFile: '.env' }), error: null };
  } catch (err) {
    return { config: null, error: /** @type {Error} */ (err) };
  }
}

const loaded = loadConfigOrSkip();
const cloudUp = loaded.config ? await isUp(`${loaded.config.QDRANT_CLOUD_URL}/collections`) : false;
const edgeUp = loaded.config ? await isUp(`${loaded.config.QDRANT_EDGE_URL}/collections`) : false;
const SKIP = Boolean(loaded.error) || !cloudUp || !edgeUp;
const SKIP_REASON = loaded.error
  ? `${loaded.error.message} — see the header of test/integration/rag.test.js for setup instructions.`
  : `Qdrant Cloud or Edge not reachable (cloud: ${cloudUp}, edge: ${edgeUp}) — start both to run this test. ` +
    'See the header of test/integration/rag.test.js for setup instructions.';

/** Track every document id we touch so tests clean up after themselves. */
const cloudDocIds = [];
const edgeDocIds = [];

test('provisioning live: hydraulics/MSN4453 device receives only the relevant subset, not the enterprise database', async (t) => {
  if (SKIP) {
    t.skip(SKIP_REASON);
    return;
  }
  const { createCloudKnowledge } = await import('../../cloud/knowledge.js');
  const { createProvisioning } = await import('../../cloud/provisioning.js');
  const { createQdrantClient } = await import('../../edge/qdrant.js');

  const cloud = createCloudKnowledge({ config: loaded.config });
  const prov = createProvisioning({ config: loaded.config });
  const edgeDocs = createQdrantClient({
    baseUrl: loaded.config.QDRANT_EDGE_URL,
    collection: loaded.config.QDRANT_EDGE_COLLECTION,
  });

  // Seed the ENTERPRISE database: the target asset plus several unrelated ones.
  const TARGET_ASSET = 'MSN4453';
  const docs = [
    {
      documentId: 'ent-msn4453-hydraulics',
      assetId: TARGET_ASSET,
      component: 'hydraulics',
      text:
        'MSN4453 hydraulic system B: normal pressure 2800-3200 PSI. The pump inlet line B-nut is torqued to ' +
        '45 N·m and safety-wired. The thermal relief valve opens above 3400 PSI.',
      source: 'MSN4453 hydraulics manual rev 3',
    },
    {
      documentId: 'ent-msn4453-avionics',
      assetId: TARGET_ASSET,
      component: 'avionics',
      text: 'MSN4453 avionics rack: verify connector seating after panel removal (unrelated subsystem).',
      source: 'MSN4453 avionics manual rev 2',
    },
    {
      documentId: 'ent-msn9999-hydraulics',
      assetId: 'MSN9999',
      component: 'hydraulics',
      text: 'MSN9999 hydraulic system A: pressure specs differ entirely from MSN4453 (unrelated asset).',
      source: 'MSN9999 hydraulics manual rev 8',
    },
    {
      documentId: 'ent-fleet-galley',
      assetId: 'FLEET-STANDARD',
      component: 'galley',
      text: 'Fleet galley standard: coffee maker descaling interval is 90 days (unrelated everything).',
      source: 'Fleet galley standard rev 1',
    },
  ];
  try {
    for (const doc of docs) {
      await cloud.ingestDocument({ ...doc, docType: 'manual', version: '1' });
      cloudDocIds.push(doc.documentId);
    }

    // PROVISION: "hydraulic subsystem, Asset X".
    const result = await prov.provisionEdgeDevice({ assetId: TARGET_ASSET, component: 'hydraulics' });
    edgeDocIds.push(...result.documentIds);

    // The relevant subset arrived.
    assert.ok(result.transferred > 0, 'relevant knowledge transferred');
    assert.equal(result.truncated, false, 'small store: nothing truncated');
    assert.deepEqual(result.documentIds, ['ent-msn4453-hydraulics'], 'ONLY the matching document provisioned');

    // …and NOTHING else did: inspect the edge store directly.
    for (const excluded of ['ent-msn4453-avionics', 'ent-msn9999-hydraulics', 'ent-fleet-galley']) {
      const hits = await edgeDocs.scrollWithFilter(
        { must: [{ key: 'document_id', match: { value: excluded } }] },
        { limit: 10 }
      );
      assert.equal(hits.length, 0, `${excluded} must NOT appear on the device`);
    }
    const provisioned = await edgeDocs.scrollWithFilter(
      { must: [{ key: 'document_id', match: { value: 'ent-msn4453-hydraulics' } }] },
      { limit: 10 }
    );
    assert.ok(provisioned.length > 0);
    for (const hit of provisioned) {
      assert.equal(hit.payload.asset_id, TARGET_ASSET);
      assert.equal(hit.payload.component, 'hydraulics');
      assert.equal(hit.payload.jev_status, 'not_applicable', 'pre-trusted standing carried from cloud');
    }

    // Re-provisioning is idempotent (delta/snapshot semantics, not duplicates).
    const again = await prov.provisionEdgeDevice({ assetId: TARGET_ASSET, component: 'hydraulics' });
    assert.equal(again.transferred, result.transferred);
    const after = await edgeDocs.scrollWithFilter(
      { must: [{ key: 'document_id', match: { value: 'ent-msn4453-hydraulics' } }] },
      { limit: 10 }
    );
    assert.equal(after.length, provisioned.length, 'no duplicates after re-provisioning');
  } finally {
    // Cleanup both sides (test isolation on shared dev instances).
    const { createQdrantClient: cq } = await import('../../edge/qdrant.js');
    const cloudClient = cq({ baseUrl: loaded.config.QDRANT_CLOUD_URL, collection: loaded.config.QDRANT_CLOUD_COLLECTION });
    for (const id of cloudDocIds) await cloudClient.deleteByDocument(id);
    for (const id of edgeDocIds) await edgeDocs.deleteByDocument(id);
  }
});
