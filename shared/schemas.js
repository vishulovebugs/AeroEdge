'use strict';

/**
 * AeroEdge shared data contracts.
 *
 * Single source of truth for every record shape that crosses a module or a
 * sync boundary. Each type has a JSDoc `@typedef` plus a `validateX()`
 * helper; every writer MUST pass objects through the validator before
 * persisting to Qdrant. No module invents its own shape.
 *
 * Validators are closed-world: unknown properties are rejected, required
 * string IDs/content must be non-empty, timestamp fields must parse as
 * dates. Each validator returns { valid, errors } — all problems at once,
 * not just the first.
 *
 * Range policy note: confidence/importance are checked to be finite numbers.
 * The exact numeric policy (who clamps to what) belongs to the phases that
 * produce those values, not to the contract.
 */

/** @typedef {'manual'|'field_observation'|'session_note'} MemoryType */
/** @typedef {'local'|'sync_pending'|'synced'} SyncStatus */
/**
 * Knowledge lifecycle state machine. Order:
 * new → local → used → sync_pending → synced → (expired | conflict → resolved).
 * @typedef {'new'|'local'|'used'|'sync_pending'|'synced'|'expired'|'conflict'|'resolved'} LifecycleStatus
 */
/**
 * JEV evaluation state. `accept_local` means usable locally only; only
 * `validated` records are fleet-wide truth.
 * @typedef {'not_applicable'|'pending'|'accept_local'|'needs_more_evidence'|'flag_risk'|'validated'|'needs_human_review'|'rejected'} JEVStatus
 */

/** @typedef {'edge'|'cloud'} JEVStage */
/**
 * Edge Pass uses the first three; Cloud Pass the full set.
 * @typedef {'accept_local'|'needs_more_evidence'|'flag_risk'|'validated'|'needs_human_review'|'rejected'} JEVVerdictValue
 */

/** @typedef {'create'|'update'|'expire'} SyncOperation */

/**
 * @typedef {Object} Memory
 * @property {string} memory_id
 * @property {MemoryType} memory_type
 * @property {string} content
 * @property {string} asset_id
 * @property {string} source
 * @property {string} version
 * @property {number} importance
 * @property {number} confidence
 * @property {string} created_at
 * @property {string} updated_at
 * @property {SyncStatus} sync_status
 * @property {LifecycleStatus} lifecycle_status
 * @property {JEVStatus} jev_status
 */

/**
 * A JEV verdict. `rationale` is REQUIRED and never empty: an evaluation
 * without a stated reason is not an evaluation.
 * @typedef {Object} JEVVerdict
 * @property {string} verdict_id
 * @property {string} memory_id
 * @property {JEVStage} stage
 * @property {JEVVerdictValue} verdict
 * @property {string} rationale
 * @property {number} confidence
 * @property {string[]} risk_flags
 * @property {string[]} evidence_used
 * @property {string} model_used
 * @property {string} evaluated_at
 */

/**
 * A stored document chunk. The Phase 2 fields are optional retrieval
 * metadata used by hybrid search; legacy Phase 1 chunks without them
 * remain valid (absent = no metadata filtering / no keyword index boost).
 * @typedef {Object} DocumentChunk
 * @property {string} id
 * @property {string} document_id
 * @property {string} version
 * @property {string} content
 * @property {number[]} embedding
 * @property {string} asset_id
 * @property {string} component
 * @property {string} source
 * @property {string} [equipment_model] Equipment model the doc applies to (e.g. "SkyRay MK-IV").
 * @property {string} [doc_type] Document type (e.g. "amm", "bulletin", "procedure").
 * @property {string[]} [applicability] Asset/config applicability list (empty = unrestricted).
 * @property {string[]} [keywords] Curated exact-match tokens (part numbers, error codes, IDs).
 * @property {string} created_at
 * @property {string} updated_at
 */

/**
 * @typedef {Object} SyncEvent
 * @property {string} event_id
 * @property {string} memory_id
 * @property {SyncOperation} operation
 * @property {string} source_device
 * @property {string} source_version
 * @property {string} target_version
 * @property {string} timestamp
 * @property {string} status
 */

/**
 * @typedef {Object} Conflict
 * @property {string} conflict_id
 * @property {string} memory_id
 * @property {string} edge_version
 * @property {string} cloud_version
 * @property {string} conflict_type
 * @property {{verdict: string, rationale: string}} jev_recommendation
 * @property {'open'|'resolved'} status
 * @property {string} resolution
 * @property {string} resolved_by
 */

/** @type {readonly string[]} */
export const MEMORY_TYPES = Object.freeze([
  'manual',
  'field_observation',
  'session_note',
]);

/** @type {readonly string[]} */
export const SYNC_STATUSES = Object.freeze(['local', 'sync_pending', 'synced']);

