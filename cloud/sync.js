'use strict';

/**
 * Cloud-side sync ingest for AeroEdge (Phase 8).
 *
 * Accepts edge delta packages (edge/syncEngine.js format
 * 'aeroedge-sync-delta-v1') on reconnection and applies them to the CLOUD:
 *
 *   - memories are stored in the CLOUD MEMORY collection
 *     (QDRANT_CLOUD_MEMORY_COLLECTION, default aeroedge_cloud_memories) —
 *     architecturally separate from enterprise documents (Phase 6) and from
 *     the edge instance. These are edge-JEV'd technician memories: usable
 *     fleet-wide context, NOT fleet truth — only the Cloud Pass (Phase 10)
 *     validates anything.
 *   - one SyncEvent record per item (create/update/expire) is persisted in
 *     the CLOUD SYNC collection (QDRANT_CLOUD_SYNC_COLLECTION) — the audit
 *     trail that makes sync inspectable.
 *
 * This endpoint TRUSTS THE EDGE'S JEV VERDICT (it arrives attached to each
 * memory, Phase 5) but does not judge: no Cloud Pass logic lives here. It
 * DOES verify structure: malformed items are rejected per-item (never
 * crash the batch, never fabricate a memory), and every applied item gets
 * a persisted SyncEvent. Expiry deletes the cloud copy.
 *
 * No conflict detection/version comparison (Phase 9), no Cloud Pass
 * (Phase 10), no propagation of flagged knowledge (later phases) — by
 * design.
 */

import { randomUUID } from 'node:crypto';
import { createQdrantClient } from '../edge/qdrant.js';
import { validateMemory, validateSyncEvent } from '../shared/schemas.js';
import { fingerprintMemory } from '../edge/syncEngine.js';

/** @typedef {import('./provisioning.js').ProvisioningTarget} ProvisioningTarget */

/**
 * Create the cloud sync ingest.
 *
 * @param {Object} options
 * @param {Readonly<Record<string, string>>} config Loaded shared config.
 * @param {ReturnType<typeof import('../edge/qdrant.js').createQdrantClient>} [cloudMemories] Injected CLOUD memory-collection client (tests); built from config otherwise.
 * @param {ReturnType<typeof import('../edge/qdrant.js').createQdrantClient>} [cloudSyncEvents] Injected CLOUD sync-collection client (tests); built from config otherwise.
 * @returns {{
 *   memoryCollection: string,
 *   syncCollection: string,
 *   ingestDelta: (pkg: unknown) => Promise<Array<{ memoryId: string, status: 'applied'|'rejected', reason?: string }>>,
 *   listSyncEvents: (opts?: { memoryId?: string, limit?: number }) => Promise<Array<Record<string, unknown>>>,
 * }}
 */
