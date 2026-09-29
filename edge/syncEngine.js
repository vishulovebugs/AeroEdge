'use strict';

/**
 * Sync Engine for AeroEdge (Phase 8) — the EDGE → CLOUD direction.
 *
 * On reconnection, local changes (field observations above all) reach the
 * cloud as a DELTA — only what changed since the last sync point, never a
 * full resync:
 *
 *   local memories → change detector (vs sync ledger) → eligibility filter
 *     (the Phase 4/5 Orchestrator table, re-read below) → delta package
 *     → caller-provided ingest (cloud/sync.js) → per-item SyncEvent
 *     → legal lifecycle transitions to `synced` on the edge
 *
 * The Orchestrator's verdict-driven table (Phase 4/5 — re-read, then
 * enforced here):
 *
 *   Edge JEV verdict      | sync-eligible? | why
 *   ----------------------+----------------+--------------------------
 *   accept_local < 0.7    | no (yet)       | routed KEEP_LOCAL, never
 *                         |                | marked sync_pending
 *   accept_local ≥ 0.7    | YES            | routed SYNC → sync_pending
 *   needs_more_evidence   | NEVER          | under-evidenced knowledge
 *                         |                | must not ride importance
 *                         |                | or anything else to the fleet
 *   flag_risk             | YES, tagged    | a human must SEE it (never
 *                         | high-visibility| auto-propagatable)
 *
 * Eligibility here is therefore **verdict-driven** (the Phase 4/5 table,
 * re-read below): `flag_risk` is sync-eligible and tagged high-visibility;
 * `accept_local` rides only when the Orchestrator routed it (`sync_pending`
 * by importance, or `used` — proven locally useful); `needs_more_evidence`
 * is NEVER eligible, with a second defense-in-depth veto keyed on the
 * stored verdict; unrouted/withdrawn/unevaluated memories are never
 * eligible from this engine alone.
 *
 * Change detection is CONTENT-based against a sync ledger: a memory is in
 * the delta iff its current content+revision fingerprint differs from the
 * last synced fingerprint (or it was never synced). Status-only changes
 * (new → local → used) produce NO false positives; a technician's revision
 * (`revision_of` version bump) is a real change and rides the next delta
 * as an `update`.
 *
 * Hard rules, in code:
 *   - Deltas are DETERMINISTIC (sorted by memory_id) so rebuilds compare.
 *   - Nothing here talks to the cloud directly: the caller injects the
 *     ingest function (cloud/sync.js in production, fakes in tests). The
 *     edge side cannot silently assume connectivity.
 *   - Cloud acceptance is all-or-nothing per item and acked via SyncEvents;
 *     only acked items transition to `synced` (legal path
 *     sync_pending → synced / used → sync_pending → synced, via
 *     shared/lifecycle.js). A memory the orchestrator never marked
 *     sync_pending is never force-advanced.
 *
 * No conflict detection/version comparison (Phase 9), no Cloud Pass
 * (Phase 10) — a synced memory in the cloud is edge-JEV'd technician
 * knowledge, fleet-truth only after the Cloud Pass validates it.
 */

import { createHash } from 'node:crypto';
import { transitionLifecycle } from '../shared/lifecycle.js';

/** Operations carried by SyncEvent records (shared/schemas.js contract). */
export const SYNC_OPERATIONS = Object.freeze(['create', 'update', 'expire']);

/**
 * @typedef {import('../shared/schemas.js').Memory} Memory
 */

/**
 * One item in a delta package.
 * @typedef {Object} DeltaItem
 * @property {'create'|'update'|'expire'} operation
 * @property {string} memoryId
 * @property {Memory} [memory] The full record (create/update; absent for expire).
 * @property {string} fingerprint Content+revision hash synced with this item.
 * @property {string} edgeJevVerdict The stored Edge Pass verdict driving eligibility.
 * @property {boolean} highVisibility True for flag_risk memories (a human must see them; never auto-propagatable).
 * @property {string[]} riskFlags Phase 5 risk tags (non-empty only for flag_risk).
 */