/** @type {readonly string[]} */
export const LIFECYCLE_STATUSES = Object.freeze([
  'new',
  'local',
  'used',
  'sync_pending',
  'synced',
  'expired',
  'conflict',
  'resolved',
]);

/** @type {readonly string[]} */
export const JEV_STATUSES = Object.freeze([
  'not_applicable',
  'pending',
  'accept_local',
  'needs_more_evidence',
  'flag_risk',
  'validated',
  'needs_human_review',
  'rejected',
]);

/** @type {readonly string[]} */
export const JEV_STAGES = Object.freeze(['edge', 'cloud']);

/** @type {readonly string[]} */
export const JEV_VERDICTS = Object.freeze([
  'accept_local',
  'needs_more_evidence',
  'flag_risk',
  'validated',
  'needs_human_review',
  'rejected',
]);

/** @type {readonly string[]} */
export const SYNC_OPERATIONS = Object.freeze(['create', 'update', 'expire']);

/** @type {readonly string[]} */
export const CONFLICT_STATUSES = Object.freeze(['open', 'resolved']);

/** Frozen set of all contract properties, used to reject unknown fields. */
const MEMORY_FIELDS = new Set([
  'memory_id',
  'memory_type',
  'content',
  'asset_id',
  'source',
  'version',
  'importance',
  'confidence',
  'created_at',
  'updated_at',
  'sync_status',
  'lifecycle_status',
  'jev_status',
]);

const JEV_VERDICT_FIELDS = new Set([
  'verdict_id',
  'memory_id',
  'stage',
  'verdict',
  'rationale',
  'confidence',
  'risk_flags',
  'evidence_used',
  'model_used',
  'evaluated_at',
]);

const DOCUMENT_CHUNK_FIELDS = new Set([
  'id',
  'document_id',
  'version',
  'content',
  'embedding',
  'asset_id',
  'component',
  'source',
  // Phase 2: optional retrieval metadata (hybrid search). Absent = fine;
  // present = must be well-formed (see validateDocumentChunk).
  'equipment_model',
  'doc_type',
  'applicability',
  'keywords',
  'created_at',
  'updated_at',
]);

const SYNC_EVENT_FIELDS = new Set([
  'event_id',
  'memory_id',
  'operation',
  'source_device',
  'source_version',
  'target_version',
  'timestamp',
  'status',
]);

const CONFLICT_FIELDS = new Set([
  'conflict_id',
  'memory_id',
  'edge_version',
  'cloud_version',
  'conflict_type',
  'jev_recommendation',
  'status',
  'resolution',
  'resolved_by',
]);

/**
 * Format a validation problem for humans.
 * @param {string} type
 * @param {string} message
 * @returns {string}
 */
const errorFor = (type, message) => `${type}: ${message}`;

/**
 * Check that a required string property is present and non-blank.
 * @param {Record<string, unknown>} obj
 * @param {string} field
 * @param {string} type
 * @param {string[]} errors
 */
function requireNonEmptyString(obj, field, type, errors) {
  const value = obj[field];
  if (typeof value !== 'string') {
    errors.push(errorFor(type, `"${field}" is required and must be a string`));
  } else if (value.trim() === '') {
    errors.push(errorFor(type, `"${field}" must not be empty or whitespace-only`));
  }
}

/**
 * Check that a required enum property is one of the allowed values.
 * @param {Record<string, unknown>} obj
 * @param {string} field
 * @param {readonly string[]} allowed
 * @param {string} type
 * @param {string[]} errors
 */
function requireEnum(obj, field, allowed, type, errors) {
  const value = obj[field];
  if (typeof value !== 'string' || !allowed.includes(value)) {
    errors.push(
      errorFor(
        type,
        `"${field}" must be one of [${allowed.join(', ')}]` +
          (value === undefined ? ' (missing)' : `; got ${JSON.stringify(value)}`)
      )
    );
  }
}

/**
 * Check that a required numeric property is a finite number.
 * @param {Record<string, unknown>} obj
 * @param {string} field
 * @param {string} type
 * @param {string[]} errors
 */
function requireFiniteNumber(obj, field, type, errors) {
  const value = obj[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(
      errorFor(type, `"${field}" is required and must be a finite number`)
    );
  }
}

/**
 * Check that a required timestamp property parses as a date.
 * @param {Record<string, unknown>} obj
 * @param {string} field
 * @param {string} type
 * @param {string[]} errors
 */
function requireTimestamp(obj, field, type, errors) {
  const value = obj[field];
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    errors.push(
      errorFor(
        type,
        `"${field}" is required and must be a parseable timestamp string (ISO 8601 recommended)`
      )
    );
  }
}

/**
 * Check that a required property is an array of strings.
 * @param {Record<string, unknown>} obj
 * @param {string} field
 * @param {string} type
 * @param {string[]} errors
 */
