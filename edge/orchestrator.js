'use strict';

/**
 * Memory Orchestrator for AeroEdge (Phase 4).
 *
 * The orchestrator is the brain that moves technician knowledge through its
 * EXPLICIT lifecycle (shared/lifecycle.js). Every decision it makes has a
 * stored result — nothing about a memory's standing is inferred at read time.
 *
 * Decision flow:
 *   verdict source → routeMemory(memory, verdict, opts) → action
 *                  → applyRoute(memory, route) → persisted transitions
 *
 * The verdict source is a parameter, not a hidden dependency: THIS phase
 * wires `stubVerdictSource` (always `accept_local`) because real JEV does
 * not exist yet. Phase 5 swaps the stub for the Edge Pass WITHOUT changing
 * routeMemory's signature — the routing function takes the verdict as an
 * explicit input.
 *
 * What this phase deliberately does NOT do: no real JEV reasoning, no sync
 * engine (SYNC only marks the stored `sync_pending` state), no conflict
 * resolution (FLAG_CONFLICT is defined and rejected at runtime until Phase 5
 * can produce a real conflict verdict), no UI.
 */

import { randomUUID } from 'node:crypto';
import {
  transitionLifecycle,
  transitionJev,
  initialStatusFor,
} from '../shared/lifecycle.js';
import { createMemoryStore } from './memoryStore.js';
import { validateMemory } from '../shared/schemas.js';

/**
 * @typedef {import('../shared/schemas.js').Memory} Memory
 * @typedef {import('../shared/schemas.js').JEVStatus} JEVStatus
 * @typedef {import('./session.js').SessionState} SessionState
 */

/** Orchestrator actions (the routing table's output alphabet). */
export const ACTIONS = Object.freeze(['KEEP_LOCAL', 'SYNC', 'EXPIRE', 'UPDATE', 'FLAG_CONFLICT']);

/** Importance at or above which an accepted local memory becomes SYNC-eligible. */
export const SYNC_IMPORTANCE_THRESHOLD = 0.7;

/**
 * The routing decision.
 * @typedef {Object} RouteDecision
 * @property {'KEEP_LOCAL'|'SYNC'|'EXPIRE'|'UPDATE'|'FLAG_CONFLICT'} action
 * @property {Memory} memory The memory as evaluated (not yet transitioned).
 * @property {string} [updateOf] For UPDATE: the memory_id being revised.
 * @property {string} reason Human-readable justification (stored in audit trails).
 * @property {string} verdict Verdict value that drove the decision.
 */

/**
 * Stub verdict source (Phase 4 stand-in for the Edge JEV Pass).
 *
 * Always returns `accept_local` — the point of the stub is to make the
 * WIRING real while the reasoning is not built yet. Returns a Promise-shaped
 * interface so Phase 5's real evaluator (which will call Ollama with
 * evidence) can drop in without any caller changes. Callers may attach
 * `evidence`/`question`; the stub ignores them by design.
 *
 * @param {Object} [context]
 * @param {Memory} [context.memory]
 * @param {string} [context.question]
 * @param {unknown[]} [context.evidence]
 * @returns {Promise<{ verdict: 'accept_local', rationale: string, confidence: number, model_used: string, evaluated_at: string, stub: true }>}
 */
export async function stubVerdictSource(context = {}) {
  const voidContext = context; // deliberately unused: stub is reasoning-free
  return {
    verdict: 'accept_local',
    rationale:
      'Stub verdict source (Phase 4): no JEV reasoning exists yet. ' +
      'Every memory is accepted for local use and remains UNVALIDATED — ' +
      'never fleet-wide truth until the Edge Pass (Phase 5) evaluates it.',
    confidence: 0.0,
    model_used: 'aeroedge-stub-verdict',
    evaluated_at: new Date().toISOString(),
    stub: true,
  };
}

/**
 * Normalize a verdict input from any source (stub or, later, real JEV) into
 * the shape the routing table consumes. Unknown verdict values are rejected
 * loudly rather than defaulted — a wrong verdict must never route silently.
 * @param {{ verdict: string, rationale?: string, confidence?: number, model_used?: string, evaluated_at?: string, stub?: boolean }} verdictInput
 * @returns {{ verdict: string, rationale: string, confidence: number, model_used: string, evaluated_at: string, stub: boolean }}
 */