/**
 * A delta package: everything that changed AND is sync-eligible.
 * @typedef {Object} DeltaPackage
 * @property {'aeroedge-sync-delta-v1'} format
 * @property {string} deviceId Stable identity of the provisioning/syncing device.
 * @property {string} builtAt Build timestamp (informational; determinism comes from item order).
 * @property {DeltaItem[]} items Sorted by memoryId; eligibility-filtered; fingerprinted.
 * @property {number} scanned How many local memories the detector examined.
 * @property {number} changed How many memories changed since the last sync point (before eligibility filtering).
 */

/**
 * A sync ledger: remembers what was last synced (fingerprint per memory)
 * so the next delta is a true delta. The default implementation is
 * in-memory (per-process); a durable implementation is a later-phase
 * concern and only needs these five methods.
 * @typedef {Object} SyncLedger
 * @property {(memoryId: string) => Promise<string|null>} lastFingerprint
 * @property {(memoryId: string, fingerprint: string) => Promise<void>} recordSynced
 * @property {() => Promise<Record<string, string>>} allFingerprints
 */

/**
 * Compute the change fingerprint of a memory: content + identity lineage
 * only. Deliberately EXCLUDES statuses/timestamps so lifecycle bookkeeping
 * (new → local → used) is never a false positive, and INCLUDES revision_of
 * so a corrected version of the same memory_id lineage is a real change.
 * @param {Memory} memory
 * @returns {string}
 */
export function fingerprintMemory(memory) {
  if (memory === null || typeof memory !== 'object' || typeof memory.memory_id !== 'string') {
    throw new TypeError('fingerprintMemory requires a Memory record with a memory_id');
  }
  return createHash('sha256')
    .update(memory.memory_id)
    .update('\u0000')
    .update(memory.content)
    .update('\u0000')
    .update(memory.revision_of ?? '')
    .update('\u0000')
    .update(String(memory.version))
    .digest('hex');
}

/**
 * An in-memory sync ledger (default). Durable ledgers implement the same
 * five-method surface.
 * @returns {SyncLedger & { clear: () => void }}
 */
export function createInMemoryLedger() {
  /** @type {Map<string, string>} */
  const fingerprints = new Map();
  return {
    async lastFingerprint(memoryId) {
      return fingerprints.get(memoryId) ?? null;
    },
    async recordSynced(memoryId, fingerprint) {
      fingerprints.set(memoryId, fingerprint);
    },
    async allFingerprints() {
      return Object.fromEntries(fingerprints);
    },
    clear() {
      fingerprints.clear();
    },
  };
}

/**
 * The Phase 4/5 Orchestrator verdict table, re-read as a sync-eligibility
 * predicate (defense in depth — stored statuses drive it):
 *
 *   - manual / session_note: NEVER (reference material / working memory).
 *   - new / expired / conflict / resolved lifecycles: NEVER (unrouted,
 *     withdrawn, or Phase-10 territory).
 *   - needs_more_evidence: NEVER — the under-evidenced verdict vetoes even
 *     a drifted lifecycle (the record the Orchestrator kept local must not
 *     ride to the fleet on any technicality).
 *   - flag_risk: YES — still sync-eligible per the Orchestrator table so a
 *     human sees it; the delta tags it high-visibility (never
 *     auto-propagatable downstream).
 *   - accept_local: YES only when the Orchestrator actually routed it —
 *     `sync_pending` (importance ≥ threshold), `used` (proven locally
 *     useful), or `synced` (already fleet-shared; a CONTENT change to a
 *     synced memory is an offline edit that must re-sync as an update —
 *     surfaced by Phase 9's divergence detection). Plain `local`
 *     accept_local is below-threshold KEEP_LOCAL: not eligible from this
 *     engine alone.
 *   - pending (not yet evaluated): NEVER — no verdict, no sync.
 * @param {Memory} memory
 * @returns {boolean}
 */
