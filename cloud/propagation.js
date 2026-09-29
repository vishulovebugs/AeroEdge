'use strict';

/**
 * Fleet propagation gate + Cloud-Pass verdict application for AeroEdge
 * (Phase 10).
 *
 * THE GATE, in code: only `validated` items pass to fleet propagation.
 *   - validated          → propagate (allowed).
 *   - needs_human_review → BLOCKED; goes to the human-review queue.
 *   - rejected           → BLOCKED; stays a local historical record on the
 *                          originating device; never propagated.
 * Every propagation decision in the platform flows through
 * `canPropagate`/`routeVerdict` — no call site may trust the model's own
 * output without passing the gate first.
 *
 * Verdict application uses ONLY the legal jev transitions
 * (shared/lifecycle.js):
 *   - accept_local  → validated | rejected        (applied to the memory)
 *   - flag_risk     → validated | rejected        (applied to the memory)
 *   - pending→needs_human_review is NOT a legal memory transition, so a
 *     needs_human_review verdict is recorded in the REVIEW QUEUE (a
 *     dedicated collection), and a human decides later. The queue entry
 *     carries the full verdict record — nothing is lost by not forcing an
 *     illegal transition.
 *
 * CONFLICT RESOLUTION (JEV-assisted, human-confirmed):
 *   - recommendConflictResolution: Cloud JEV attaches jev_recommendation to
 *     the SAME open Conflict record (Phase 9 identity preserved — same
 *     conflict_id, no fields dropped). Status stays OPEN. JEV never
 *     auto-applies anything.
 *   - confirmConflictResolution: the separate explicit human action. Only a
 *     conflict that HAS a recommendation can be confirmed; only `open`
 *     conflicts can move; the winner ('edge'|'cloud') is recorded along
 *     with who confirmed. Status becomes `resolved` only here.
 */

import { transitionJev } from '../shared/lifecycle.js';
import { validateConflict, validateJEVVerdict } from '../shared/schemas.js';

/**
 * @typedef {import('../shared/schemas.js').Memory} Memory
 * @typedef {import('../shared/schemas.js').JEVVerdictValue} JEVVerdictValue
 */

/** The single propagation rule of the platform. */
export const PROPAGATION_RULE = 'only validated verdicts propagate to the fleet';

/**
 * The propagation gate. Pure, total, tested directly: only the `validated`
 * verdict returns true. Unknown verdicts fail closed.
 * @param {string} verdict
 * @returns {boolean}
 */
export function canPropagate(verdict) {
  return verdict === 'validated';
}

/**
 * The routing table for a Cloud Pass verdict.
 * @param {string} verdict
 * @returns {{ action: 'propagate'|'review'|'hold_local', reason: string }}
 */
export function routeVerdict(verdict) {
  if (verdict === 'validated') {
    return { action: 'propagate', reason: 'Cloud Pass validated: eligible for fleet propagation' };
  }
  if (verdict === 'needs_human_review') {
    return { action: 'review', reason: 'Cloud Pass needs human review: queued, never auto-propagated' };
  }
  if (verdict === 'rejected') {
    return { action: 'hold_local', reason: 'Cloud Pass rejected: local historical record only, never propagated' };
  }
  // Fail closed on anything unexpected.
  return { action: 'hold_local', reason: `unknown verdict "${String(verdict)}": fail closed, never propagated` };
}

/**
 * Create the propagation/queue surface.
 *
 * @param {Object} options
 * @param {ReturnType<typeof import('../edge/qdrant.js').createQdrantClient>} cloudMemories Cloud memory collection (validated memories are marked here; the fleet reads them).
 * @param {ReturnType<typeof import('../edge/qdrant.js').createQdrantClient>} cloudReview Human-review queue collection.
 * @param {ReturnType<typeof import('../edge/qdrant.js').createQdrantClient>} cloudConflicts Conflict collection (Phase 9 records; same objects carried through).
 * @param {ReturnType<typeof import('../edge/memoryStore.js').createMemoryStore>} [edgeMemoryStore] OPTIONAL edge store: when provided, validated/rejected verdicts are applied to the originating edge copy too (device-online scenario).
 * @returns {{
 *   reviewCollection: string,
 *   applyCloudVerdict: (verdictRecord: Record<string, unknown>, memory: Memory) => Promise<{ action: 'propagate'|'review'|'hold_local', transitions: string[], queueId?: string }>,
 *   queueReview: (verdictRecord: Record<string, unknown>, memory: Memory) => Promise<string>,
 *   listReviewQueue: (opts?: { limit?: number }) => Promise<Array<Record<string, unknown>>>,
 *   recommendConflictResolution: (conflictId: string, recommendation: { verdict: string, rationale: string }, jevRecord: Record<string, unknown>) => Promise<Record<string, unknown>>,
 *   confirmConflictResolution: (conflictId: string, { resolvedBy, winner, resolution }: { resolvedBy: string, winner: 'edge'|'cloud', resolution: string }) => Promise<Record<string, unknown>>,
 *   getConflict: (conflictId: string) => Promise<Record<string, unknown>|null>,
 * }}
 */
