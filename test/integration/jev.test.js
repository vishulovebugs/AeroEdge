'use strict';

/**
 * LIVE integration tests for Phase 5: the JEV Edge Pass end to end against
 * real Ollama + real Qdrant Edge (skips cleanly when either is unreachable —
 * see the header of test/integration/rag.test.js for setup).
 *
 * The acceptance criterion of this phase, exercised LIVE: an observation
 * that contradicts a seeded high-confidence safety procedure comes back
 * flag_risk, IS STILL RECORDED, and is VISIBLY FLAGGED in the stored and
 * returned data — never silently accepted, never discarded.
 *
 * The evaluation itself is a live-model call; assertions on the verdict are
 * therefore semantic (the specific safety contradiction is flagged) rather
 * than string-exact.
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
const ollamaUp = loaded.config ? await isUp(`${loaded.config.OLLAMA_BASE_URL}/api/tags`) : false;
const qdrantUp = loaded.config ? await isUp(`${loaded.config.QDRANT_EDGE_URL}/collections`) : false;
const SKIP = Boolean(loaded.error) || !ollamaUp || !qdrantUp;
const SKIP_REASON = loaded.error
  ? `${loaded.error.message} — see the header of test/integration/rag.test.js for setup instructions.`
  : `Ollama or Qdrant Edge not reachable (ollama: ${ollamaUp}, qdrant: ${qdrantUp}) — start them locally to run this test. ` +
    'See the header of test/integration/rag.test.js for setup instructions.';

const DOC_ID = 'test-doc-jev-safety-procedure';
const MEM_ASSET = 'MSN4453';

/**
 * Ingest the authoritative safety procedure and set up a full Phase 4+5
 * world (real clients). Returns everything the tests need, plus a cleanup.
 */
async function makeLiveWorld() {
  const { createRagPipeline } = await import('../../edge/rag.js');
  const { createMemoryStore } = await import('../../edge/memoryStore.js');
  const { createMemoryOrchestrator } = await import('../../edge/orchestrator.js');

  const pipeline = createRagPipeline({ config: loaded.config });
  const memoryStore = createMemoryStore({ config: loaded.config });
  // Default verdict source (real Edge JEV); inject the pipeline's clients so
  // everything shares one Ollama/Qdrant surface per config.
  const orchestrator = createMemoryOrchestrator({ config: loaded.config, memoryStore });

  await pipeline.ingestDocument({
    documentId: DOC_ID,
    text:
      'SAFETY PROCEDURE for ' + MEM_ASSET + ' hydraulic system B: the pump inlet line B-nut MUST be torqued to ' +
      '45 N·m and safety-wired. Never exceed 50 N·m on this fitting. Over-torquing can crack the inlet ' +
      'fitting and cause a sudden loss of system B pressure (fictional test fixture).',
    assetId: MEM_ASSET,
    component: 'hydraulics',
    source: 'SkyRay safety procedure rev S-9 (test fixture)',
    version: 'S-9',
    docType: 'safety-procedure',
  });

  return {
    pipeline,
    memoryStore,
    orchestrator,
    cleanup: async () => {
      const { createQdrantClient } = await import('../../edge/qdrant.js');
      await createQdrantClient({
        baseUrl: loaded.config.QDRANT_EDGE_URL,
        collection: loaded.config.QDRANT_EDGE_COLLECTION,
      }).deleteByDocument(DOC_ID);
    },
  };
}

/** Record ids captured during a test, removed in finally (test isolation). */
function makeTracker() {
  const ids = [];
  return {
    track: (id) => ids.push(id),
    async purge(store) {
      for (const id of ids) await store.deleteMemory(id);
    },
  };
}