function normalizeVerdict(verdictInput) {
  if (verdictInput === null || typeof verdictInput !== 'object' || typeof verdictInput.verdict !== 'string') {
    throw new TypeError('routeMemory: verdict input must be an object with a string "verdict"');
  }
  const allowed = ['accept_local', 'needs_more_evidence', 'flag_risk', 'validated', 'needs_human_review', 'rejected'];
  if (!allowed.includes(verdictInput.verdict)) {
    throw new TypeError(
      `routeMemory: unknown verdict "${verdictInput.verdict}" (allowed: ${allowed.join(', ')})`
    );
  }
  return {
    verdict: verdictInput.verdict,
    rationale: typeof verdictInput.rationale === 'string' ? verdictInput.rationale : '',
    confidence: typeof verdictInput.confidence === 'number' ? verdictInput.confidence : 0,
    model_used: typeof verdictInput.model_used === 'string' ? verdictInput.model_used : 'unknown',
    evaluated_at:
      typeof verdictInput.evaluated_at === 'string' ? verdictInput.evaluated_at : new Date().toISOString(),
    stub: verdictInput.stub === true,
  };
}

/**
 * The Phase 4 routing table.
 *
 * Precedence: EXPIRE > UPDATE > verdict-driven routing.
 *
 *   EXPIRE: explicit request; any non-manual, non-expired memory expires.
 *   UPDATE: explicit revision request (`opts.updateOf`) — the revision is
 *           stored as a NEW version with lineage, never a silent overwrite.
 *   verdict accept_local (the only verdict producible this phase):
 *     - session_note                       → KEEP LOCAL (working memory)
 *     - already synced / sync_pending      → KEEP LOCAL (routing again is a no-op)
 *     - importance ≥ 0.7                   → SYNC (mark stored sync_pending)
 *     - otherwise                          → KEEP LOCAL
 *   needs_more_evidence / flag_risk / rejected → FLAG_CONFLICT-only phase:
 *     these require the sync/JEV machinery of later phases, so routing
 *     throws a loud, named error instead of pretending to decide.
 *
 * Pure: computes the decision, does not persist or mutate anything.
 *
 * @param {Memory} memory The current stored memory (statuses read, not mutated).
 * @param {{ verdict: string, rationale?: string, confidence?: number, model_used?: string, evaluated_at?: string, stub?: boolean }} verdictInput Explicit verdict input (stub this phase; real JEV from Phase 5).
 * @param {Object} [opts]
 * @param {boolean} [opts.expire] Explicit expiry request (technician withdrawal).
 * @param {string} [opts.updateOf] Explicit revision request: memory_id being revised.
 * @returns {RouteDecision}
 */
export function routeMemory(memory, verdictInput, opts = {}) {
  if (memory === null || typeof memory !== 'object' || typeof memory.memory_id !== 'string') {
    throw new TypeError('routeMemory: memory must be a Memory record with a memory_id');
  }
  const verdict = normalizeVerdict(verdictInput);
  const lifecycle = memory.lifecycle_status;

  if (opts.expire === true) {
    if (memory.memory_type === 'manual') {
      throw new TypeError(
        'routeMemory: authoritative manual memories cannot be expired by the technician lifecycle'
      );
    }
    if (lifecycle === 'expired') {
      return { action: 'EXPIRE', memory, reason: 'already expired (no-op)', verdict: verdict.verdict };
    }
    return { action: 'EXPIRE', memory, reason: 'explicit expiry request', verdict: verdict.verdict };
  }

  if (opts.updateOf !== undefined) {
    if (typeof opts.updateOf !== 'string' || opts.updateOf.trim() === '') {
      throw new TypeError('routeMemory: "updateOf" must be a non-empty memory_id when provided');
    }
    if (memory.memory_type === 'session_note') {
      throw new TypeError('routeMemory: session notes are working memory and are not revised; capture a new note instead');
    }
    if (lifecycle === 'expired') {
      throw new Error('routeMemory: expired memories cannot be revised; capture a new observation instead');
    }
    return {
      action: 'UPDATE',
      memory,
      updateOf: opts.updateOf,
      reason: `explicit revision of ${opts.updateOf}: store as a new version, never a silent overwrite`,
      verdict: verdict.verdict,
    };
  }

  if (verdict.verdict !== 'accept_local') {
    throw new TypeError(
      `routeMemory: verdict "${verdict.verdict}" requires the JEV/sync machinery of later phases; ` +
        'this phase routes only accept_local (stub). Refusing to decide silently.'
    );
  }

  if (memory.memory_type === 'session_note') {
    return { action: 'KEEP_LOCAL', memory, reason: 'session note: working memory, never synced', verdict: verdict.verdict };
  }
  if (memory.memory_type === 'manual') {
    // Manual documents are authoritative reference material: no technician
    // sync lifecycle, JEV does not evaluate them, importance is metadata.
    return {
      action: 'KEEP_LOCAL',
      memory,
      reason: 'manual document: authoritative reference material, outside the technician lifecycle',
      verdict: verdict.verdict,
    };
  }
  if (lifecycle === 'synced' || lifecycle === 'sync_pending') {
    return {
      action: 'KEEP_LOCAL',
      memory,
      reason: `already ${lifecycle}: re-routing is a no-op`,
      verdict: verdict.verdict,
    };
  }
  if (typeof memory.importance === 'number' && memory.importance >= SYNC_IMPORTANCE_THRESHOLD) {
    return {
      action: 'SYNC',
      memory,
      reason: `accept_local with importance ${memory.importance} ≥ ${SYNC_IMPORTANCE_THRESHOLD}: eligible for sync`,
      verdict: verdict.verdict,
    };
  }
  return {
    action: 'KEEP_LOCAL',
    memory,
    reason: `accept_local with importance ${memory.importance} < ${SYNC_IMPORTANCE_THRESHOLD}: kept local`,
    verdict: verdict.verdict,
  };
}

