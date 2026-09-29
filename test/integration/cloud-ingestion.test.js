'use strict';

/**
 * LIVE integration test for Phase 6: the Cloud Knowledge Layer against a
 * real Qdrant instance at QDRANT_CLOUD_URL (skips cleanly when unreachable —
 * see the header of test/integration/rag.test.js for setup; any Qdrant
 * works for this test by pointing QDRANT_CLOUD_URL at it, since "Cloud" is
 * an architectural role, not a specific host).
 *
 * Acceptance criterion: a cloud document is ingested and represented in the
 * enterprise knowledge store, with NO JEV pass applied to it.
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
const SKIP = Boolean(loaded.error) || !cloudUp;
const SKIP_REASON = loaded.error
  ? `${loaded.error.message} — see the header of test/integration/rag.test.js for setup instructions.`
  : 'Qdrant Cloud endpoint not reachable — start a Qdrant instance at QDRANT_CLOUD_URL to run this test. ' +
    'See the header of test/integration/rag.test.js for setup instructions.';

const DOC_ID = 'test-doc-cloud-enterprise-standard';

test('cloud knowledge layer live: enterprise document ingested, queryable from Qdrant Cloud, no JEV pass', async (t) => {
  if (SKIP) {
    t.skip(SKIP_REASON);
    return;
  }
  const { createCloudKnowledge } = await import('../../cloud/knowledge.js');
  const cloud = createCloudKnowledge({ config: loaded.config });

  try {
    // Ingest a small enterprise document through the CLOUD pipeline.
    const result = await cloud.ingestDocument({
      documentId: DOC_ID,
      text:
        'Enterprise fleet standard for hydraulic system B: normal operating pressure is 2800-3200 PSI. ' +
        'The pump inlet line B-nut is torqued to 45 N·m and safety-wired (fictional enterprise fixture).',
      assetId: 'FLEET-STANDARD',
      component: 'hydraulics',
      source: 'Enterprise engineering standard rev 12 (test fixture)',
      version: '12',
      docType: 'standard',
    });

    // Represented in the enterprise (Cloud) store.
    assert.ok(result.chunkCount > 0);
    assert.equal(result.collection, loaded.config.QDRANT_CLOUD_COLLECTION);
    assert.equal(result.jevStatus, 'not_applicable', 'the ingest result reports the standing');

    // Queryable from Qdrant Cloud.
    const out = await cloud.search('what torque applies to the pump inlet B-nut?');
    assert.ok(out.chunks.length > 0, 'enterprise content is queryable');
    assert.match(out.chunks[0].content, /45 N·m/);
    assert.equal(out.chunks[0].jevStatus, 'not_applicable', 'stored chunks carry the JEV standing');
    assert.ok(out.chunks.every((c) => c.documentId === DOC_ID));

    // NO JEV pass: jev_status is 'not_applicable' — never pending, never
    // evaluated. (A JEV pass would have produced accept_local/etc. with a
    // verdict record; enterprise input bypasses JEV by design.)
    assert.notEqual(out.chunks[0].jevStatus, 'pending');
    for (const status of ['accept_local', 'needs_more_evidence', 'flag_risk']) {
      assert.notEqual(out.chunks[0].jevStatus, status);
    }
  } finally {
    await cloud.deleteByDocument(DOC_ID);
  }
});