function requireStringArray(obj, field, type, errors) {
  const value = obj[field];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    errors.push(
      errorFor(type, `"${field}" is required and must be an array of strings`)
    );
  }
}

/**
 * Optional string: absent is fine, but present must be a non-blank string.
 * @param {Record<string, unknown>} obj
 * @param {string} field
 * @param {string} type
 * @param {string[]} errors
 */
function requireNonEmptyStringIfPresent(obj, field, type, errors) {
  if (obj[field] === undefined) return;
  requireNonEmptyString(obj, field, type, errors);
}

/**
 * Optional string array: absent or empty is fine, but present elements must
 * be non-empty strings (an empty array means "no restriction").
 * @param {Record<string, unknown>} obj
 * @param {string} field
 * @param {string} type
 * @param {string[]} errors
 */
function requireStringArrayIfPresent(obj, field, type, errors) {
  const value = obj[field];
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    errors.push(errorFor(type, `"${field}" must be an array of strings when present`));
    return;
  }
  if (!value.every((item) => typeof item === 'string' && item.trim() !== '')) {
    errors.push(
      errorFor(type, `"${field}" must contain only non-empty strings when present`)
    );
  }
}

/**
 * Reject unknown properties so no module can smuggle in its own shape.
 * @param {unknown} obj
 * @param {ReadonlySet<string>} fields
 * @param {string} type
 * @param {string[]} errors
 */
function rejectUnknownFields(obj, fields, type, errors) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return;
  for (const key of Object.keys(obj)) {
    if (!fields.has(key)) {
      errors.push(errorFor(type, `unknown property "${key}"`));
    }
  }
}

/**
 * Validate a Memory record.
 * @param {unknown} obj
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateMemory(obj) {
  /** @type {string[]} */
  const errors = [];
  rejectUnknownFields(obj, MEMORY_FIELDS, 'Memory', errors);
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    errors.push(errorFor('Memory', 'expected an object'));
    return { valid: false, errors };
  }
  const record = /** @type {Record<string, unknown>} */ (obj);
  requireNonEmptyString(record, 'memory_id', 'Memory', errors);
  requireEnum(record, 'memory_type', MEMORY_TYPES, 'Memory', errors);
  requireNonEmptyString(record, 'content', 'Memory', errors);
  requireNonEmptyString(record, 'asset_id', 'Memory', errors);
  requireNonEmptyString(record, 'source', 'Memory', errors);
  requireNonEmptyString(record, 'version', 'Memory', errors);
  requireFiniteNumber(record, 'importance', 'Memory', errors);
  requireFiniteNumber(record, 'confidence', 'Memory', errors);
  requireTimestamp(record, 'created_at', 'Memory', errors);
  requireTimestamp(record, 'updated_at', 'Memory', errors);
  requireEnum(record, 'sync_status', SYNC_STATUSES, 'Memory', errors);
  requireEnum(record, 'lifecycle_status', LIFECYCLE_STATUSES, 'Memory', errors);
  requireEnum(record, 'jev_status', JEV_STATUSES, 'Memory', errors);
  return { valid: errors.length === 0, errors };
}

/**
 * Validate a JEVVerdict record.
 * @param {unknown} obj
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateJEVVerdict(obj) {
  /** @type {string[]} */
  const errors = [];
  rejectUnknownFields(obj, JEV_VERDICT_FIELDS, 'JEVVerdict', errors);
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    errors.push(errorFor('JEVVerdict', 'expected an object'));
    return { valid: false, errors };
  }
  const record = /** @type {Record<string, unknown>} */ (obj);
  requireNonEmptyString(record, 'verdict_id', 'JEVVerdict', errors);
  requireNonEmptyString(record, 'memory_id', 'JEVVerdict', errors);
  requireEnum(record, 'stage', JEV_STAGES, 'JEVVerdict', errors);
  requireEnum(record, 'verdict', JEV_VERDICTS, 'JEVVerdict', errors);
  requireNonEmptyString(record, 'rationale', 'JEVVerdict', errors);
  requireFiniteNumber(record, 'confidence', 'JEVVerdict', errors);
  requireStringArray(record, 'risk_flags', 'JEVVerdict', errors);
  requireStringArray(record, 'evidence_used', 'JEVVerdict', errors);
  requireNonEmptyString(record, 'model_used', 'JEVVerdict', errors);
  requireTimestamp(record, 'evaluated_at', 'JEVVerdict', errors);
  return { valid: errors.length === 0, errors };
}