/**
 * @param {Object} options
 * @param {Readonly<Record<string, string>>} config Loaded shared config (required unless a memoryStore is injected).
 * @param {ReturnType<typeof createMemoryStore>} [memoryStore] Injected store (tests); built from config otherwise.
 * @param {import('./session.js').SessionState} [session] Attached diagnostic session (Phase 3) — observations are mirrored into it.
 * @param {(context?: unknown) => Promise<{ verdict: string, [k: string]: unknown }>} [verdictSource] Verdict source (defaults to the stub; Phase 5 replaces it).
 */
export function createMemoryOrchestrator({ config, memoryStore: injectedStore, session, verdictSource } = {}) {
  const getVerdict = verdictSource ?? stubVerdictSource;
  const store = injectedStore ?? createMemoryStore({ config });
  /** @type {SessionState|null} */
  let attachedSession = session ?? null;

  /** @param {SessionState|null} s */
  function requireSessionState(s) {
    if (s !== null && (s === undefined || s === null || typeof s !== 'object' || !Array.isArray(s.recentQueries))) {
      throw new TypeError('attachSession expects a Phase 3 session state object (edge/session.js createSession)');
    }
  }
  requireSessionState(attachedSession);

  /** Max observations mirrored into a session (session state must stay bounded). */
  const MAX_SESSION_OBSERVATIONS = 20;

  /**
   * Mirror a stored observation into the attached session's bounded
   * "technician observations so far" state (Phase 3 field, Phase 4 writer).
   * @param {Memory} record
   */
  function noteObservation(record) {
    if (attachedSession === null) return false;
    if (!Array.isArray(attachedSession.observations)) attachedSession.observations = [];
    attachedSession.observations.push({
      memoryId: record.memory_id,
      content: record.content,
      notedAt: new Date().toISOString(),
    });
    if (attachedSession.observations.length > MAX_SESSION_OBSERVATIONS) {
      attachedSession.observations.splice(0, attachedSession.observations.length - MAX_SESSION_OBSERVATIONS);
    }
    return true;
  }

  /**
   * Capture a technician observation OFFLINE, immediately, as a stored
   * Memory record: memory_type field_observation, lifecycle `new`, jev
   * `pending` — useful locally, authoritative for nothing. It is stored in
   * the memories collection, architecturally separate from authoritative
   * manual documents.
   * @param {Object} input
   * @param {string} input.content What the technician observed (verbatim).
   * @param {string} input.assetId Asset the observation is about.
   * @param {string} input.source Technician/device identity.
   * @param {string} [input.component] Subsystem, when known.
   * @param {number} [input.importance] 0..1 (default 0.4).
   * @param {number} [input.confidence] 0..1 (default 0.5).
   * @returns {Promise<Memory>} The stored record.
   */
  async function captureObservation({ content, assetId, source, component, importance = 0.4, confidence = 0.5 }) {
    for (const [name, value] of Object.entries({ content, assetId, source })) {
      if (typeof value !== 'string' || value.trim() === '') {
        throw new TypeError(`captureObservation requires a non-empty "${name}"`);
      }
    }
    for (const [name, value] of [['importance', importance], ['confidence', confidence]]) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
        throw new TypeError(`captureObservation: "${name}" must be a finite number in [0, 1]`);
      }
    }
    const now = new Date().toISOString();
    /** @type {Memory} */
    const record = /** @type {Memory} */ ({
      memory_id: `mem-${randomUUID()}`,
      memory_type: 'field_observation',
      content: content.trim(),
      asset_id: assetId.trim(),
      source: source.trim(),
      version: '1',
      importance,
      confidence,
      created_at: now,
      updated_at: now,
      sync_status: 'local',
      lifecycle_status: 'new',
      jev_status: 'pending',
    });
    const stored = await store.putMemory(record);
    noteObservation(stored);
    return stored;
  }

  /**
   * Capture a session note (Type B working memory) tied to the session.
   * @param {Object} input
   * @param {string} input.content
   * @param {string} input.assetId
   * @param {string} input.source
   * @param {number} [input.importance]
   * @param {number} [input.confidence]
   * @returns {Promise<Memory>}
   */
  async function captureSessionNote({ content, assetId, source, importance = 0.3, confidence = 0.5 }) {
    for (const [name, value] of Object.entries({ content, assetId, source })) {
      if (typeof value !== 'string' || value.trim() === '') {
        throw new TypeError(`captureSessionNote requires a non-empty "${name}"`);
      }
    }
    const now = new Date().toISOString();
    /** @type {Memory} */
    const record = /** @type {Memory} */ ({
      memory_id: `mem-${randomUUID()}`,
      memory_type: 'session_note',
      content: content.trim(),
      asset_id: assetId.trim(),
      source: source.trim(),
      version: '1',
      importance,
      confidence,
      created_at: now,
      updated_at: now,
      sync_status: 'local',
      lifecycle_status: 'new',
      jev_status: 'pending',
    });
    const stored = await store.putMemory(record);
    noteObservation(stored);
    return stored;
  }

  /**
   * Record an authoritative manual document as a Type A memory. Manuals are
   * reference material: lifecycle `local`, jev `not_applicable` — they are
   * the baseline truth technician knowledge is measured against, and they
   * never ride the technician lifecycle.
   * @param {Object} input
   * @param {string} input.content
   * @param {string} input.assetId
   * @param {string} input.source
   * @param {string} [input.version]
   * @param {number} [input.importance]
   * @returns {Promise<Memory>}
   */
  async function captureManual({ content, assetId, source, version = '1', importance = 0.9 }) {
    for (const [name, value] of Object.entries({ content, assetId, source })) {
      if (typeof value !== 'string' || value.trim() === '') {
        throw new TypeError(`captureManual requires a non-empty "${name}"`);
      }
    }
    const now = new Date().toISOString();
    /** @type {Memory} */
    const record = /** @type {Memory} */ ({
      memory_id: `mem-${randomUUID()}`,
      memory_type: 'manual',
      content: content.trim(),
      asset_id: assetId.trim(),
      source: source.trim(),
      version,
      importance,
      confidence: 1,
      created_at: now,
      updated_at: now,
      sync_status: 'local',
      lifecycle_status: initialStatusFor('manual').lifecycle,
      jev_status: initialStatusFor('manual').jev,
    });
    return store.putMemory(record);
  }

  /**
   * Ask the verdict source (stub now, Edge JEV Pass in Phase 5) and route.
   * @param {Memory} memory
   * @param {Object} [opts]
   * @param {boolean} [opts.expire]
   * @param {string} [opts.updateOf]
   * @param {string} [opts.question] Context for the verdict source.
   * @param {unknown[]} [opts.evidence] Evidence for the verdict source.
   * @returns {Promise<RouteDecision>}
   */
  async function routeWithVerdict(memory, opts = {}) {
    const verdictInput = await getVerdict({ memory, question: opts.question, evidence: opts.evidence });
    return routeMemory(memory, verdictInput, { expire: opts.expire, updateOf: opts.updateOf });
  }

  /**
   * Apply a routing decision: performs the legal lifecycle transitions via
   * shared/lifecycle.js and persists the updated record. Returns the stored
   * record and every transition applied.
   * @param {RouteDecision} decision
   * @returns {Promise<{ memory: Memory, action: string, transitions: string[] }>}
   */
  async function applyRoute(decision) {
    const { action } = decision;
    if (!ACTIONS.includes(action)) throw new TypeError(`applyRoute: unknown action "${action}"`);
    /** @type {Memory} */
    let record = /** @type {Memory} */ ({ ...decision.memory });
    /** @type {string[]} */
    const transitions = [];

    const stepLifecycle = (to) => {
      const from = record.lifecycle_status;
      record = { ...record, lifecycle_status: transitionLifecycle(from, to) };
      transitions.push(`lifecycle ${from} → ${to}`);
    };
    const stepJev = (to) => {
      const from = record.jev_status;
      record = { ...record, jev_status: transitionJev(from, to) };
      transitions.push(`jev ${from} → ${to}`);
    };

    if (action === 'EXPIRE') {
      stepLifecycle('expired');
    } else if (action === 'KEEP_LOCAL' || action === 'SYNC') {
      // Existence acknowledged: new → local, pending → accept_local (stub).
      if (record.lifecycle_status === 'new') stepLifecycle('local');
      if (record.jev_status === 'pending' && decision.verdict === 'accept_local') stepJev('accept_local');
      if (action === 'SYNC' && record.lifecycle_status !== 'sync_pending') stepLifecycle('sync_pending');
    } else if (action === 'UPDATE') {
      // UPDATE stores a NEW version with lineage; the parent is never
      // mutated or deleted (no silent overwrite — asserted in tests).
      const parentId = decision.updateOf;
      if (typeof parentId !== 'string' || parentId.trim() === '') {
        throw new TypeError('applyRoute: UPDATE requires decision.updateOf (the memory_id being revised)');
      }
      const parent = await store.getMemory(parentId);
      if (parent === null) {
        throw new Error(`applyRoute: UPDATE parent "${parentId}" not found (no orphan revisions)`);
      }
      if (parent.memory_type !== 'manual' && parent.memory_type !== 'field_observation') {
        throw new TypeError(`applyRoute: UPDATE parent type "${parent.memory_type}" is not revisable`);
      }
      if (parent.lifecycle_status === 'expired') {
        throw new Error('applyRoute: UPDATE parent is expired; revise a live memory');
      }
      const parentVersion = Number(parent.version);
      record = {
        ...record,
        memory_id: `mem-${randomUUID()}`,
        version: Number.isFinite(parentVersion) ? String(parentVersion + 1) : '1',
        revision_of: parentId,
      };
      // Validate shape after identity/lineage edits before storing.
      const verdictOf = validateMemory(record);
      if (!verdictOf.valid) {
        throw new Error(`applyRoute: UPDATE record invalid: ${verdictOf.errors.join('; ')}`);
      }
      // The revision keeps its initial statuses (new/pending for technician
      // types) — Phase 5's verdict source routes it like any other memory.
    } else if (action === 'FLAG_CONFLICT') {
      throw new Error(
        'applyRoute: FLAG_CONFLICT requires the sync/conflict machinery of later phases — routing refused to decide silently'
      );
    }

    record = { ...record, updated_at: new Date().toISOString() };
    const stored = await store.putMemory(record);
    if (action === 'UPDATE') noteObservation(stored);
    return { memory: stored, action, transitions };
  }

  /**
   * Revise an existing revisable memory (manual or field_observation): the
   * corrected content becomes a NEW version through the UPDATE route, with
   * `revision_of` lineage. The parent record is never mutated or deleted —
   * versioned successor, never a silent overwrite.
   * @param {string} memoryId Memory being revised.
   * @param {Object} input
   * @param {string} input.content Corrected content.
   * @param {number} [input.importance]
   * @param {number} [input.confidence]
   * @returns {Promise<{ memory: Memory, action: string, transitions: string[] }>}
   */
  async function reviseMemory(memoryId, { content, importance, confidence } = {}) {
    if (typeof content !== 'string' || content.trim() === '') {
      throw new TypeError('reviseMemory requires non-empty "content"');
    }
    const parent = await store.getMemory(memoryId);
    if (parent === null) throw new Error(`reviseMemory: memory "${memoryId}" not found`);
    const now = new Date().toISOString();
    const parentVersion = Number(parent.version);
    /** @type {Memory} */
    const revision = /** @type {Memory} */ ({
      memory_id: `mem-${randomUUID()}`,
      memory_type: parent.memory_type,
      content: content.trim(),
      asset_id: parent.asset_id,
      source: parent.source,
      version: Number.isFinite(parentVersion) ? String(parentVersion + 1) : '1',
      importance: importance ?? parent.importance,
      confidence: confidence ?? parent.confidence,
      created_at: now,
      updated_at: now,
      sync_status: 'local',
      lifecycle_status: parent.memory_type === 'manual' ? 'local' : 'new',
      jev_status: parent.memory_type === 'manual' ? 'not_applicable' : 'pending',
      revision_of: parent.memory_id,
    });
    const verdictInput = await getVerdict({ memory: revision });
    const decision = routeMemory(revision, verdictInput, { updateOf: parent.memory_id });
    return applyRoute(decision);
  }

  /**
   * Mark a memory as having informed at least one grounded answer
   * (`used`): evidence was CONSUMED, not merely stored. jev_status is
   * deliberately untouched — usage is not validation.
   * @param {string} memoryId
   * @returns {Promise<{ memory: Memory, transitions: string[] }>}
   */
  async function noteMemoryUsed(memoryId) {
    const record = await store.getMemory(memoryId);
    if (record === null) throw new Error(`noteMemoryUsed: memory "${memoryId}" not found`);
    if (record.memory_type === 'manual') {
      throw new TypeError('noteMemoryUsed: manual documents do not carry the technician usage lifecycle');
    }
    /** @type {Memory} */
    let updated = /** @type {Memory} */ ({ ...record });
    /** @type {string[]} */
    const transitions = [];
    if (updated.lifecycle_status !== 'used') {
      // Usage composes the legal steps: a freshly captured memory must be
      // acknowledged (new → local) before it can count as used. Terminal
      // states (expired/conflict) are refused by the state machine —
      // silently "using" an expired memory would be a lie.
      if (updated.lifecycle_status === 'new') {
        updated = { ...updated, lifecycle_status: transitionLifecycle('new', 'local') };
        transitions.push('lifecycle new → local');
      }
      const from = updated.lifecycle_status;
      updated = { ...updated, lifecycle_status: transitionLifecycle(from, 'used') };
      transitions.push(`lifecycle ${from} → used`);
      updated = { ...updated, updated_at: new Date().toISOString() };
      await store.putMemory(updated);
    }
    return { memory: updated, transitions };
  }

  /**
   * Mark a memory sync_pending (stored state only this phase; the sync
   * engine itself arrives with the cloud phases).
   * @param {string} memoryId
   * @returns {Promise<{ memory: Memory, transitions: string[] }>}
   */
  async function markMemorySyncPending(memoryId) {
    const record = await store.getMemory(memoryId);
    if (record === null) throw new Error(`markMemorySyncPending: memory "${memoryId}" not found`);
    if (record.memory_type === 'manual') {
      throw new TypeError('markMemorySyncPending: manual documents do not carry the technician sync lifecycle');
    }
    /** @type {Memory} */
    let updated = /** @type {Memory} */ ({ ...record });
    /** @type {string[]} */
    const transitions = [];
    if (updated.lifecycle_status !== 'sync_pending') {
      const from = updated.lifecycle_status;
      // Throws for illegal jumps (e.g. re-marking a synced memory).
      updated = { ...updated, lifecycle_status: transitionLifecycle(from, 'sync_pending') };
      transitions.push(`lifecycle ${from} → sync_pending`);
      // jev_status is deliberately untouched here: sync is transport, not
      // validation. Only the verdict source may move pending → accept_local.
      updated = { ...updated, updated_at: new Date().toISOString() };
      await store.putMemory(updated);
    }
    return { memory: updated, transitions };
  }

  /**
   * Attach (or replace) the diagnostic session whose "technician
   * observations so far" state this orchestrator writes.
   * @param {SessionState} sessionState
   */
  function attachSession(sessionState) {
    requireSessionState(sessionState);
    attachedSession = sessionState;
  }

  return {
    captureObservation,
    captureSessionNote,
    captureManual,
    routeWithVerdict,
    applyRoute,
    reviseMemory,
    noteMemoryUsed,
    markMemorySyncPending,
    attachSession,
    /** The store backing this orchestrator (for listing/auditing). */
    store,
    /** Whether a Phase 3 session is currently attached. */
    hasSession: () => attachedSession !== null,
  };
}