export function createFleetGate({ cloudMemories, cloudReview, cloudConflicts, edgeMemoryStore }) {
  for (const [name, client] of Object.entries({ cloudMemories, cloudReview, cloudConflicts })) {
    if (client === null || typeof client !== 'object' || typeof client.upsertPoints !== 'function') {
      throw new TypeError(`createFleetGate requires a ${name} Qdrant client`);
    }
  }

  /**
   * Apply a Cloud Pass verdict to a memory + the fleet stores. The gate is
   * consulted first; nothing happens without it.
   * @param {Record<string, unknown>} verdictRecord Contract-clean JEVVerdict (stage cloud).
   * @param {Memory} memory The evaluated memory (latest edge/cloud copy).
   */
  async function applyCloudVerdict(verdictRecord, memory) {
    const check = validateJEVVerdict(verdictRecord);
    if (!check.valid) {
      throw new Error(`applyCloudVerdict: verdict record failed contract validation: ${check.errors.join('; ')}`);
    }
    const { action, reason } = routeVerdict(String(verdictRecord.verdict));

    if (action === 'propagate') {
      // Legal jev transition on the memory: accept_local/flag_risk → validated.
      const from = memory.jev_status;
      const to = transitionJev(/** @type {any} */ (from), 'validated');
      const updated = {
        ...memory,
        jev_status: to,
        sync_status: 'synced',
        updated_at: new Date().toISOString(),
      };
      await cloudMemories.upsertPoints([
        { id: String(memory.memory_id), vector: [1], payload: updated },
      ]);
      if (edgeMemoryStore !== undefined) {
        await edgeMemoryStore.putMemory(updated);
      }
      return { action, transitions: [`jev ${from} → ${to}`] };
    }

    if (action === 'review') {
      const queueId = await queueReview(verdictRecord, memory);
      return { action, transitions: [], queueId };
    }

    // hold_local: the rejected verdict is a legal transition where the
    // memory sits (accept_local/flag_risk → rejected); the record stays on
    // the originating device as history and is never propagated.
    const from = memory.jev_status;
    const to = transitionJev(/** @type {any} */ (from), 'rejected');
    const updated = {
      ...memory,
      jev_status: to,
      updated_at: new Date().toISOString(),
    };
    if (edgeMemoryStore !== undefined) {
      await edgeMemoryStore.putMemory(updated);
    }
    return { action, transitions: [`jev ${from} → ${to}`] };
  }

  /**
   * Queue a needs_human_review verdict for a human decision. Queue entries
   * carry the full verdict record + the memory snapshot — a human has
   * everything needed to decide.
   * @param {Record<string, unknown>} verdictRecord
   * @param {Memory} memory
   * @returns {Promise<string>} queue entry id
   */
  async function queueReview(verdictRecord, memory) {
    const entryId = `rev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    /** @type {Record<string, unknown>} */
    const entry = {
      queue_id: entryId,
      memory_id: memory.memory_id,
      status: 'open',
      memory_snapshot: { ...memory },
      verdict: { ...verdictRecord },
      queued_at: new Date().toISOString(),
    };
    await cloudReview.upsertPoints([{ id: entryId, vector: [1], payload: entry }]);
    return entryId;
  }

  /**
   * The human-review queue, oldest-open first (deterministic).
   * @param {Object} [opts]
   * @param {number} [opts.limit]
   */
  async function listReviewQueue(opts = {}) {
    const { limit = 100 } = opts;
    const hits = await cloudReview.scrollWithFilter(
      { must: [{ key: 'status', match: { value: 'open' } }] },
      { limit }
    );
    return hits.map((h) => h.payload).sort((a, b) => String(a.queued_at ?? '').localeCompare(String(b.queued_at ?? '')));
  }

  /**
   * Attach the Cloud JEV recommendation to the SAME open Conflict record
   * (Phase 9 identity preserved). Status stays open; nothing is applied.
   * @param {string} conflictId
   * @param {{ verdict: string, rationale: string }} recommendation
   * @param {Record<string, unknown>} jevRecord The Cloud Pass verdict record backing the recommendation.
   */
  async function recommendConflictResolution(conflictId, recommendation, jevRecord) {
    const existing = await getConflict(conflictId);
    if (existing === null) {
      throw new Error(`recommendConflictResolution: conflict "${conflictId}" not found`);
    }
    if (existing.status !== 'open') {
      throw new Error(`recommendConflictResolution: conflict "${conflictId}" is ${existing.status}, not open`);
    }
    if (typeof recommendation.verdict !== 'string' || recommendation.verdict.trim() === '' ||
        typeof recommendation.rationale !== 'string' || recommendation.rationale.trim() === '') {
      throw new TypeError('recommendConflictResolution: recommendation needs non-empty verdict and rationale');
    }
    const verdictCheck = validateJEVVerdict(jevRecord);
    if (!verdictCheck.valid) {
      throw new Error(`recommendConflictResolution: backing JEV record invalid: ${verdictCheck.errors.join('; ')}`);
    }
    // SAME record, jev_recommendation populated, every other field kept.
    const updated = {
      ...existing,
      jev_recommendation: {
        verdict: recommendation.verdict,
        rationale: recommendation.rationale,
      },
      recommended_by_verdict: String(jevRecord.verdict_id),
      updated_at: new Date().toISOString(),
    };
    const check = validateConflict(updated);
    if (!check.valid) {
      throw new Error(`recommendConflictResolution: updated conflict failed contract validation: ${check.errors.join('; ')}`);
    }
    await cloudConflicts.upsertPoints([{ id: conflictId, vector: [1], payload: updated }]);
    return updated;
  }

  /**
   * THE separate, explicit human-confirmation action. JEV never calls this.
   * Only an open conflict WITH a recommendation can be confirmed; the winner
   * and the human identity are recorded; status becomes resolved ONLY here.
   * @param {string} conflictId
   * @param {Object} input
   * @param {string} input.resolvedBy Human identity.
   * @param {'edge'|'cloud'} input.winner Which side's content wins.
   * @param {string} input.resolution What was decided (non-empty).
   */
  async function confirmConflictResolution(conflictId, { resolvedBy, winner, resolution }) {
    const existing = await getConflict(conflictId);
    if (existing === null) {
      throw new Error(`confirmConflictResolution: conflict "${conflictId}" not found`);
    }
    if (existing.status !== 'open') {
      throw new Error(`confirmConflictResolution: conflict "${conflictId}" is already ${existing.status}`);
    }
    const rec = existing.jev_recommendation;
    if (
      rec === null || typeof rec !== 'object' ||
      typeof rec.verdict !== 'string' || rec.verdict.trim() === '' ||
      /Phase 9 version reconciliation/.test(String(rec.rationale ?? ''))
    ) {
      throw new Error(
        'confirmConflictResolution: conflict has no Cloud JEV recommendation yet — ' +
          'recommendConflictResolution must run before a human confirms (detection ≠ resolution)'
      );
    }
    if (typeof resolvedBy !== 'string' || resolvedBy.trim() === '' || typeof resolution !== 'string' || resolution.trim() === '') {
      throw new TypeError('confirmConflictResolution: "resolvedBy" and "resolution" must be non-empty strings');
    }
    if (winner !== 'edge' && winner !== 'cloud') {
      throw new TypeError('confirmConflictResolution: "winner" must be "edge" or "cloud"');
    }
    const updated = {
      ...existing,
      status: 'resolved',
      resolution: resolution.trim(),
      resolved_by: resolvedBy.trim(),
      resolution_winner: winner,
      resolved_at: new Date().toISOString(),
    };
    const check = validateConflict(updated);
    if (!check.valid) {
      throw new Error(`confirmConflictResolution: resolved conflict failed contract validation: ${check.errors.join('; ')}`);
    }
    await cloudConflicts.upsertPoints([{ id: conflictId, vector: [1], payload: updated }]);
    return updated;
  }

  /**
   * Fetch one conflict by id (the SAME record Phase 9 created).
   * @param {string} conflictId
   * @returns {Promise<Record<string, unknown>|null>}
   */
  async function getConflict(conflictId) {
    const hits = await cloudConflicts.scrollWithFilter(
      { must: [{ key: 'conflict_id', match: { value: conflictId } }] },
      { limit: 1 }
    );
    return hits.length > 0 ? hits[0].payload : null;
  }

  return {
    reviewCollection: cloudReview.collection,
    applyCloudVerdict,
    queueReview,
    listReviewQueue,
    recommendConflictResolution,
    confirmConflictResolution,
    getConflict,
  };
}
