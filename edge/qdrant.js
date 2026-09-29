'use strict';

/**
 * Minimal Qdrant REST client for the Edge instance.
 *
 * Only the operations the retrieval pipeline needs: ensure a collection
 * exists (with optional payload indexes), upsert points, vector search
 * (plain and filter-constrained), filtered scroll (no vectors — the
 * keyword/metadata leg of hybrid retrieval), and delete-by-document-filter.
 * The Edge instance is architecturally separate from the Cloud instance —
 * this module only ever talks to the URL in QDRANT_EDGE_URL; nothing here
 * knows the cloud endpoint exists.
 *
 * `fetch` is injectable for unit tests; see edge/ollama.js for the same
 * offline-path auditability argument.
 */

/**
 * @typedef {Object} QdrantClientOptions
 * @property {string} baseUrl Edge Qdrant base URL, e.g. http://localhost:6333.
 * @property {string} collection Edge collection name.
 * @property {typeof fetch} [fetchImpl] Injectable fetch (defaults to globalThis.fetch).
 */

/** @typedef {{ id: string, vector: number[], payload: Record<string, unknown> }} QdrantPoint */

/** Error thrown for any Qdrant communication or response-shape problem. */
export class QdrantError extends Error {
  /**
   * @param {string} message
   * @param {number} [status]
   */
  constructor(message, status) {
    super(message);
    this.name = 'QdrantError';
    this.status = status;
  }
}

/**
 * A single Qdrant payload-index request.
 * @typedef {Object} PayloadIndexSpec
 * @property {string} fieldName Payload key to index.
 * @property {string} [fieldType] Qdrant payload schema type (e.g. "keyword", "integer", "datetime").
 */

/**
 * A Qdrant condition clause (subset used by AeroEdge). Nested filters are
 * not needed at this phase.
 * @typedef {Object} MatchClause
 * @property {string} key Payload key to match.
 * @property {{ value?: unknown, any?: unknown[], text?: string }} [match]
 */

/**
 * A Qdrant filter object (subset used by AeroEdge).
 * @typedef {Object} QdrantFilter
 * @property {MatchClause[]} [must]
 * @property {MatchClause[]} [should]
 * @property {MatchClause[]} [must_not]
 */

/**
 * @param {QdrantClientOptions} options
 */
