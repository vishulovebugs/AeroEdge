'use strict';

/**
 * Shared fixtures for schema tests. Valid samples live here so suites and
 * later phases construct contract-shaped objects consistently.
 */

import {
  MEMORY_TYPES,
  SYNC_STATUSES,
  LIFECYCLE_STATUSES,
  JEV_STATUSES,
  JEV_STAGES,
  JEV_VERDICTS,
  SYNC_OPERATIONS,
} from '../../shared/schemas.js';

/**
 * Strip the given properties from a shallow copy of `obj`.
 * @param {Record<string, unknown>} obj
 * @param {string[]} keys
 * @returns {Record<string, unknown>}
 */
export function without(obj, keys) {
  const copy = { ...obj };
  for (const key of keys) delete copy[key];
  return copy;
}

/** @returns {Record<string, unknown>} A valid Memory record. */
export function validMemory() {
  return {
    memory_id: 'mem-001',
    memory_type: /** @type {'field_observation'} */ (MEMORY_TYPES[1]),
    content: 'Hydraulic pump 2B whines above 3000 PSI; likely cavitation.',
    asset_id: 'aircraft-737-MSN4453',
    source: 'technician-jane-doe',
    version: '1',
    importance: 0.8,
    confidence: 0.55,
    created_at: '2026-09-24T08:15:00.000Z',
    updated_at: '2026-09-24T08:15:00.000Z',
    sync_status: /** @type {'local'} */ (SYNC_STATUSES[0]),
    lifecycle_status: /** @type {'new'} */ (LIFECYCLE_STATUSES[0]),
    jev_status: /** @type {'pending'} */ (JEV_STATUSES[1]),
  };
}

/** @returns {Record<string, unknown>} A valid JEVVerdict record. */
export function validJEVVerdict() {
  return {
    verdict_id: 'jev-001',
    memory_id: 'mem-001',
    stage: /** @type {'edge'} */ (JEV_STAGES[0]),
    verdict: /** @type {'accept_local'} */ (JEV_VERDICTS[0]),
    rationale:
      'Consistent with observed pump behavior; supported by manual section 29-11-00.',
    confidence: 0.72,
    risk_flags: [],
    evidence_used: ['chunk-manual-29-11-00-p4'],
    model_used: 'llama3.1:8b',
    evaluated_at: '2026-09-24T08:16:00.000Z',
  };
}

/** @returns {Record<string, unknown>} A valid DocumentChunk record. */
export function validDocumentChunk() {
  return {
    id: 'chunk-001',
    document_id: 'doc-amm-737-29',
    version: '1',
    content: 'Hydraulic system B: normal operating pressure range 2800-3200 PSI.',
    embedding: [0.1, -0.2, 0.3],
    asset_id: 'aircraft-737-MSN4453',
    component: 'hydraulics',
    source: 'AMM rev 42',
    created_at: '2026-09-24T07:00:00.000Z',
    updated_at: '2026-09-24T07:00:00.000Z',
  };
}

/** @returns {Record<string, unknown>} A valid SyncEvent record. */
export function validSyncEvent() {
  return {
    event_id: 'evt-001',
    memory_id: 'mem-001',
    operation: /** @type {'create'} */ (SYNC_OPERATIONS[0]),
    source_device: 'tablet-apron-04',
    source_version: '1',
    target_version: '1',
    timestamp: '2026-09-24T09:00:00.000Z',
    status: 'queued',
  };
}

/** @returns {Record<string, unknown>} A valid Conflict record. */
export function validConflict() {
  return {
    conflict_id: 'con-001',
    memory_id: 'mem-001',
    edge_version: '2',
    cloud_version: '3',
    conflict_type: 'concurrent_update',
    jev_recommendation: {
      verdict: 'needs_human_review',
      rationale: 'Edge edit and fleet manual revision disagree on pressure range.',
    },
    status: /** @type {'open'} */ ('open'),
    resolution: '',
    resolved_by: '',
  };
}