export function isSyncEligible(memory) {
  if (memory === null || typeof memory !== 'object') return false;
  if (memory.memory_type !== 'field_observation') return false; // manual + session_note
  const lifecycle = memory.lifecycle_status;
  if (lifecycle === 'new' || lifecycle === 'expired' || lifecycle === 'conflict' || lifecycle === 'resolved') return false;
  // The stored Edge JEV verdict is the spine of the decision:
  if (memory.jev_status === 'needs_more_evidence') return false; // NEVER, per the table
  if (memory.jev_status === 'flag_risk') return true; // sync-eligible, tagged high-visibility
  if (memory.jev_status === 'accept_local') {
    return lifecycle === 'sync_pending' || lifecycle === 'used' || lifecycle === 'synced';
  }
  return false; // pending or anything unexpected: no verdict-driven eligibility
}

/**
 * Create the edge sync engine.
 *
 * @param {Object} options
 * @param {ReturnType<typeof import('./memoryStore.js').createMemoryStore>} memoryStore The EDGE memory store (source of local changes).
 * @param {SyncLedger} [ledger] Sync ledger (default: in-memory per process).
 * @param {string} [deviceId] Stable device identity for the delta package.
 * @returns {{
 *   deviceId: string,
 *   ledger: SyncLedger,
 *   detectChanges: () => Promise<{ changed: Memory[], scanned: number }>,
 *   buildDelta: () => Promise<DeltaPackage>,
 *   syncNow: (ingest: (pkg: DeltaPackage) => Promise<Array<{ memoryId: string, status: 'applied'|'rejected', reason?: string }>>, opts?: { expireIds?: string[] }) => Promise<{ synced: number, rejected: number, syncedIds: string[], rejectedIds: string[] }>,
 * }}
 */
