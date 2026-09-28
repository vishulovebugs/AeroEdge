'use strict';

/**
 * Memory lifecycle state machine for AeroEdge (Phase 4).
 *
 * The lifecycle is EXPLICIT and STORED on every Memory record — consumers
 * read `lifecycle_status` and `jev_status` from storage, they never infer a
 * memory's standing from its age, usage, or content. The state machine is
 * the only legal way statuses change; edge/orchestrator.js applies its
 * decisions through `transition()`, which rejects illegal jumps.
 *
 * States (shared/schemas.js LifecycleStatus / JEVStatus):
 *
 *   lifecycle: new → local → used → sync_pending → synced
 *                       └──────────────→ expired        (from local|used)
 *              new ────────────────→ expired            (still unused)
 *   JEV-aware branches (Phase 5 populates these for real; the transitions
 *   already exist here so the state machine is complete):
 *              any live state → conflict   (JEV Cloud Pass disagreement)
 *              conflict → resolved         (adjudicated)
 *              any live state → expired    (superseded/withdrawn)
 *
 *   jev:       not_applicable → pending → accept_local | needs_more_evidence
 *              | flag_risk → (Phase 5: validated | needs_human_review | rejected)
 *              accept_local → validated                    (Cloud Pass upgrade)
 *
 * The `used` state means "this memory informed at least one grounded answer"
 * — evidence was consumed, not merely stored. Only JEV `validated` memories
 * may ever become fleet-wide truth (enforced from Phase 5 on; nothing this
 * phase can produce is authoritative).
 */

/**
 * @typedef {import('./schemas.js').LifecycleStatus} LifecycleStatus
 * @typedef {import('./schemas.js').JEVStatus} JEVStatus
 */

/**
 * Legal lifecycle transitions: state → set of states it may move to.
 * Deliberately explicit and closed — anything not listed is rejected.
 * @type {Readonly<Record<string, ReadonlySet<string>>>}
 */
export const LIFECYCLE_TRANSITIONS = Object.freeze({
  new: Object.freeze(new Set(['local', 'expired'])),
  local: Object.freeze(new Set(['used', 'sync_pending', 'expired', 'conflict'])),
  used: Object.freeze(new Set(['sync_pending', 'expired', 'conflict'])),
  sync_pending: Object.freeze(new Set(['synced', 'conflict'])),
  synced: Object.freeze(new Set(['expired', 'conflict'])),
  expired: Object.freeze(new Set()), // terminal
  conflict: Object.freeze(new Set(['resolved', 'expired'])),
  resolved: Object.freeze(new Set(['local', 'used', 'sync_pending', 'expired'])),
});

/** Legal jev_status transitions: state → set of states it may move to. */
export const JEV_TRANSITIONS = Object.freeze({
  not_applicable: Object.freeze(new Set(['pending'])),
  pending: Object.freeze(
    new Set(['accept_local', 'needs_more_evidence', 'flag_risk', 'rejected'])
  ),
  accept_local: Object.freeze(new Set(['validated', 'flag_risk', 'rejected'])),
  needs_more_evidence: Object.freeze(new Set(['accept_local', 'flag_risk', 'rejected'])),
  flag_risk: Object.freeze(new Set(['accept_local', 'validated', 'needs_human_review', 'rejected'])),
  validated: Object.freeze(new Set()), // terminal for this phase (Cloud Pass, Phase 5+)
  needs_human_review: Object.freeze(new Set(['validated', 'rejected'])),
  rejected: Object.freeze(new Set()), // terminal
});

/** Error thrown for any illegal lifecycle transition. */
export class LifecycleError extends Error {
  /**
   * @param {string} kind 'lifecycle_status' | 'jev_status'
   * @param {string} from
   * @param {string} to
   */
  constructor(kind, from, to) {
    super(
      `Illegal ${kind} transition ${JSON.stringify(from)} → ${JSON.stringify(to)}. ` +
        'Memory lifecycle is explicit and stored; use edge/orchestrator.js routing to change it.'
    );
    this.name = 'LifecycleError';
    this.kind = kind;
    this.from = from;
    this.to = to;
  }
}

/**
 * Validate (without applying) a lifecycle transition.
 * @param {LifecycleStatus} from
 * @param {LifecycleStatus} to
 * @returns {boolean}
 */
export function canTransition(from, to) {
  return LIFECYCLE_TRANSITIONS[from]?.has(to) ?? false;
}

/**
 * Validate (without applying) a jev_status transition.
 * @param {JEVStatus} from
 * @param {JEVStatus} to
 * @returns {boolean}
 */
export function canJevTransition(from, to) {
  return JEV_TRANSITIONS[from]?.has(to) ?? false;
}

/**
 * Compute the next lifecycle status. Pure: returns the value, does not touch
 * any record. Throws LifecycleError for illegal jumps — statuses change only
 * through this table, never ad hoc.
 * @param {LifecycleStatus} from Current stored status.
 * @param {LifecycleStatus} to Requested status.
 * @returns {LifecycleStatus}
 */
export function transitionLifecycle(from, to) {
  if (!canTransition(from, to)) throw new LifecycleError('lifecycle_status', from, to);
  return to;
}

/**
 * Compute the next jev status. Pure. Throws LifecycleError for illegal jumps.
 * @param {JEVStatus} from Current stored status.
 * @param {JEVStatus} to Requested status.
 * @returns {JEVStatus}
 */
export function transitionJev(from, to) {
  if (!canJevTransition(from, to)) throw new LifecycleError('jev_status', from, to);
  return to;
}

/**
 * The lifecycle path each memory type STARTS on when captured. `manual`
 * memories are authoritative reference material ingested from documents;
 * field observations and session notes are technician-generated and start
 * unvalidated. Authoritative documents never carry technician lifecycle
 * semantics — they live in the document collection, not the memory store.
 * @param {'manual'|'field_observation'|'session_note'} memoryType
 * @returns {{ lifecycle: LifecycleStatus, jev: JEVStatus }}
 */
export function initialStatusFor(memoryType) {
  switch (memoryType) {
    case 'manual':
      // Authoritative documents are reference material: no technician
      // lifecycle, and JEV does not evaluate reference truth.
      return { lifecycle: 'local', jev: 'not_applicable' };
    case 'field_observation':
    case 'session_note':
      // Technician-generated: created unvalidated, pending JEV.
      return { lifecycle: 'new', jev: 'pending' };
    default:
      throw new TypeError(`initialStatusFor: unknown memory type "${memoryType}"`);
  }
}
