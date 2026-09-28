'use strict';

/**
 * Phase 3 unit tests for edge/session.js: session state updates across a
 * sequence of calls, context-dependence detection, query expansion, the
 * compact (never raw-log) summary, and session filter suggestions.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSession,
  updateSessionFromQuery,
  updateSessionFromEvidence,
  recordActionsTaken,
  isContextDependent,
  expandQuery,
  buildSessionSummary,
  suggestSessionFilters,
  MAX_RECENT_QUERIES,
  MAX_RECENT_EVIDENCE,
  SUMMARY_MAX_CHARS,
  HISTORY_THRESHOLD_CHARS,
} from '../../edge/session.js';

test('createSession: empty session with explicit nulls, seeded values accepted, bad seeds rejected', () => {
  const empty = createSession();
  for (const key of ['assetId', 'equipmentModel', 'component', 'issue']) {
    assert.equal(empty[key], null, `${key} starts unset (null)`);
  }
  assert.match(empty.sessionId, /^ses-/);
  assert.deepEqual(empty.recentQueries, []);
  assert.deepEqual(empty.recentEvidence, []);
  assert.deepEqual(empty.actionsTaken, []);

  const seeded = createSession({ assetId: 'MSN4453', component: 'hydraulics' });
  assert.equal(seeded.assetId, 'MSN4453');
  assert.equal(seeded.component, 'hydraulic', 'seed subsystem is canonicalized (singular key)');

  assert.throws(() => createSession({ assetId: '   ' }), /"assetId"/);
  assert.throws(() => createSession(/** @type {any} */ ({ assetId: 42 })), /"assetId"/);
});

test('session state updates correctly across a sequence of calls', () => {
  const state = createSession();

  // Turn 1: establishes asset and subsystem.
  updateSessionFromQuery(state, 'Running diagnostics on aircraft MSN4453, hydraulic system B is over-pressurizing');
  assert.equal(state.assetId, 'MSN4453');
  assert.equal(state.component, 'hydraulic');
  assert.equal(state.recentQueries.length, 1);

  // Turn 2: same context, new question — nothing changes, history grows.
  const changed = updateSessionFromQuery(state, 'What is the normal pressure range?');
  assert.equal(changed, false);
  assert.equal(state.assetId, 'MSN4453');
  assert.equal(state.component, 'hydraulic');
  assert.equal(state.recentQueries.length, 2);

  // Turn 3: the technician moves to a different subsystem — current one changes.
  updateSessionFromQuery(state, 'Now check the oxygen system on the same aircraft');
  assert.equal(state.component, 'oxygen', 'new subsystem replaces the old one');
  assert.equal(state.assetId, 'MSN4453', 'asset persists across turns');
});

test('recentQueries is bounded and keeps the newest turns', () => {
  const state = createSession();
  for (let i = 1; i <= MAX_RECENT_QUERIES + 3; i++) {
    updateSessionFromQuery(state, `diagnostics question number ${i}`);
  }
  assert.equal(state.recentQueries.length, MAX_RECENT_QUERIES);
  const queries = state.recentQueries.map((t) => t.query);
  assert.ok(queries.includes(`diagnostics question number ${MAX_RECENT_QUERIES + 3}`), 'newest kept');
  assert.ok(!queries.includes('diagnostics question number 1'), 'oldest dropped');
  for (let i = 0; i < state.recentQueries.length - 1; i++) {
    assert.ok(state.recentQueries[i].askedAt <= state.recentQueries[i + 1].askedAt, 'chronological order');
  }
});

test('updateSessionFromEvidence stores bounded evidence and borrows component from top hit', () => {
  const state = createSession();
  updateSessionFromEvidence(state, {
    chunks: [
      { chunkId: 'c1', documentId: 'd1', source: 's1', content: 'x'.repeat(500), component: 'electrical' },
      { chunkId: 'c2', documentId: 'd2', source: 's2', content: 'y'.repeat(500), component: 'fuel system' },
      { chunkId: 'c3', documentId: 'd3', source: 's3', content: 'z'.repeat(500), component: 'cooling' },
      { chunkId: 'c4', documentId: 'd4', source: 's4', content: 'w'.repeat(500), component: 'landing gear' },
    ],
  });
  assert.equal(state.recentEvidence.length, MAX_RECENT_EVIDENCE, 'bounded to MAX_RECENT_EVIDENCE');
  assert.equal(state.component, 'electrical', 'subsystem borrowed from the best hit when unset');
  assert.ok(state.recentEvidence.every((e) => e.content.length <= 200), 'stored content copies are truncated');
});

test('recordActionsTaken extracts, dedupes, and bounds actions', () => {
  const state = createSession();
  const added = recordActionsTaken(state, 'We already replaced the filter and reset the breaker');
  assert.deepEqual(added, ['replaced the filter', 'reset the breaker']);
  assert.deepEqual(state.actionsTaken, ['replaced the filter', 'reset the breaker']);

  const again = recordActionsTaken(state, 'we already replaced the filter yesterday');
  assert.deepEqual(again, [], 'duplicate actions are not re-added');

  for (let i = 0; i < 15; i++) recordActionsTaken(state, `inspected module ${i}`);
  assert.ok(state.actionsTaken.length <= 10, 'actions bounded');
});

