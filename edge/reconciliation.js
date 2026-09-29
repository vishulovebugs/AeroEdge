'use strict';

/**
 * Version reconciliation for AeroEdge (Phase 9).
 *
 * Sits BETWEEN Phase 8's delta build and the cloud ingest: each delta item
 * is classified (shared/versioning.js) against the LIVE cloud copy and the
 * Phase 8 ledger's last-synced fingerprint, then handled by case — never
 * defaulted to last-write-wins:
 *
 *   CLOUD_NEWER → the edge ADOPTS the cloud copy (legal lifecycle
 *                 composition; the edge never overwrites cloud).
 *   EDGE_NEW    → uploads exactly as Phase 8 would (the observation is not
 *                 resolved or promoted — it routes through Cloud JEV in
 *                 Phase 10).
 *   DIVERGED    → the item is WITHHELD from upload (the cloud copy is not
 *                 overwritten) and an OPEN Conflict record is persisted
 *                 (contract-validated, shared/schemas.js) in
 *                 QDRANT_CLOUD_CONFLICT_COLLECTION. Nothing is resolved
 *                 here — resolution is JEV-recommended and human-confirmed
 *                 in Phase 10.
 *   IDENTICAL   → deduplicate: drop the item, ack the sync point.
 *
 * Guarantees:
 *   - The edge NEVER overwrites the cloud in any case (withhold + record,
 *     not stomp), and never lets the cloud's newer content be lost.
 *   - Conflicting items are NOT acked, so they keep re-classifying as
 *     DIVERGED on every round until Phase 10 resolution changes state —
 *     a conflict never silently vanishes.
 *   - The Conflict record shape is the Phase 0 contract (validateConflict:
 *     open/resolved, edge_version, cloud_version, jev_recommendation).
 *     Detection only — no resolution logic.
 */

import { randomUUID } from 'node:crypto';
import { classifyVersions } from '../shared/versioning.js';
import { validateConflict, validateMemory } from '../shared/schemas.js';
import { transitionLifecycle } from '../shared/lifecycle.js';
import { fingerprintMemory } from './syncEngine.js';

/** Re-exported for callers that want one import surface. */
export { VERSION_CASES } from '../shared/versioning.js';

/**
 * @typedef {import('../shared/schemas.js').Memory} Memory
 * @typedef {import('./syncEngine.js').DeltaItem} DeltaItem
 * @typedef {import('./syncEngine.js').DeltaPackage} DeltaPackage
 * @typedef {import('../shared/versioning.js').VersionCase} VersionCase
 */

/**
 * Create the reconciler.
 *
 * @param {Object} options
 * @param {ReturnType<typeof import('./memoryStore.js').createMemoryStore>} memoryStore The EDGE memory store.
 * @param {ReturnType<typeof import('./syncEngine.js').createInMemoryLedger>} ledger The Phase 8 sync ledger (source of base fingerprints).
 * @param {ReturnType<typeof import('./qdrant.js').createQdrantClient>} cloudMemories Qdrant client bound to the CLOUD memory collection (reads the live cloud copy).
 * @param {ReturnType<typeof import('./qdrant.js').createQdrantClient>} cloudConflicts Qdrant client bound to the CLOUD CONFLICTS collection (open Conflict records).
 * @returns {{
 *   conflictCollection: string,
 *   classifyDelta: (pkg: DeltaPackage) => Promise<{ items: Array<{ item: DeltaItem, kase: VersionCase, reason: string, cloudRecord: Memory|null }>, counts: Record<VersionCase|'none', number> }>,
 *   reconcileDelta: (pkg: DeltaPackage, ingest: (pkg: DeltaPackage) => Promise<Array<{ memoryId: string, status: 'applied'|'rejected', reason?: string }>>, opts?: { ackFingerprint?: (memoryId: string, fingerprint: string) => Promise<void> }) => Promise<{ uploaded: number, adopted: number, conflicts: number, deduped: number, conflictIds: string[] }>,
 *   listOpenConflicts: (opts?: { memoryId?: string, limit?: number }) => Promise<Array<Record<string, unknown>>>,
 * }}
 */
