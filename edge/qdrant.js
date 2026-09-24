'use strict';

/**
 * Minimal Qdrant REST client for the Edge instance.
 *
 * Only the operations the RAG pipeline needs: ensure a collection exists,
 * upsert points, vector search, and delete-by-document-filter. The Edge
 * instance is architecturally separate from the Cloud instance — this module
 * only ever talks to the URL in QDRANT_EDGE_URL; nothing here knows the
 * cloud endpoint exists.
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
    collection,

    /**
     * Create the collection with the given vector size if it does not exist.
     * @param {number} vectorSize
     * @returns {Promise<void>}
     */
    async ensureCollection(vectorSize) {
      if (!Number.isInteger(vectorSize) || vectorSize <= 0) {
        throw new QdrantError(`ensureCollection requires a positive integer vector size, got ${vectorSize}`);
      }
      const existing = await request('GET', `/collections/${collection}`);
      if (existing?.result) return; // exists (even while shutting down: warn-and-proceed is fine for Edge)

      await request('PUT', `/collections/${collection}`, {
        vectors: { size: vectorSize, distance: 'Cosine' },
      });
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
     * Vector similarity search.
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
      const result = /** @type {{ result?: unknown }} */ (data).result;
      if (!Array.isArray(result)) {
        throw new QdrantError(`Qdrant search on "${collection}" returned no result array`);
      }
      return result.map((hit) => {
        const h = /** @type {{ id?: unknown, score?: unknown, payload?: unknown }} */ (hit);
        if (typeof h.id !== 'string' || typeof h.score !== 'number' || typeof h.payload !== 'object' || h.payload === null) {
          throw new QdrantError(`Qdrant search on "${collection}" returned a malformed hit`);
        }
        return { id: h.id, score: h.score, payload: /** @type {Record<string, unknown>} */ (h.payload) };
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
  };
}
