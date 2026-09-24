'use strict';

/**
 * Unit tests for shared/schemas.js: every contract accepts a valid sample,
 * and rejects samples with missing required fields or out-of-enum values.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateMemory,
  validateJEVVerdict,
  validateDocumentChunk,
  validateSyncEvent,
  validateConflict,
  MEMORY_TYPES,
  SYNC_STATUSES,
  LIFECYCLE_STATUSES,
  JEV_STATUSES,
  JEV_STAGES,
  JEV_VERDICTS,
  SYNC_OPERATIONS,
  CONFLICT_STATUSES,
} from '../../shared/schemas.js';
import {
  without,
  validMemory,
  validJEVVerdict,
  validDocumentChunk,
  validSyncEvent,
  validConflict,
} from '../helpers/fixtures.js';

test('enum constant arrays are frozen', () => {
  assert.ok(Object.isFrozen(MEMORY_TYPES));
  assert.ok(Object.isFrozen(SYNC_STATUSES));
  assert.ok(Object.isFrozen(LIFECYCLE_STATUSES));
  assert.ok(Object.isFrozen(JEV_STATUSES));
  assert.ok(Object.isFrozen(JEV_STAGES));
  assert.ok(Object.isFrozen(JEV_VERDICTS));
  assert.ok(Object.isFrozen(SYNC_OPERATIONS));
  assert.ok(Object.isFrozen(CONFLICT_STATUSES));
});

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

test('validateMemory accepts a valid Memory', () => {
  const result = validateMemory(validMemory());
  assert.deepEqual(result, { valid: true, errors: [] });
});

test('validateMemory rejects a missing required field', () => {
  const result = validateMemory(without(validMemory(), ['content']));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('"content"')));
});

test('validateMemory rejects an out-of-enum memory_type', () => {
  const result = validateMemory({ ...validMemory(), memory_type: 'wiki' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('"memory_type"')));
});

test('validateMemory rejects an out-of-enum lifecycle_status', () => {
  const result = validateMemory({
    ...validMemory(),
    lifecycle_status: 'archived',
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('"lifecycle_status"')));
});

test('validateMemory rejects unknown properties', () => {
  const result = validateMemory({ ...validMemory(), extra: 'nope' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('unknown property "extra"')));
});

test('validateMemory rejects empty strings, bad timestamps, and non-numeric numbers', () => {
  const bad = {
    ...validMemory(),
    content: '   ',
    created_at: 'not-a-date',
    importance: NaN,
    confidence: '0.5',
  };
  const result = validateMemory(bad);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('"content"')));
  assert.ok(result.errors.some((e) => e.includes('"created_at"')));
  assert.ok(result.errors.some((e) => e.includes('"importance"')));
  assert.ok(result.errors.some((e) => e.includes('"confidence"')));
});

test('validateMemory rejects null and non-objects', () => {
  for (const value of [null, undefined, 42, 'x', []]) {
    const result = validateMemory(value);
    assert.equal(result.valid, false, `should reject ${String(value)}`);
    assert.ok(result.errors.length > 0);
  }
});

// ---------------------------------------------------------------------------
// JEVVerdict
// ---------------------------------------------------------------------------

test('validateJEVVerdict accepts a valid JEVVerdict', () => {
  const result = validateJEVVerdict(validJEVVerdict());
  assert.deepEqual(result, { valid: true, errors: [] });
});

test('validateJEVVerdict rejects an empty rationale (required, never empty)', () => {
  const result = validateJEVVerdict({ ...validJEVVerdict(), rationale: '  ' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('"rationale"')));
});

test('validateJEVVerdict rejects an out-of-enum verdict and stage', () => {
  const badVerdict = validateJEVVerdict({ ...validJEVVerdict(), verdict: 'ok' });
  assert.equal(badVerdict.valid, false);
  assert.ok(badVerdict.errors.some((e) => e.includes('"verdict"')));

  const badStage = validateJEVVerdict({ ...validJEVVerdict(), stage: 'local' });
  assert.equal(badStage.valid, false);
  assert.ok(badStage.errors.some((e) => e.includes('"stage"')));
});

test('validateJEVVerdict rejects a missing field and non-array risk_flags', () => {
  const missing = validateJEVVerdict(without(validJEVVerdict(), ['model_used']));
  assert.equal(missing.valid, false);
  assert.ok(missing.errors.some((e) => e.includes('"model_used"')));

  const badFlags = validateJEVVerdict({
    ...validJEVVerdict(),
    risk_flags: 'none',
  });
  assert.equal(badFlags.valid, false);
  assert.ok(badFlags.errors.some((e) => e.includes('"risk_flags"')));
});

// ---------------------------------------------------------------------------
// DocumentChunk
// ---------------------------------------------------------------------------

test('validateDocumentChunk accepts a valid DocumentChunk', () => {
  const result = validateDocumentChunk(validDocumentChunk());
  assert.deepEqual(result, { valid: true, errors: [] });
});

test('validateDocumentChunk rejects a missing required field', () => {
  const result = validateDocumentChunk(without(validDocumentChunk(), ['component']));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('"component"')));
});

test('validateDocumentChunk rejects a bad embedding', () => {
  for (const embedding of ['vector', [1, 'x', 3], [1, NaN, 3], 42]) {
    const result = validateDocumentChunk({ ...validDocumentChunk(), embedding });
    assert.equal(result.valid, false, `should reject ${JSON.stringify(embedding)}`);
    assert.ok(result.errors.some((e) => e.includes('"embedding"')));
  }
});

// ---------------------------------------------------------------------------
// SyncEvent
// ---------------------------------------------------------------------------

test('validateSyncEvent accepts a valid SyncEvent', () => {
  const result = validateSyncEvent(validSyncEvent());
  assert.deepEqual(result, { valid: true, errors: [] });
});

test('validateSyncEvent rejects an out-of-enum operation', () => {
  const result = validateSyncEvent({ ...validSyncEvent(), operation: 'delete' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('"operation"')));
});

test('validateSyncEvent rejects a missing field and empty status', () => {
  const missing = validateSyncEvent(without(validSyncEvent(), ['source_device']));
  assert.equal(missing.valid, false);
  assert.ok(missing.errors.some((e) => e.includes('"source_device"')));

  const empty = validateSyncEvent({ ...validSyncEvent(), status: '' });
  assert.equal(empty.valid, false);
  assert.ok(empty.errors.some((e) => e.includes('"status"')));
});

// ---------------------------------------------------------------------------
// Conflict
// ---------------------------------------------------------------------------

test('validateConflict accepts a valid Conflict', () => {
  const result = validateConflict(validConflict());
  assert.deepEqual(result, { valid: true, errors: [] });
});

test('validateConflict rejects a missing field', () => {
  const result = validateConflict(without(validConflict(), ['cloud_version']));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('"cloud_version"')));
});

test('validateConflict rejects an out-of-enum status', () => {
  const result = validateConflict({ ...validConflict(), status: 'closed' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('"status"')));
});

test('validateConflict requires resolution and resolved_by once resolved', () => {
  const resolvedEmpty = {
    ...validConflict(),
    status: 'resolved',
    resolution: '',
    resolved_by: '',
  };
  const result = validateConflict(resolvedEmpty);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('"resolution"')));
  assert.ok(result.errors.some((e) => e.includes('"resolved_by"')));

  const resolved = {
    ...validConflict(),
    status: 'resolved',
    resolution: 'Cloud revision kept; edge observation merged as needs_more_evidence.',
    resolved_by: 'jev-cloud-pass',
  };
  assert.deepEqual(validateConflict(resolved), { valid: true, errors: [] });
});

test('validateConflict rejects a malformed jev_recommendation', () => {
  for (const jev_recommendation of [null, 'nope', {}, { verdict: 'x' }, { verdict: 'x', rationale: ' ' }]) {
    const result = validateConflict({ ...validConflict(), jev_recommendation });
    assert.equal(result.valid, false, `should reject ${JSON.stringify(jev_recommendation)}`);
    assert.ok(result.errors.some((e) => e.includes('"jev_recommendation"')));
  }
});