export function createQdrantClient({ baseUrl, collection, fetchImpl = globalThis.fetch }) {
  const base = baseUrl.replace(/\/+$/, '');

  /**
   * @param {string} method
   * @param {string} path
   * @param {unknown} [body]
   * @returns {Promise<any>}
   */
  async function request(method, path, body) {
    /** @type {Response} */
    let res;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new QdrantError(
        `Cannot reach Qdrant at ${base}${path}: ${/** @type {Error} */ (err).message}`
      );
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new QdrantError(
        `Qdrant ${method} ${path} failed (HTTP ${res.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`,
        res.status
      );
    }
    try {
      return await res.json();
    } catch (err) {
      throw new QdrantError(`Qdrant ${path} returned invalid JSON: ${/** @type {Error} */ (err).message}`);
    }
  }

  return {
    /** @type {string} */
    collection,    /**
     * Create the collection with the given vector size if it does not exist.
     * @param {number} vectorSize
     * @param {PayloadIndexSpec[]} [payloadIndexes] Payload fields to index (Phase 2: keyword match filters).
     * @returns {Promise<void>}
     */
    async ensureCollection(vectorSize, payloadIndexes = []) {
      if (!Number.isInteger(vectorSize) || vectorSize <= 0) {
        throw new QdrantError(`ensureCollection requires a positive integer vector size, got ${vectorSize}`);
      }
      const existing = await request('GET', `/collections/${collection}`);
      if (existing?.result) return; // exists (even while shutting down: warn-and-proceed is fine for Edge)

      await request('PUT', `/collections/${collection}`, {
        vectors: { size: vectorSize, distance: 'Cosine' },
      });
      for (const spec of payloadIndexes) {
        await request('PUT', `/collections/${collection}/index/${spec.fieldName}`, {
          field_schema: spec.fieldType ?? 'keyword',
        });
      }
    },

    /**
     * Upsert points in one batch.
     * @param {QdrantPoint[]} points
     * @returns {Promise<void>}
     */
    async upsertPoints(points) {
      if (!Array.isArray(points) || points.length === 0) return;
      await request('PUT', `/collections/${collection}/points`, { points });
    },

    /**
     * Vector similarity search (unconstrained).
     * @param {number[]} queryVector
     * @param {Object} [opts]
     * @param {number} [opts.limit]
     * @returns {Promise<Array<{ id: string, score: number, payload: Record<string, unknown> }>>}
     */
    async search(queryVector, { limit = 4 } = {}) {
      const data = await request('POST', `/collections/${collection}/points/search`, {
        vector: queryVector,
        limit,
        with_payload: true,
      });
      return parseHits(data, collection);
    },

    /**
     * Vector similarity search, optionally constrained by a payload filter.
     * @param {number[]} queryVector
     * @param {Object} [opts]
     * @param {number} [opts.limit]
     * @param {QdrantFilter} [opts.filter]
     * @returns {Promise<Array<{ id: string, score: number, payload: Record<string, unknown> }>>}
     */
    async searchWhere(queryVector, { limit = 4, filter } = {}) {
      if (!filter || Object.keys(filter).length === 0) {
        return this.search(queryVector, { limit });
      }
      const data = await request('POST', `/collections/${collection}/points/search`, {
        vector: queryVector,
        limit,
        with_payload: true,
        filter,
      });
      return parseHits(data, collection);
    },

    /**
     * Filtered scroll: fetch points matching a payload filter WITHOUT any
     * vector or scoring (keyword/metadata-only leg of hybrid retrieval;
     * also used by the Phase 4 memory store, which stores NO vectors).
     * Phase 7: pass withVector to also receive each point's stored vector
     * (edge provisioning transfers exact embeddings, never re-embeds).
     * @param {QdrantFilter} filter
     * @param {Object} [opts]
     * @param {number} [opts.limit]
     * @param {boolean} [opts.withVector] Also return stored vectors (edge provisioning, Phase 7).
     * @returns {Promise<Array<{ id: string, score: number, payload: Record<string, unknown>, vector?: number[] }>>}
     */
    async scrollWithFilter(filter, { limit = 50, withVector = false } = {}) {
      const data = await request('POST', `/collections/${collection}/points/scroll`, {
        filter,
        limit,
        with_payload: true,
        with_vector: withVector,
      });
      const result = /** @type {{ points?: unknown }} */ (data).result;
      if (!Array.isArray(result)) {
        throw new QdrantError(`Qdrant scroll on "${collection}" returned no points array`);
      }
      return result.map((point) => {
        const p = point ?? {};
        if (typeof p.id !== 'string' || typeof p.payload !== 'object' || p.payload === null) {
          throw new QdrantError(`Qdrant scroll on "${collection}" returned a malformed point`);
        }
        const hit = /** @type {{ id: string, score: number, payload: Record<string, unknown>, vector?: number[] }} */ ({
          id: p.id,
          score: 1,
          payload: /** @type {Record<string, unknown>} */ (p.payload),
        });
        if (withVector) {
          // Cloud/edge vectors are stored under the collection's single
          // named (""-default) vector slot; Qdrant reports it as an array.
          const v = /** @type {{ vector?: unknown }} */ (p).vector;
          if (Array.isArray(v) && v.length > 0 && v.every((n) => typeof n === 'number' && Number.isFinite(n))) {
            hit.vector = v;
          }
        }
        return hit;
      });
    },

    /**
     * Delete every point belonging to a document (payload filter on document_id).
     * @param {string} documentId
     * @returns {Promise<void>}
     */
    async deleteByDocument(documentId) {
      if (typeof documentId !== 'string' || documentId.trim() === '') {
        throw new QdrantError('deleteByDocument requires a non-empty documentId');
      }
      await request('POST', `/collections/${collection}/points/delete`, {
        filter: { must: [{ key: 'document_id', match: { value: documentId } }] },
      });
    },

    /**
     * Delete points by explicit ids (Phase 4: memory expiry uses exact ids,
     * never a content filter — expiry is a deliberate lifecycle act).
     * @param {string[]} ids
     * @returns {Promise<void>}
     */
    async deleteByIds(ids) {
      if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === 'string' && id.trim() !== '')) {
        throw new QdrantError('deleteByIds requires a non-empty array of point id strings');
      }
      await request('POST', `/collections/${collection}/points/delete`, { points: ids });
    },
  };
}

/**
 * Parse and validate a Qdrant search response into typed hits.
 * @param {any} data Raw JSON body from /points/search.
 * @param {string} collection Collection name (for error messages).
 * @returns {Array<{ id: string, score: number, payload: Record<string, unknown> }>}
 */
function parseHits(data, collection) {
  const result = data?.result;
  if (!Array.isArray(result)) {
    throw new QdrantError(`Qdrant search on "${collection}" returned no result array`);
  }
  return result.map((hit) => {
    const h = hit ?? {};
    if (typeof h.id !== 'string' || typeof h.score !== 'number' || typeof h.payload !== 'object' || h.payload === null) {
      throw new QdrantError(`Qdrant search on "${collection}" returned a malformed hit`);
    }
    return { id: h.id, score: h.score, payload: h.payload };
  });
}