/**
 * Validate a DocumentChunk record.
 * @param {unknown} obj
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateDocumentChunk(obj) {
  /** @type {string[]} */
  const errors = [];
  rejectUnknownFields(obj, DOCUMENT_CHUNK_FIELDS, 'DocumentChunk', errors);
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    errors.push(errorFor('DocumentChunk', 'expected an object'));
    return { valid: false, errors };
  }
  const record = /** @type {Record<string, unknown>} */ (obj);
  requireNonEmptyString(record, 'id', 'DocumentChunk', errors);
  requireNonEmptyString(record, 'document_id', 'DocumentChunk', errors);
  requireNonEmptyString(record, 'version', 'DocumentChunk', errors);
  requireNonEmptyString(record, 'content', 'DocumentChunk', errors);
  const embedding = record['embedding'];
  if (!Array.isArray(embedding) || !embedding.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    errors.push(
      errorFor('DocumentChunk', '"embedding" is required and must be an array of finite numbers')
    );
  }
  requireNonEmptyString(record, 'asset_id', 'DocumentChunk', errors);
  requireNonEmptyString(record, 'component', 'DocumentChunk', errors);
  requireNonEmptyString(record, 'source', 'DocumentChunk', errors);
  // Phase 2 optional retrieval metadata — validated only when present.
  requireNonEmptyStringIfPresent(record, 'equipment_model', 'DocumentChunk', errors);
  requireNonEmptyStringIfPresent(record, 'doc_type', 'DocumentChunk', errors);
  requireStringArrayIfPresent(record, 'applicability', 'DocumentChunk', errors);
  requireStringArrayIfPresent(record, 'keywords', 'DocumentChunk', errors);
  requireTimestamp(record, 'created_at', 'DocumentChunk', errors);
  requireTimestamp(record, 'updated_at', 'DocumentChunk', errors);
  return { valid: errors.length === 0, errors };
}

/**
 * Validate a SyncEvent record.
 * @param {unknown} obj
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateSyncEvent(obj) {
  /** @type {string[]} */
  const errors = [];
  rejectUnknownFields(obj, SYNC_EVENT_FIELDS, 'SyncEvent', errors);
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    errors.push(errorFor('SyncEvent', 'expected an object'));
    return { valid: false, errors };
  }
  const record = /** @type {Record<string, unknown>} */ (obj);
  requireNonEmptyString(record, 'event_id', 'SyncEvent', errors);
  requireNonEmptyString(record, 'memory_id', 'SyncEvent', errors);
  requireEnum(record, 'operation', SYNC_OPERATIONS, 'SyncEvent', errors);
  requireNonEmptyString(record, 'source_device', 'SyncEvent', errors);
  requireNonEmptyString(record, 'source_version', 'SyncEvent', errors);
  requireNonEmptyString(record, 'target_version', 'SyncEvent', errors);
  requireTimestamp(record, 'timestamp', 'SyncEvent', errors);
  requireNonEmptyString(record, 'status', 'SyncEvent', errors);
  return { valid: errors.length === 0, errors };
}

/**
 * Validate a Conflict record.
 * @param {unknown} obj
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateConflict(obj) {
  /** @type {string[]} */
  const errors = [];
  rejectUnknownFields(obj, CONFLICT_FIELDS, 'Conflict', errors);
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    errors.push(errorFor('Conflict', 'expected an object'));
    return { valid: false, errors };
  }
  const record = /** @type {Record<string, unknown>} */ (obj);
  requireNonEmptyString(record, 'conflict_id', 'Conflict', errors);
  requireNonEmptyString(record, 'memory_id', 'Conflict', errors);
  requireNonEmptyString(record, 'edge_version', 'Conflict', errors);
  requireNonEmptyString(record, 'cloud_version', 'Conflict', errors);
  requireNonEmptyString(record, 'conflict_type', 'Conflict', errors);
  const rec = record['jev_recommendation'];
  const recObj =
    rec !== null && typeof rec === 'object' && !Array.isArray(rec)
      ? /** @type {Record<string, unknown>} */ (rec)
      : undefined;
  const recVerdict = recObj ? recObj.verdict : undefined;
  const recRationale = recObj ? recObj.rationale : undefined;
  if (
    !recObj ||
    typeof recVerdict !== 'string' ||
    recVerdict.trim() === '' ||
    typeof recRationale !== 'string' ||
    recRationale.trim() === ''
  ) {
    errors.push(
      errorFor(
        'Conflict',
        '"jev_recommendation" is required and must be an object with non-empty string "verdict" and "rationale"'
      )
    );
  }
  requireEnum(record, 'status', CONFLICT_STATUSES, 'Conflict', errors);
  // resolution/resolved_by only make sense once the conflict is resolved;
  // an open conflict legitimately carries empty ones.
  const status = record['status'];
  if (status === 'resolved') {
    requireNonEmptyString(record, 'resolution', 'Conflict', errors);
    requireNonEmptyString(record, 'resolved_by', 'Conflict', errors);
  }
  return { valid: errors.length === 0, errors };
}
