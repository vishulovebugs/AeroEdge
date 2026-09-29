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
 * The verdict source is a parameter, not a hidden dependency, and
 * routeMemory's signature treats the verdict as an EXPLICIT input — it
 * never changed shape when Phase 5 swapped the Phase 4 stub for the real
 * Edge JEV Pass (edge/jev.js), which is now the DEFAULT verdict source.
 * `stubVerdictSource` is kept exported for tests and debugging.
 *
 * Phase 5 verdict-driven routing (the real table, per the JEV Edge Pass):
 *   accept_local        → KEEP_LOCAL, or SYNC when importance ≥ 0.7
 *   needs_more_evidence → KEEP_LOCAL only; NEVER sync-eligible, however
 *                         high the importance (the record is not yet
 *                         trustworthy enough to share)
 *   flag_risk           → KEEP_LOCAL with the high-visibility flag_risk
 *                         jev_status STORED on the record; still
 *                         sync-eligible so a human sees it, but never
 *                         auto-propagatable (a flag is a call for review,
 *                         not a truth claim)
 *
 * The hard rule, enforced in code: JEV NEVER BLOCKS RECORDING.
 * captureAndRoute/captureSessionNote store the memory FIRST; evaluation
 * runs after the record is durably stored, and any evaluator failure is
 * coerced to needs_more_evidence (never an exception at capture time).
 *
 * What this phase deliberately does NOT do: no sync engine (SYNC only
 * marks the stored `sync_pending` state), no conflict resolution
 * (FLAG_CONFLICT still refuses loudly — real conflicts need fleet
 * context, Phase 10), no cloud pass, no UI.
 */