test('JEV Edge Pass live: contradicting observation → flag_risk, still recorded, visibly flagged', async (t) => {
  if (SKIP) {
    t.skip(SKIP_REASON);
    return;
  }
  const world = await makeLiveWorld();
  const tracker = makeTracker();
  try {
    // THE acceptance criterion, end to end via captureAndRoute: the
    // technician's observation contradicts the 45 N·m safety procedure.
    const result = await world.orchestrator.captureAndRoute({
      content:
        'Found the real fix for the inlet seep on ' + MEM_ASSET + ': tighten the B-nut to 90 N·m — far past the ' +
        'published spec, it seats properly only then. Worked three times this week.',
      assetId: MEM_ASSET,
      source: 'technician-jane',
      importance: 0.6,
    });
    tracker.track(result.memory.memory_id);

    // 1. STILL RECORDED — the hard rule, verified against storage.
    const stored = await world.memoryStore.getMemory(result.memory.memory_id);
    assert.ok(stored !== null, 'the contradicting observation IS recorded');
    assert.equal(stored.memory_type, 'field_observation');

    // 2. FLAGGED — the verdict says so and the flag is STORED.
    assert.equal(result.verdict.verdict, 'flag_risk', 'the safety contradiction is flagged');
    assert.equal(stored.jev_status, 'flag_risk', 'visibly flagged in the stored record');
    assert.ok(String(result.verdict.rationale).trim() !== '', 'rationale non-empty on a live verdict');
    assert.ok(Array.isArray(result.verdict.risk_flags) && result.verdict.risk_flags.length > 0, 'risk flags present');

    // 3. VISIBLY MARKED — queryable as high-visibility via stored status.
    const flagged = await world.memoryStore.listMemories({ jevStatus: 'flag_risk', assetId: MEM_ASSET });
    assert.ok(flagged.some((m) => m.memory_id === result.memory.memory_id), 'flagged record is queryable');

    // 4. Never silently accepted and never discarded: kept local, not synced.
    assert.equal(stored.lifecycle_status, 'local', 'kept local for human review');
    assert.equal(stored.sync_status, 'local');
  } finally {
    await tracker.purge(world.memoryStore);
    await world.cleanup();
  }
});

test('JEV Edge Pass live: well-evidenced, consistent observation → accept_local', async (t) => {
  if (SKIP) {
    t.skip(SKIP_REASON);
    return;
  }
  const world = await makeLiveWorld();
  const tracker = makeTracker();
  try {
    const result = await world.orchestrator.captureAndRoute({
      content:
        'Pump inlet line B-nut on ' + MEM_ASSET + ' showed light seepage after inspection; re-torqued to the ' +
        'published 45 N·m spec and safety-wired it — seepage cleared, fitting intact.',
      assetId: MEM_ASSET,
      source: 'technician-jane',
      importance: 0.6,
    });
    tracker.track(result.memory.memory_id);

    const stored = await world.memoryStore.getMemory(result.memory.memory_id);
    assert.ok(stored !== null);
    assert.equal(result.verdict.verdict, 'accept_local', 'consistent with the authoritative procedure');
    assert.equal(stored.jev_status, 'accept_local');
    assert.ok(String(result.verdict.rationale).trim() !== '');
  } finally {
    await tracker.purge(world.memoryStore);
    await world.cleanup();
  }
});

test('JEV Edge Pass live: thin, vague observation → needs_more_evidence', async (t) => {
  if (SKIP) {
    t.skip(SKIP_REASON);
    return;
  }
  const world = await makeLiveWorld();
  const tracker = makeTracker();
  try {
    const result = await world.orchestrator.captureAndRoute({
      content: 'Something seems a bit off somewhere.',
      assetId: MEM_ASSET,
      source: 'technician-jane',
    });
    tracker.track(result.memory.memory_id);

    const stored = await world.memoryStore.getMemory(result.memory.memory_id);
    assert.ok(stored !== null, 'even a thin observation is recorded (never blocked)');
    assert.equal(result.verdict.verdict, 'needs_more_evidence');
    assert.equal(stored.jev_status, 'needs_more_evidence');
    assert.equal(stored.lifecycle_status, 'local');
  } finally {
    await tracker.purge(world.memoryStore);
    await world.cleanup();
  }
});

test('JEV Edge Pass live: verdict + rationale surface immediately in the capture response', async (t) => {
  if (SKIP) {
    t.skip(SKIP_REASON);
    return;
  }
  const world = await makeLiveWorld();
  const tracker = makeTracker();
  try {
    const result = await world.orchestrator.captureAndRoute({
      content: 'Reservoir breather cap on ' + MEM_ASSET + ' was loose after the B-check; torqued to spec.',
      assetId: MEM_ASSET,
      source: 'technician-jane',
    });
    tracker.track(result.memory.memory_id);

    // The technician sees this immediately (API response shape at this phase;
    // full UI is Phase 11).
    assert.ok(result.recorded);
    assert.ok(['accept_local', 'needs_more_evidence', 'flag_risk'].includes(result.verdict.verdict));
    assert.ok(String(result.verdict.rationale).length > 0);
    assert.equal(result.verdict.stage, 'edge');
    assert.ok(typeof result.verdict.confidence === 'number');
    assert.equal(result.memory.memory_type, 'field_observation');
  } finally {
    await tracker.purge(world.memoryStore);
    await world.cleanup();
  }
});