export function createReconciler({ memoryStore, ledger, cloudMemories, cloudConflicts }) {
  if (memoryStore === null || typeof memoryStore !== 'object' || typeof memoryStore.getMemory !== 'function') {
    throw new TypeError('createReconciler requires an edge memoryStore with getMemory()');
  }
  if (ledger === null || typeof ledger !== 'object' || typeof ledger.lastFingerprint !== 'function') {
    throw new TypeError('createReconciler requires the Phase 8 sync ledger (base fingerprints)');
  }
  if (cloudMemories === null || typeof cloudMemories !== 'object' || typeof cloudMemories.scrollWithFilter !== 'function') {
    throw new TypeError('createReconciler requires a cloudMemories Qdrant client (read side)');
  }
  if (cloudConflicts === null || typeof cloudConflicts !== 'object' || typeof cloudConflicts.upsertPoints !== 'function') {
    throw new TypeError('createReconciler requires a cloudConflicts Qdrant client (open Conflict records)');
  }

  /**
   * Fetch the LIVE cloud copy of a memory (cloud memory points are stored
   * with memory_id as their stable point identity — Phase 8).
   * @param {string} memoryId
   * @returns {Promise<Memory|null>}
   */
  async function getCloudCopy(memoryId) {
    const hits = await cloudMemories.scrollWithFilter(
      { must: [{ key: 'memory_id', match: { value: memoryId } }] },
      { limit: 1 }
    );
    return hits.length > 0 ? /** @type {Memory} */ (/** @type {unknown} */ (hits[0].payload)) : null;
  }

  /** Last-synced fingerprint, normalized to '' (never null) for the classifier. */
  async function baseFingerprintOf(memoryId) {
    return (await ledger.lastFingerprint(memoryId)) ?? '';
  }

  /**
   * Advance an edge record to `synced` through the LEGAL lifecycle chain
   * (shared/lifecycle.js) — the same composition Phase 8's syncNow uses;
   * safe to run twice (already-synced records are skipped).
   * @param {string} memoryId
   */
  async function advanceToSynced(memoryId) {
    const record = await memoryStore.getMemory(memoryId);
    if (
      record === null ||
      record.memory_type !== 'field_observation' ||
      record.lifecycle_status === 'synced'
    ) {
      return;
    }
    /** @type {Memory} */
    let updated = { ...record };
    if (updated.lifecycle_status !== 'sync_pending') {
      updated = { ...updated, lifecycle_status: transitionLifecycle(updated.lifecycle_status, 'sync_pending') };
    }
    updated = { ...updated, lifecycle_status: transitionLifecycle('sync_pending', 'synced') };
    updated = { ...updated, sync_status: 'synced', updated_at: new Date().toISOString() };
    await memoryStore.putMemory(updated);
  }

  /**
   * Persist an OPEN Conflict record (Phase 0 contract, validateConflict).
   * @param {Object} input
   * @param {DeltaItem} input.item
   * @param {Memory|null} input.cloudRecord
   * @param {string} input.edgeFingerprint
   * @param {string} input.cloudFingerprint
   * @returns {Promise<string>} conflict_id
   */
  async function recordConflict({ item, cloudRecord, edgeFingerprint, cloudFingerprint }) {
    /** @type {Record<string, unknown>} */
    const conflict = {
      conflict_id: `cfl-${randomUUID()}`,
      memory_id: item.memoryId,
      edge_version: edgeFingerprint.slice(0, 12),
      cloud_version: cloudFingerprint.slice(0, 12),
      conflict_type: 'version_divergence',
      // JEV RECOMMENDATION PLACEHOLDER (Phase 10 computes the real one).
      // The Phase 0 schema requires the object; this states honestly that
      // no recommendation exists yet — detection, not resolution.
      jev_recommendation: {
        verdict: 'needs_human_review',
        rationale:
          'Detected by Phase 9 version reconciliation: edge and cloud hold divergent versions of the same ' +
          'knowledge. No JEV recommendation has been computed yet — resolution (JEV-recommended, ' +
          'human-confirmed) is Phase 10.',
      },
      status: 'open',
      resolution: '',
      resolved_by: '',
    };
    const check = validateConflict(conflict);
    if (!check.valid) {
      throw new Error(`reconciliation: Conflict record failed contract validation: ${check.errors.join('; ')}`);
    }
    await cloudConflicts.upsertPoints([
      { id: String(conflict.conflict_id), vector: [1], payload: conflict },
    ]);
    return String(conflict.conflict_id);
  }

  /**
   * Classify every delta item against the live cloud + ledger state.
   * @param {DeltaPackage} pkg
   */
  async function classifyDelta(pkg) {
    if (pkg === null || typeof pkg !== 'object' || !Array.isArray(pkg.items)) {
      throw new TypeError('classifyDelta requires a Phase 8 delta package');
    }
    /** @type {Array<{ item: DeltaItem, kase: VersionCase, reason: string, cloudRecord: Memory|null }>} */
    const items = [];
    /** @type {Record<VersionCase|'none', number>} */
    const counts = { CLOUD_NEWER: 0, EDGE_NEW: 0, DIVERGED: 0, IDENTICAL: 0, none: 0 };
    for (const item of pkg.items) {
      const baseFingerprint = await baseFingerprintOf(item.memoryId);
      const edgeRecord =
        item.operation === 'expire'
          ? null
          : item.memory ?? (await memoryStore.getMemory(item.memoryId));
      const cloudRecord = await getCloudCopy(item.memoryId);
      const edgeFingerprint = edgeRecord ? fingerprintMemory(edgeRecord) : item.fingerprint;
      const cloudFingerprint = cloudRecord ? fingerprintMemory(cloudRecord) : '';
      const { kase, reason } = classifyVersions({ edgeFingerprint, cloudFingerprint, baseFingerprint });
      counts[kase] += 1;
      items.push({ item, kase, reason, cloudRecord });
    }
    return { items, counts };
  }

  /**
   * The Phase 8 ingest wrapper: classify first, then route by case. ONLY
   * EDGE_NEW items (and technician expires) reach the real cloud ingest.
   * CLOUD_NEWER is adopted edge-side; DIVERGED items are withheld and
   * recorded; IDENTICAL items are deduped and acked.
   * @param {DeltaPackage} pkg
   * @param {(pkg: DeltaPackage) => Promise<Array<{ memoryId: string, status: 'applied'|'rejected', reason?: string }>>} ingest
   * @param {Object} [opts]
   * @param {(memoryId: string, fingerprint: string) => Promise<void>} [opts.ackFingerprint] Ledger ack hook (defaults to the engine's ledger).
   * @returns {Promise<{ uploaded: number, adopted: number, conflicts: number, deduped: number, conflictIds: string[] }>}
   */
  async function reconcileDelta(pkg, ingest, opts = {}) {
    if (typeof ingest !== 'function') {
      throw new TypeError('reconcileDelta requires the cloud ingest function');
    }
    const ack = opts.ackFingerprint ?? ((memoryId, fingerprint) => ledger.recordSynced(memoryId, fingerprint));
    const { items } = await classifyDelta(pkg);

    /** @type {DeltaPackage} */
    const uploadPkg = {
      ...pkg,
      items: items
        .filter(({ kase, item }) => kase === 'EDGE_NEW' || item.operation === 'expire')
        .map(({ item }) => item),
    };

    /** @type {string[]} */
    const conflictIds = [];
    let adopted = 0;
    let deduped = 0;

    for (const { item, kase, cloudRecord } of items) {
      if (kase === 'DIVERGED') {
        // THE Phase 9 acceptance behavior: detected, recorded, and withheld
        // — never silently overwritten in either direction. No ack: the
        // item keeps classifying as DIVERGED until Phase 10 resolves it.
        const edgeRecord = item.memory ?? (await memoryStore.getMemory(item.memoryId));
        conflictIds.push(
          await recordConflict({
            item,
            cloudRecord,
            edgeFingerprint: edgeRecord ? fingerprintMemory(edgeRecord) : item.fingerprint,
            cloudFingerprint: cloudRecord ? fingerprintMemory(cloudRecord) : '',
          })
        );
        continue;
      }
      if (kase === 'CLOUD_NEWER') {
        // Adopt the cloud copy edge-side via legal transitions. The edge
        // never overwrites the cloud — it brings itself up to date.
        if (cloudRecord !== null) {
          const check = validateMemory(cloudRecord);
          if (!check.valid) {
            throw new Error(`reconciliation: cloud record failed validation: ${check.errors.join('; ')}`);
          }
          const local = await memoryStore.getMemory(item.memoryId);
          if (local === null) {
            // The edge never had it (or expired it): store the cloud copy.
            await memoryStore.putMemory(cloudRecord);
          } else {
            /** @type {Memory} */
            let updated = { ...cloudRecord };
            // Legal composition: whatever the local state, walk to synced.
            if (updated.lifecycle_status !== 'sync_pending' && updated.lifecycle_status !== 'synced') {
              updated = { ...updated, lifecycle_status: transitionLifecycle(updated.lifecycle_status, 'sync_pending') };
            }
            if (updated.lifecycle_status !== 'synced') {
              updated = { ...updated, lifecycle_status: transitionLifecycle('sync_pending', 'synced') };
            }
            updated = { ...updated, sync_status: 'synced', updated_at: new Date().toISOString() };
            await memoryStore.putMemory(updated);
          }
          await ack(item.memoryId, fingerprintMemory(cloudRecord));
          adopted += 1;
        }
        continue;
      }
      if (kase === 'IDENTICAL') {
        deduped += 1;
        await ack(item.memoryId, item.fingerprint);
        continue;
      }
      // EDGE_NEW and expires fall through to the real ingest below.
    }

    if (uploadPkg.items.length > 0) {
      const results = await ingest(uploadPkg);
      const byId = new Map(results.map((r) => [r.memoryId, r]));
      // Ack only items the cloud actually applied (the Phase 8 contract),
      // then advance the edge record through the legal chain to synced.
      for (const { item, kase } of items) {
        if (kase !== 'EDGE_NEW' && item.operation !== 'expire') continue;
        const result = byId.get(item.memoryId);
        if (result?.status === 'applied') {
          await ack(item.memoryId, item.fingerprint);
          if (item.operation !== 'expire') {
            await advanceToSynced(item.memoryId);
          }
        }
      }
    }
    return {
      uploaded: uploadPkg.items.length,
      adopted,
      conflicts: conflictIds.length,
      deduped,
      conflictIds,
    };
  }

  /**
   * Open conflicts, deterministic order.
   * @param {Object} [opts]
   * @param {string} [opts.memoryId]
   * @param {number} [opts.limit]
   */
  async function listOpenConflicts(opts = {}) {
    const { memoryId, limit = 100 } = opts;
    /** @type {import('./qdrant.js').MatchClause[]} */
    const must = [{ key: 'status', match: { value: 'open' } }];
    if (memoryId !== undefined) must.push({ key: 'memory_id', match: { value: memoryId } });
    const hits = await cloudConflicts.scrollWithFilter({ must }, { limit });
    return hits
      .map((h) => h.payload)
      .sort((a, b) => String(a.conflict_id ?? '').localeCompare(String(b.conflict_id ?? '')));
  }

  return {
    conflictCollection: cloudConflicts.collection,
    classifyDelta,
    reconcileDelta,
    listOpenConflicts,
  };
}
