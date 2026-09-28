'use strict';

/**
 * Unit tests for shared/lifecycle.js: the explicit, closed transition table
 * that makes memory status STORED, not inferred.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LIFECYCLE_TRANSITIONS,
  JEV_TRANSITIONS,
  canTransition,
  canJevTransition,
  transitionLifecycle,
  transitionJev,
  initialStatusFor,
  LifecycleError,
} from '../../shared/lifecycle.js';

test('lifecycle: happy path new → local → used → sync_pending → synced', () => {
  assert.ok(canTransition('new', 'local'));
  assert.ok(canTransition('local', 'used'));
  assert.ok(canTransition('used', 'sync_pending'));
  assert.ok(canTransition('sync_pending', 'synced'));
});

test('lifecycle: expiry branches exist from new, local, used (and synced)', () => {
  assert.ok(canTransition('new', 'expired'));
  assert.ok(canTransition('local', 'expired'));
  assert.ok(canTransition('used', 'expired'));
  assert.ok(canTransition('synced', 'expired'));
});

test('lifecycle: JEV-aware branches exist now (conflict/resolved), populated by Phase 5', () => {
  assert.ok(canTransition('local', 'conflict'));
  assert.ok(canTransition('used', 'conflict'));
  assert.ok(canTransition('sync_pending', 'conflict'));
  assert.ok(canTransition('synced', 'conflict'));
  assert.ok(canTransition('conflict', 'resolved'));
  assert.ok(canTransition('conflict', 'expired'));
  // Resolved memories re-enter the live lifecycle.
  assert.ok(canTransition('resolved', 'local'));
  assert.ok(canTransition('resolved', 'used'));
  assert.ok(canTransition('resolved', 'sync_pending'));
  assert.ok(canTransition('resolved', 'expired'));
});

test('lifecycle: illegal jumps are rejected', () => {
  assert.equal(canTransition('new', 'synced'), false, 'cannot skip local/used');
  assert.equal(canTransition('new', 'used'), false);
  assert.equal(canTransition('new', 'conflict'), false, 'unused memory has nothing to conflict');
  assert.equal(canTransition('synced', 'local'), false, 'no un-syncing');
  assert.equal(canTransition('expired', 'local'), false, 'expired is terminal');
  assert.equal(canTransition('used', 'new'), false, 'no going backwards');
});

test('transitionLifecycle is pure and throws a named error for illegal jumps', () => {
  assert.equal(transitionLifecycle('local', 'used'), 'used');
  assert.throws(() => transitionLifecycle('new', 'synced'), (err) => {
    assert.ok(err instanceof LifecycleError);
    assert.equal(err.kind, 'lifecycle_status');
    assert.match(err.message, /Illegal lifecycle_status transition/);
    return true;
  });
});

test('jev: pending → accept_local exists; accept_local → validated (Cloud Pass) exists', () => {
  assert.ok(canJevTransition('pending', 'accept_local'));
  assert.ok(canJevTransition('accept_local', 'validated'));
  assert.ok(canJevTransition('flag_risk', 'needs_human_review'));
  assert.ok(canJevTransition('needs_human_review', 'validated'));
  // Terminals stay terminal.
  assert.equal(canJevTransition('validated', 'pending'), false);
  assert.equal(canJevTransition('rejected', 'accept_local'), false);
});

test('transitionJev is pure and throws for illegal jumps', () => {
  assert.equal(transitionJev('pending', 'accept_local'), 'accept_local');
  assert.throws(() => transitionJev('not_applicable', 'accept_local'), LifecycleError);
});

test('initialStatusFor: technician types start new/pending; manual starts local/not_applicable', () => {
  assert.deepEqual(initialStatusFor('field_observation'), { lifecycle: 'new', jev: 'pending' });
  assert.deepEqual(initialStatusFor('session_note'), { lifecycle: 'new', jev: 'pending' });
  assert.deepEqual(initialStatusFor('manual'), { lifecycle: 'local', jev: 'not_applicable' });
  assert.throws(() => initialStatusFor(/** @type {any} */ ('diary')), TypeError);
});

test('transition tables are frozen (no runtime mutation of the state machine)', () => {
  assert.ok(Object.isFrozen(LIFECYCLE_TRANSITIONS));
  assert.ok(Object.isFrozen(JEV_TRANSITIONS));
  assert.throws(() => {
    /** @type {any} */ (LIFECYCLE_TRANSITIONS).new = new Set(['synced']);
  });
});