import { randomUUID } from 'node:crypto';
import {
  transitionLifecycle,
  transitionJev,
  initialStatusFor,
} from '../shared/lifecycle.js';
import { createMemoryStore } from './memoryStore.js';
import { createOllamaClient } from './ollama.js';
import { createQdrantClient } from './qdrant.js';
import { createEdgeJev } from './jev.js';
import { validateMemory, validateJEVVerdict } from '../shared/schemas.js';

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
 * Stub verdict source (Phase 4 stand-in, kept for tests and debugging).
 *
 * Always returns `accept_local` — real evaluation lives in edge/jev.js,
 * which is now the DEFAULT verdict source. Pass this stub explicitly via
 * `verdictSource` to route with reasoning disabled. Promise-shaped so the
 * two are interchangeable at every call site.
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
 *   accept_local (Edge Pass accepted for local use):
 *     - session_note                       → KEEP LOCAL (working memory)
 *     - already synced / sync_pending      → KEEP LOCAL (routing again is a no-op)
 *     - importance ≥ 0.7                   → SYNC (mark stored sync_pending)
 *     - otherwise                          → KEEP LOCAL
 *   needs_more_evidence: KEEP LOCAL only — NEVER sync-eligible, however
 *     high the importance; the technician is prompted for more detail.
 *   flag_risk: KEEP LOCAL — high-visibility (stored flag_risk jev_status);
 *     still sync-eligible so a human sees it, never auto-propagatable.
 *   Cloud-only verdicts (validated/needs_human_review/rejected) throw:
 *     the Edge Pass cannot produce them.
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

  // Phase 5: the verdict-driven rows are real. Cloud-only verdicts
  // (validated/needs_human_review/rejected) still refuse loudly — the Edge
  // Pass (edge/jev.js) never produces them, and routing on a verdict the
  // edge cannot even produce would be fiction.
  if (verdict.verdict === 'needs_more_evidence') {
    if (memory.memory_type === 'session_note') {
      return {
        action: 'KEEP_LOCAL',
        memory,
        reason: 'session note: working memory, never synced (needs_more_evidence noted)',
        verdict: verdict.verdict,
      };
    }
    if (lifecycle === 'synced' || lifecycle === 'sync_pending') {
      return {
        action: 'KEEP_LOCAL',
        memory,
        reason: `already ${lifecycle}: re-routing is a no-op (needs_more_evidence does not withdraw it)`,
        verdict: verdict.verdict,
      };
    }
    // NEVER sync-eligible, however high the importance: a record the
    // evaluator judged under-evidenced must not ride the sync table on
    // importance alone.
    return {
      action: 'KEEP_LOCAL',
      memory,
      reason:
        `needs_more_evidence: kept local and NOT sync-eligible regardless of importance ` +
        `(${memory.importance}); technician prompted for more detail`,
      verdict: verdict.verdict,
    };
  }

  if (verdict.verdict === 'flag_risk') {
    if (memory.memory_type === 'session_note') {
      return {
        action: 'KEEP_LOCAL',
        memory,
        reason: 'session note: working memory, never synced (risk noted on the record)',
        verdict: verdict.verdict,
      };
    }
    if (lifecycle === 'synced' || lifecycle === 'sync_pending') {
      return {
        action: 'KEEP_LOCAL',
        memory,
        reason: `already ${lifecycle}: re-routing is a no-op (flag_risk does not withdraw it)`,
        verdict: verdict.verdict,
      };
    }
    return {
      action: 'KEEP_LOCAL',
      memory,
      reason:
        'flag_risk: kept local, high-visibility (jev_status flag_risk stored); ' +
        'sync-eligible so a human sees it, never auto-propagatable',
      verdict: verdict.verdict,
    };
  }

  if (verdict.verdict !== 'accept_local') {
    throw new TypeError(
      `routeMemory: verdict "${verdict.verdict}" is a cloud-side verdict (Cloud Pass, later phases); ` +
        'the Edge Pass routes only accept_local | needs_more_evidence | flag_risk. Refusing to decide silently.'
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
 * @param {(context?: { memory?: Memory, question?: string, evidence?: unknown[] }) => Promise<{ verdict: string, [k: string]: unknown }>} [verdictSource] Verdict source override. DEFAULT since Phase 5: the real JEV Edge Pass (edge/jev.js). Pass stubVerdictSource to route with evaluation disabled (tests).
 * @param {ReturnType<typeof import('./ollama.js').createOllamaClient>} [ollama] Injected Ollama client for the DEFAULT Edge Pass (tests); built from config otherwise.
 * @param {ReturnType<typeof import('./qdrant.js').createQdrantClient>} [qdrant] Injected Edge Qdrant DOCUMENT client for the DEFAULT Edge Pass (tests); built from config otherwise.
 */
export function createMemoryOrchestrator({ config, memoryStore: injectedStore, session, verdictSource, ollama, qdrant } = {}) {
  const store = injectedStore ?? createMemoryStore({ config });
  /** @type {SessionState|null} */
  let attachedSession = session ?? null;

  /**
   * The default verdict source: the real JEV Edge Pass (edge/jev.js).
   * Built lazily against the authoritative document collection on the Edge
   * Qdrant instance; the injected `verdictSource` (tests, stub) takes
   * precedence when provided.
   */
  let edgeJev = null;
  function getEdgeJev() {
    if (edgeJev === null) {
      edgeJev = createEdgeJev({
        config: config ?? {},
        ollama:
          ollama ??
          createOllamaClient({
            baseUrl: config?.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434',
            embedModel: config?.EMBEDDING_MODEL ?? 'nomic-embed-text',
            generateModel: config?.OLLAMA_MODEL ?? 'unknown',
          }),
        qdrant:
          qdrant ??
          createQdrantClient({
            baseUrl: config?.QDRANT_EDGE_URL ?? 'http://localhost:6333',
            collection: config?.QDRANT_EDGE_COLLECTION ?? 'aeroedge_edge_docs',
          }),
      });
    }
    return edgeJev;
  }

  /**
   * Call the configured verdict source for a memory. The default runs the
   * real Edge Pass; injected sources (tests, stub) pass through untouched.
   * @param {Memory} memory
   * @param {{ question?: string, evidence?: unknown[] }} [context]
   */
  async function getVerdict(memory, context = {}) {
    if (verdictSource !== undefined) return verdictSource({ memory, ...context });
    return getEdgeJev().evaluateMemory(memory, {
      ...(context.evidence !== undefined ? { evidencePack: /** @type {any} */ (context.evidence) } : {}),
    });
  }

  /**
   * Stamp memory identity onto a verdict-source result and validate it
   * against the Phase 0 JEVVerdict contract, so the verdict persisted next
   * to the memory is always contract-clean. Returns null (no verdict record
   * stored) when the source result is too thin to be an evaluation — a
   * record without a non-empty rationale must never be persisted, per the
   * same rule that governs the model side.
   * @param {{ verdict: string, [k: string]: unknown }} verdictInput
   * @param {string} memoryId
   * @returns {Record<string, unknown>|null}
   */
  function buildVerdictRecord(verdictInput, memoryId) {
    if (verdictInput === null || typeof verdictInput !== 'object') return null;
    const rationale = typeof verdictInput.rationale === 'string' ? verdictInput.rationale.trim() : '';
    const modelUsed = typeof verdictInput.model_used === 'string' ? verdictInput.model_used.trim() : '';
    if (rationale === '' || modelUsed === '') return null;
    const record = {
      verdict_id: `jev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      memory_id: memoryId,
      stage: typeof verdictInput.stage === 'string' && verdictInput.stage !== '' ? verdictInput.stage : 'edge',
      verdict: verdictInput.verdict,
      rationale,
      confidence: typeof verdictInput.confidence === 'number' && Number.isFinite(verdictInput.confidence)
        ? Math.min(1, Math.max(0, verdictInput.confidence))
        : 0,
      risk_flags: Array.isArray(verdictInput.risk_flags) ? verdictInput.risk_flags.filter((f) => typeof f === 'string') : [],
      evidence_used: Array.isArray(verdictInput.evidence_used) ? verdictInput.evidence_used.filter((e) => typeof e === 'string') : [],
      model_used: modelUsed,
      evaluated_at: typeof verdictInput.evaluated_at === 'string' ? verdictInput.evaluated_at : new Date().toISOString(),
    };
    const check = validateJEVVerdict(record);
    return check.valid ? record : null;
  }

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
   * THE Phase 5 capture path: record FIRST, evaluate SECOND, route THIRD.
   *
   * Hard rule enforced HERE, in code (not merely in the JEV prompt): JEV
   * never blocks the technician from recording what they observed. The
   * memory is durably stored before evaluation begins; an evaluator error,
   * timeout, or garbage response can only change what happens AFTER
   * recording (it coerces to needs_more_evidence), never prevent it.
   *
   * @param {Object} input Same fields as captureObservation.
   * @param {string} input.content
   * @param {string} input.assetId
   * @param {string} input.source
   * @param {string} [input.component]
   * @param {number} [input.importance]
   * @param {number} [input.confidence]
   * @param {unknown} [input.evidence] Evidence pack from creation (Phase 1 pipeline retrieveEvidence output), passed to the Edge Pass when present.
   * @param {boolean} [input.route=true] Set false to record WITHOUT routing (verdict can be applied later via routeWithVerdict/applyRoute).
   * @returns {Promise<{ memory: Memory, recorded: true, verdict: Record<string, unknown>, decision: RouteDecision, applied: { memory: Memory, action: string, transitions: string[] } | null }>}
   *   `memory` is the record as FIRST stored (lifecycle new, jev pending);
   *   `verdict` is the contract-clean JEVVerdict persisted for it;
   *   `decision`/`applied` carry the verdict-driven route and its stored
   *   transitions (applied is null only when route=false).
   */
  async function captureAndRoute({ content, assetId, source, component, importance = 0.4, confidence = 0.5, evidence, route = true }) {
    // STEP 1 — RECORD. Storage precedes evaluation unconditionally.
    const stored = await captureObservation({ content, assetId, source, component, importance, confidence });

    // STEP 2 — EVALUATE. Failures coerce, never throw past the recording.
    const evidencePack = normalizeEvidencePack(evidence);
    let verdictInput;
    try {
      verdictInput = await getVerdict(stored, {
        ...(evidencePack !== undefined ? { evidence: evidencePack } : {}),
      });
    } catch (err) {
      verdictInput = {
        verdict: 'needs_more_evidence',
        rationale:
          `Edge Pass evaluator failed after recording (${/** @type {Error} */ (err).message}). ` +
          'Coerced to needs_more_evidence by code: recording is never blocked by evaluation.',
        confidence: 0,
        risk_flags: [],
        evidence_used: [],
        model_used: 'aeroedge-edge-jev',
        evaluated_at: new Date().toISOString(),
        stage: 'edge',
      };
    }

    // STEP 3 — SURFACE VERDICT + ROUTE. A verdict without a non-empty
    // rationale is not an evaluation (same rule as edge/jev.js): it is
    // coerced to needs_more_evidence, never passed through as a pass.
    const rationale = typeof verdictInput.rationale === 'string' ? verdictInput.rationale.trim() : '';
    const effective = rationale === ''
      ? {
          ...verdictInput,
          verdict: 'needs_more_evidence',
          confidence: 0,
          rationale:
            'Edge Pass verdict coerced by code: the evaluator produced no non-empty rationale. ' +
            'A JEV evaluation requires a stated reason; without one the record cannot pass.',
        }
      : verdictInput;
    const verdictRecord = buildVerdictRecord(effective, stored.memory_id) ??
      buildFallbackVerdictRecord(effective, stored.memory_id);

    /** @type {RouteDecision} */
    const decision = routeMemory(stored, effective);
    const applied = route ? await applyRoute(decision) : null;
    return { memory: stored, recorded: true, verdict: verdictRecord, decision, applied };
  }

  /**
   * Contract-valid verdict record for coerced results whose source shape
   * could not satisfy buildVerdictRecord (e.g. a missing model_used).
   * @param {{ verdict: string, rationale: string, confidence?: number, risk_flags?: unknown, evidence_used?: unknown, model_used?: string, evaluated_at?: string }} input
   * @param {string} memoryId
   * @returns {Record<string, unknown>}
   */
  function buildFallbackVerdictRecord(input, memoryId) {
    const record = {
      verdict_id: `jev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      memory_id: memoryId,
      stage: 'edge',
      verdict: 'needs_more_evidence',
      rationale: input.rationale,
      confidence: 0,
      risk_flags: [],
      evidence_used: [],
      model_used: 'aeroedge-edge-jev',
      evaluated_at: new Date().toISOString(),
    };
    const check = validateJEVVerdict(record);
    if (!check.valid) throw new Error(`coerced JEVVerdict failed contract validation: ${check.errors.join('; ')}`);
    return record;
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
   * Accept an evidence argument from callers: a bare EvidencePack, a
   * single-element array wrapping one, or nothing.
   * @param {unknown} evidence
   * @returns {unknown|undefined}
   */
  function normalizeEvidencePack(evidence) {
    if (evidence === null || evidence === undefined) return undefined;
    if (Array.isArray(evidence)) {
      return evidence.length === 1 && evidence[0] !== null && typeof evidence[0] === 'object' && Array.isArray(evidence[0].chunks)
        ? evidence[0]
        : undefined;
    }
    return typeof evidence === 'object' && Array.isArray(evidence.chunks) ? evidence : undefined;
  }

  /**
   * Ask the verdict source (the real Edge JEV Pass by default) and route.
   * @param {Memory} memory
   * @param {Object} [opts]
   * @param {boolean} [opts.expire]
   * @param {string} [opts.updateOf]
   * @param {string} [opts.question] Context for the verdict source.
   * @param {unknown} [opts.evidence] Evidence pack (or 1-element array of one) for the verdict source.
   * @returns {Promise<RouteDecision>}
   */
  async function routeWithVerdict(memory, opts = {}) {
    const verdictInput = await getVerdict(memory, {
      question: opts.question,
      evidence: normalizeEvidencePack(opts.evidence),
    });
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
      // Existence acknowledged: new → local. The JEV transition follows the
      // verdict that drove the route (Phase 5: all three edge verdicts are
      // real, stored states — flagged records must stay VISIBLY flagged,
      // not silently pass as accepted).
      if (record.lifecycle_status === 'new') stepLifecycle('local');
      if (record.jev_status === 'pending') {
        if (decision.verdict === 'accept_local') stepJev('accept_local');
        else if (decision.verdict === 'needs_more_evidence') stepJev('needs_more_evidence');
        else if (decision.verdict === 'flag_risk') stepJev('flag_risk');
      }
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
    const verdictInput = await getVerdict(revision);
    // Step 1: the UPDATE route stores the revision as a new version (this
    // decision consumes the verdict only as metadata).
    const updateDecision = routeMemory(revision, verdictInput, { updateOf: parent.memory_id });
    const updateApplied = await applyRoute(updateDecision);
    // Step 2 (Phase 5): the stored revision is then routed like any other
    // memory under its own verdict — a revised record is never left
    // un-routed with a stale 'pending' standing.
    const storedRevision = /** @type {Memory} */ (/** @type {unknown} */ (updateApplied.memory));
    const verdictDecision = routeMemory(storedRevision, verdictInput);
    const verdictApplied = await applyRoute(verdictDecision);
    return {
      ...verdictApplied,
      action: 'UPDATE',
      verdictRoute: verdictApplied.action,
      revisionOf: parent.memory_id,
    };
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
    captureAndRoute,
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