export function createSyncEngine({ memoryStore, ledger = createInMemoryLedger(), deviceId = 'edge-device-local' }) {
  if (memoryStore === null || typeof memoryStore !== 'object' || typeof memoryStore.listMemories !== 'function') {
    throw new TypeError('createSyncEngine requires an edge memoryStore with listMemories()');
  }

  /**
   * Change detector: exactly the memories whose current fingerprint differs
   * from the ledger's last-synced fingerprint (including never-synced ones).
   * Expired memories surface as pending EXPIRE changes when their
   * fingerprint is already synced (the content didn't change — the intent
   * did), never as content deltas.
   * @returns {Promise<{ changed: Memory[], scanned: number }>}
   */
  async function detectChanges() {
    const all = await memoryStore.listMemories({ limit: 100000 });
    /** @type {Memory[]} */
    const changed = [];
    for (const memory of /** @type {Memory[]} */ (/** @type {unknown} */ (all))) {
      const last = await ledger.lastFingerprint(memory.memory_id);
      const current = fingerprintMemory(memory);
      if (last !== current) changed.push(memory);
    }
    return { changed, scanned: all.length };
  }

  /**
   * Build the delta package: changed AND sync-eligible memories, as
   * create (never synced) / update (synced before, changed since).
   * Deterministic: items sorted by memoryId.
   * @returns {Promise<DeltaPackage>}
   */
  async function buildDelta() {
    const { changed, scanned } = await detectChanges();

    /** @type {DeltaItem[]} */
    const items = [];
    for (const memory of changed) {
      if (!isSyncEligible(memory)) continue;
      const last = await ledger.lastFingerprint(memory.memory_id);
      const operation = last === null ? 'create' : 'update';
      items.push({
        operation,
        memoryId: memory.memory_id,
        memory,
        fingerprint: fingerprintMemory(memory),
        edgeJevVerdict: String(memory.jev_status),
        highVisibility: memory.jev_status === 'flag_risk',
        riskFlags: [],
      });
    }
    items.sort((a, b) => (a.memoryId < b.memoryId ? -1 : a.memoryId > b.memoryId ? 1 : 0));

    return {
      format: 'aeroedge-sync-delta-v1',
      deviceId,
      builtAt: new Date().toISOString(),
      items,
      scanned,
      changed: changed.length,
    };
  }

  /**
   * Run a sync round: build the delta, hand it to the injected cloud
   * ingest, then ack acked items into the ledger and advance their stored
   * lifecycle through the LEGAL path to `synced`. Rejected items are left
   * exactly as they were (they ride the next delta).
   *
   * @param {(pkg: DeltaPackage) => Promise<Array<{ memoryId: string, status: 'applied'|'rejected', reason?: string }>>} ingest Cloud-side ingest (cloud/sync.js in production).
   * @param {Object} [opts]
   * @param {string[]} [opts.expireIds] Local memory_ids to sync as EXPIRE (technician withdrew them).
   * @returns {Promise<{ synced: number, rejected: number, syncedIds: string[], rejectedIds: string[] }>}
   */
  async function syncNow(ingest, opts = {}) {
    if (typeof ingest !== 'function') {
      throw new TypeError('syncNow requires an ingest function (cloud/sync.js in production)');
    }
    const pkg = await buildDelta();

    // Optional expires: explicit technician withdrawals of already-synced
    // memories. Eligibility mirror of buildDelta, operation = 'expire'.
    for (const memoryId of opts.expireIds ?? []) {
      if (typeof memoryId !== 'string' || memoryId.trim() === '') {
        throw new TypeError('syncNow: expireIds must be non-empty memory_id strings');
      }
      const memory = await memoryStore.getMemory(memoryId);
      if (memory === null) continue; // unknown id: nothing to expire anywhere
      const last = await ledger.lastFingerprint(memory.memory_id);
      if (last === null) continue; // never synced: nothing cloud-side to expire
      pkg.items.push({
        operation: 'expire',
        memoryId: memory.memory_id,
        fingerprint: last,
        edgeJevVerdict: String(memory.jev_status),
        highVisibility: memory.jev_status === 'flag_risk',
        riskFlags: [],
      });
    }
    pkg.items.sort((a, b) => (a.memoryId < b.memoryId ? -1 : a.memoryId > b.memoryId ? 1 : 0));

    const results = await ingest(pkg);
    if (!Array.isArray(results)) {
      throw new TypeError('syncNow: ingest must return an array of per-item results');
    }

    /** @type {string[]} */
    const syncedIds = [];
    /** @type {string[]} */
    const rejectedIds = [];
    const byId = new Map(results.map((r) => [r.memoryId, r]));

    for (const item of pkg.items) {
      const result = byId.get(item.memoryId);
      if (!result || result.status !== 'applied') {
        rejectedIds.push(item.memoryId);
        continue;
      }
      // Ledger ack first (the delta is complete), then the LEGAL lifecycle
      // path to `synced` on the edge store — via shared/lifecycle.js, never
      // an ad hoc status write. The legal composition depends on where the
      // memory sits: sync_pending takes its single step; used composes
      // used → sync_pending → synced; flag_risk/accept_local memories that
      // stayed local (KEEP_LOCAL rows) advance local → sync_pending →
      // synced — a legal chain now that the cloud actually has the record.
      await ledger.recordSynced(item.memoryId, item.fingerprint);
      const record = await memoryStore.getMemory(item.memoryId);
      if (record !== null && record.memory_type === 'field_observation' && record.lifecycle_status !== 'synced') {
        /** @type {import('../shared/schemas.js').Memory} */
        let updated = /** @type {Memory} */ ({ ...record });
        if (updated.lifecycle_status !== 'sync_pending') {
          const from = updated.lifecycle_status;
          updated = { ...updated, lifecycle_status: transitionLifecycle(from, 'sync_pending') };
        }
        updated = { ...updated, lifecycle_status: transitionLifecycle('sync_pending', 'synced') };
        updated = { ...updated, sync_status: 'synced', updated_at: new Date().toISOString() };
        await memoryStore.putMemory(updated);
      }
      syncedIds.push(item.memoryId);
    }

    return { synced: syncedIds.length, rejected: rejectedIds.length, syncedIds, rejectedIds };
  }

  return { deviceId, ledger, detectChanges, buildDelta, syncNow };
}