test('isContextDependent: elliptical follow-ups yes, self-contained queries no', () => {
  const state = createSession({ assetId: 'MSN4453', component: 'hydraulics' });
  assert.equal(isContextDependent('what about the sensor?', state), true);
  assert.equal(isContextDependent('it still leaks', state), true);
  assert.equal(isContextDependent('and the valve?', state), true);
  assert.equal(isContextDependent('what torque applies to the B-nut on aircraft MSN4453 hydraulic pump?', state), false);
  assert.equal(isContextDependent('what does error code ERR-4212 mean for the quench valve?', state), false);
});

test('expandQuery: bare follow-up resolves with session asset/subsystem', () => {
  const state = createSession({ assetId: 'MSN4453', component: 'sensor' });
  const { query, usedSession } = expandQuery('what about the pressure sensor?', state);
  assert.equal(usedSession, true);
  assert.ok(query.includes('sensor'), 'original wording preserved');
  assert.ok(query.includes('MSN4453'), 'session asset appended');
});

test('expandQuery: self-contained queries pass through untouched', () => {
  const state = createSession({ assetId: 'MSN4453', component: 'hydraulics' });
  const q = 'what torque applies to the B-nut on aircraft MSN4453?';
  const { query, usedSession } = expandQuery(q, state);
  assert.equal(usedSession, false);
  assert.equal(query, q.trim());
});

test('expandQuery: empty session means nothing to add', () => {
  const state = createSession();
  const { query, usedSession } = expandQuery('what about the sensor?', state);
  assert.equal(usedSession, false);
  assert.equal(query, 'what about the sensor?');
});

test('expandQuery rejects empty input', () => {
  assert.throws(() => expandQuery('   ', createSession()), /non-empty/);
});

test('buildSessionSummary: compact summary, not the raw log', () => {
  const state = createSession({ assetId: 'MSN4453', component: 'hydraulics', issue: 'intermittent pressure spikes' });
  recordActionsTaken(state, 'already replaced the filter');
  for (let i = 1; i <= 4; i++) updateSessionFromQuery(state, `question ${i} about hydraulic pressure behaviour on this aircraft`);
  updateSessionFromEvidence(state, {
    chunks: [{ chunkId: 'c1', documentId: 'doc-1', source: 'AMM rev 42', content: 'Normal range 2800-3200 PSI.', component: 'hydraulics' }],
  });

  const summary = buildSessionSummary(state);
  assert.ok(summary.includes('MSN4453'));
  assert.ok(summary.includes('hydraulic'), 'canonical subsystem key appears in the summary');
  assert.ok(summary.includes('intermittent pressure spikes'));
  assert.ok(summary.includes('replaced the filter'));
  assert.ok(summary.includes('Recent queries:'));
  assert.ok(summary.includes('AMM rev 42'));
  // Bounded: a summary, not a transcript.
  assert.ok(summary.length <= SUMMARY_MAX_CHARS, `summary ${summary.length} chars within budget`);
});

test('buildSessionSummary: history beyond the threshold collapses, summary stays bounded', () => {
  const state = createSession({ assetId: 'MSN4453' });
  // Long queries: total raw history far exceeds the threshold and any budget.
  for (let i = 1; i <= 20; i++) {
    updateSessionFromQuery(state, `long diagnostic question number ${i} with plenty of verbose phrasing about pressure behaviour`);
  }
  const rawLength = state.recentQueries.reduce((s, t) => s + t.query.length, 0);
  assert.ok(rawLength > HISTORY_THRESHOLD_CHARS, 'test setup: history exceeds threshold');

  const summary = buildSessionSummary(state);
  assert.ok(summary.length <= SUMMARY_MAX_CHARS, `summary ${summary.length} chars within budget despite raw ${rawLength}`);
  assert.ok(/\+\d+ earlier quer(y|ies) omitted\)/.test(summary), 'older turns collapse into an explicit marker');
  assert.ok(summary.includes('long diagnostic question number 20'), 'most recent turns are retained');
  assert.ok(!summary.includes('question number 1 with'), 'ancient turns are not listed');
});

test('buildSessionSummary: hard cap holds even with pathological inputs', () => {
  const state = createSession();
  updateSessionFromQuery(state, 'x'.repeat(2000));
  const summary = buildSessionSummary(state);
  assert.ok(summary.length <= Math.max(200, SUMMARY_MAX_CHARS));
  assert.ok(summary.endsWith('…'), 'truncation is explicit');
});

test('buildSessionSummary: empty session yields empty summary (no context to inject)', () => {
  assert.equal(buildSessionSummary(createSession()), '');
});

test('buildSessionSummary rejects garbage input', () => {
  assert.throws(() => buildSessionSummary(null), TypeError);
  assert.throws(() => buildSessionSummary('nope'), TypeError);
});

test('suggestSessionFilters: hard identifiers only, subsystem never suggested', () => {
  const state = createSession({ assetId: 'MSN4453', equipmentModel: 'SkyRay MK-IV', component: 'hydraulics' });
  assert.deepEqual(suggestSessionFilters(state), {
    filters: { assetId: 'MSN4453', equipmentModel: 'SkyRay MK-IV' },
  });
  assert.deepEqual(suggestSessionFilters(createSession({ component: 'hydraulics' })), {});
  assert.throws(() => suggestSessionFilters(null), TypeError);
});
