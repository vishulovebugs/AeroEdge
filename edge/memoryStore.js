'use strict';

/**
 * Memory persistence for AeroEdge (Phase 4).
 *
 * Stores Memory records (shared/schemas.js) in a DEDICATED Edge collection
 * (QDRANT_EDGE_MEMORY_COLLECTION, default aeroedge_edge_memories) that is
 * architecturally separate from the authoritative document collection used
 * by hybrid retrieval. Separation is the point: technician-generated
 * knowledge must never silently blend into reference truth.
 *
 * Storage notes (deliberate, documented):
 *   - Every write passes validateMemory (Phase 0 contract gate) BEFORE any
 *     Qdrant call — an invalid memory never reaches storage.
 *   - Access is payload-only (filtered scroll): the memory store performs NO
 *     vector search. Qdrant requires a vectors config at collection creation,
 *     so points carry a 1-dim placeholder vector that nothing ever searches.
 *   - Qdrant point ids must be uint/UUID while Memory.memory_id is a domain
 *     id, so points get a UUID and the memory_id lives in the payload.
 *   - Lifecycle statuses are STORED on the record; this module neither
 *     infers nor mutates them — edge/orchestrator.js owns transitions via
 *     shared/lifecycle.js.
 *
 * Fully offline: talks only to the Edge Qdrant URL.
 */

import { randomUUID } from 'node:crypto';
import { createQdrantClient } from './qdrant.js';
import { validateMemory } from '../shared/schemas.js';

/** Placeholder vector size (this collection is never vector-searched). */
const MEMORY_VECTOR_SIZE = 1;

/**
 * @param {Object} options
 * @param {Readonly<Record<string, string>>} config Loaded shared config.
 * @param {ReturnType<typeof createQdrantClient>} [qdrant] Injected client (tests).
 * @returns {{
 *   collection: string,
 *   ensureStore: () => Promise<void>,
 *   putMemory: (record: Record<string, unknown>) => Promise<Record<string, unknown>>,
 *   getMemory: (memoryId: string) => Promise<Record<string, unknown>|null>,
 *   listMemories: (opts?: { memoryType?: string, lifecycleStatus?: string, jevStatus?: string, assetId?: string, limit?: number }) => Promise<Record<string, unknown>[]>,
 *   deleteMemory: (memoryId: string) => Promise<boolean>,
 * }}
 */
export function createMemoryStore({ config, qdrant }) {
  const collection = config.QDRANT_EDGE_MEMORY_COLLECTION ?? 'aeroedge_edge_memories';
  const client =
    qdrant ??
    createQdrantClient({
      baseUrl: config.QDRANT_EDGE_URL,
      collection,
    });

  /** Create the dedicated memories collection if missing (idempotent). */
  async function ensureStore() {
    await client.ensureCollection(MEMORY_VECTOR_SIZE);
  }

  /**
   * Validate and persist one Memory record (insert or full replacement —
   * identity is memory_id; lifecycle transitions are the orchestrator's job).
   * @param {Record<string, unknown>} record Must satisfy validateMemory.
   * @returns {Promise<Record<string, unknown>>} The stored record.
   */
  async function putMemory(record) {
    const verdict = validateMemory(record);
    if (!verdict.valid) {
      throw new Error(`Memory failed validation before storage: ${verdict.errors.join('; ')}`);
    }
    await ensureStore();
    // Replace any earlier point carrying this memory_id (put is idempotent).
    const existing = await client.scrollWithFilter(
      { must: [{ key: 'memory_id', match: { value: record.memory_id } }] },
      { limit: 1000 }
    );
    if (existing.length > 0) {
      await client.deleteByIds(existing.map((p) => p.id));
    }
    await client.upsertPoints([
      {
        id: randomUUID(),
        vector: new Array(MEMORY_VECTOR_SIZE).fill(0),
        payload: { ...record },
      },
    ]);
    return record;
  }

  /**
   * Fetch one memory by domain id, or null.
   * @param {string} memoryId
   * @returns {Promise<Record<string, unknown>|null>}
   */
  async function getMemory(memoryId) {
    if (typeof memoryId !== 'string' || memoryId.trim() === '') {
      throw new TypeError('getMemory requires a non-empty memoryId');
    }
    const hits = await client.scrollWithFilter(
      { must: [{ key: 'memory_id', match: { value: memoryId } }] },
      { limit: 1 }
    );
    return hits.length > 0 ? hits[0].payload : null;
  }

  /**
   * List memories by stored (never inferred) status fields.
   * @param {Object} [opts]
   * @param {string} [opts.memoryType]
   * @param {string} [opts.lifecycleStatus]
   * @param {string} [opts.jevStatus]
   * @param {string} [opts.assetId]
   * @param {number} [opts.limit]
   * @returns {Promise<Record<string, unknown>[]>} Newest-updated first.
   */
  async function listMemories(opts = {}) {
    const { memoryType, lifecycleStatus, jevStatus, assetId, limit = 50 } = opts;
    /** @type {Array<{ key: string, match: { value: string } }>} */
    const must = [];
    if (memoryType !== undefined) must.push({ key: 'memory_type', match: { value: memoryType } });
    if (lifecycleStatus !== undefined) must.push({ key: 'lifecycle_status', match: { value: lifecycleStatus } });
    if (jevStatus !== undefined) must.push({ key: 'jev_status', match: { value: jevStatus } });
    if (assetId !== undefined) must.push({ key: 'asset_id', match: { value: assetId } });
    const hits = await client.scrollWithFilter(must.length > 0 ? { must } : {}, { limit });
    return hits
      .map((h) => h.payload)
      .sort((a, b) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')));
  }

  /**
   * Hard-delete one memory by domain id. Lifecycle expiry is normally a
   * STATUS change (orchestrator), not a deletion — this exists for the
   * UPDATE path's history policy and explicit erasure requests.
   * @param {string} memoryId
   * @returns {Promise<boolean>} true when a record was deleted.
   */
  async function deleteMemory(memoryId) {
    const existing = await client.scrollWithFilter(
      { must: [{ key: 'memory_id', match: { value: memoryId } }] },
      { limit: 1000 }
    );
    if (existing.length === 0) return false;
    await client.deleteByIds(existing.map((p) => p.id));
    return true;
  }

  return { collection, ensureStore, putMemory, getMemory, listMemories, deleteMemory };
}