export function createCloudSyncIngest({ config, cloudMemories, cloudSyncEvents }) {
  if (config === null || typeof config !== 'object') {
    throw new TypeError('createCloudSyncIngest requires a loaded shared config');
  }
  const memoryCollection = config.QDRANT_CLOUD_MEMORY_COLLECTION ?? 'aeroedge_cloud_memories';
  const syncCollection = config.QDRANT_CLOUD_SYNC_COLLECTION ?? 'aeroedge_cloud_sync_events';
  const memoriesClient =
    cloudMemories ??
    createQdrantClient({
      // The CLOUD endpoint only — the ingest never touches the edge.
      baseUrl: config.QDRANT_CLOUD_URL,
      collection: memoryCollection,
    });
  const syncClient =
    cloudSyncEvents ??
    createQdrantClient({
      baseUrl: config.QDRANT_CLOUD_URL,
      collection: syncCollection,
    });

  /**
   * Persist one SyncEvent for an applied item (the audit trail). The event
   * is contract-validated BEFORE the write; a malformed event is an
   * internal error and fails the item loudly rather than writing garbage.
   * @param {{ operation: string, memoryId: string, deviceId: string, fingerprint: string }} item
   * @returns {Promise<void>}
   */
  async function recordSyncEvent(item) {
    /** @type {Record<string, unknown>} */
    const event = {
      event_id: `sev-${randomUUID()}`,
      memory_id: item.memoryId,
      operation: item.operation,
      source_device: item.deviceId,
      source_version: '1',
      target_version: item.fingerprint.slice(0, 12),
      timestamp: new Date().toISOString(),
      status: 'applied',
    };
    const check = validateSyncEvent(event);
    if (!check.valid) {
      throw new Error(`cloud sync: SyncEvent failed contract validation: ${check.errors.join('; ')}`);
    }
    await syncClient.upsertPoints([
      { id: String(event.event_id), vector: [1], payload: event },
    ]);
  }

  /**
   * Apply one delta item. Returns applied/rejected per item — a malformed
   * item is rejected with a reason, never crashes the batch.
   * @param {any} item
   * @param {string} deviceId
   * @returns {Promise<{ memoryId: string, status: 'applied'|'rejected', reason?: string }>}
   */
  async function applyItem(item, deviceId) {
    try {
      if (item === null || typeof item !== 'object') {
        return { memoryId: String(item?.memoryId ?? 'unknown'), status: 'rejected', reason: 'item must be an object' };
      }
      const memoryId = typeof item.memoryId === 'string' ? item.memoryId : '';
      if (memoryId === '') {
        return { memoryId: 'unknown', status: 'rejected', reason: 'missing memoryId' };
      }
      if (item.operation === 'expire') {
        // Cloud copy deleted by exact point id: cloud memory points are
        // stored with the memory_id as their stable identity, so the delete
        // is exact — never a content-filter guess.
        await memoriesClient.deleteByIds([memoryId]);
        await recordSyncEvent({
          operation: 'expire',
          memoryId,
          deviceId: typeof deviceId === 'string' ? deviceId : 'unknown',
          fingerprint: String(item.fingerprint ?? ''),
        });
        return { memoryId, status: 'applied' };
      }
      if (item.operation !== 'create' && item.operation !== 'update') {
        return { memoryId, status: 'rejected', reason: `unknown operation "${String(item.operation)}"` };
      }
      const memory = item.memory;
      if (memory === null || typeof memory !== 'object') {
        return { memoryId, status: 'rejected', reason: 'create/update requires a memory record' };
      }
      if (String(memory.memory_id) !== memoryId) {
        return { memoryId, status: 'rejected', reason: 'item.memoryId does not match memory.memory_id' };
      }
      // Contract gate: only a valid Memory lands in the cloud store.
      const check = validateMemory(memory);
      if (!check.valid) {
        return { memoryId, status: 'rejected', reason: `invalid memory record: ${check.errors.join('; ')}` };
      }
      await memoriesClient.upsertPoints([
        {
          // Stable point identity: the memory_id itself, so re-syncing an
          // update replaces the cloud copy instead of duplicating it.
          id: memoryId,
          vector: [1],
          payload: { ...memory },
        },
      ]);
      await recordSyncEvent({
        operation: item.operation,
        memoryId,
        deviceId: typeof deviceId === 'string' ? deviceId : 'unknown',
        fingerprint: String(item.fingerprint ?? ''),
      });
      return { memoryId, status: 'applied' };
    } catch (err) {
      return {
        memoryId: String(/** @type {any} */ (item)?.memoryId ?? 'unknown'),
        status: 'rejected',
        reason: `ingest error: ${/** @type {Error} */ (err).message}`,
      };
    }
  }

  /**
   * The sync API endpoint (function form): accept a delta package, apply
   * per item, report per-item results for the edge to ack.
   * @param {unknown} pkg
   * @returns {Promise<Array<{ memoryId: string, status: 'applied'|'rejected', reason?: string }>>}
   */
  async function ingestDelta(pkg) {
    if (pkg === null || typeof pkg !== 'object') {
      throw new TypeError('ingestDelta requires a delta package object');
    }
    if (pkg.format !== 'aeroedge-sync-delta-v1') {
      throw new TypeError(`ingestDelta: unknown package format "${String(/** @type {any} */ (pkg).format)}"`);
    }
    if (!Array.isArray(pkg.items)) {
      throw new TypeError('ingestDelta: package items must be an array');
    }
    const deviceId = typeof pkg.deviceId === 'string' ? pkg.deviceId : 'unknown';
    /** @type {Array<{ memoryId: string, status: 'applied'|'rejected', reason?: string }>} */
    const results = [];
    for (const item of pkg.items) {
      results.push(await applyItem(item, deviceId));
    }
    return results;
  }

  /**
   * Read the sync audit trail.
   * @param {Object} [opts]
   * @param {string} [opts.memoryId]
   * @param {number} [opts.limit]
   */
  async function listSyncEvents(opts = {}) {
    const { memoryId, limit = 100 } = opts;
    /** @type {import('../edge/qdrant.js').MatchClause[]} */
    const must = [];
    if (memoryId !== undefined) must.push({ key: 'memory_id', match: { value: memoryId } });
    const hits = await syncClient.scrollWithFilter(must.length > 0 ? { must } : {}, { limit });
    return hits.map((h) => h.payload).sort((a, b) => String(b.timestamp ?? '').localeCompare(String(a.timestamp ?? '')));
  }

  return { memoryCollection, syncCollection, ingestDelta, listSyncEvents };
}
