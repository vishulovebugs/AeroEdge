'use strict';

/**
 * Shared in-memory fakes for the Ollama and Qdrant client interfaces.
 *
 * These implement the same call surface as the real clients in edge/ollama.js
 * and edge/qdrant.js so suites can exercise the full pipeline wiring with
 * ZERO network. The Qdrant fake ranks with real cosine similarity and
 * approximates Qdrant filter semantics (must/should, match value/any/text)
 * closely enough for wiring tests; true filter behavior is covered by the
 * live integration suites.
 */

/** Deny-all fetch: any network attempt fails the test immediately. */
export const denyAllFetch = /** @type {typeof fetch} */ (
  () => Promise.reject(new Error('network access denied by test'))
);

/** Deterministic fake embedder: normalized word-bucket vectors. */
export function makeFakeOllama({ respond } = {}) {
  /** @type {string[][]} */
  const embedCalls = [];
  /** @type {{system: string, prompt: string}[]} */
  const generateCalls = [];

  /** @param {string} text */
  function embedOne(text) {
    const vec = new Array(32).fill(0);
    for (const word of text.toLowerCase().match(/[a-z0-9·.-]+/g) ?? []) {
      let h = 0;
      for (const ch of word) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      vec[h % 32] += 1;
    }
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    return vec.map((v) => v / (norm || 1));
  }

  return {
    embedCalls,
    generateCalls,
    /** @param {string | string[]} input */
    async embed(input) {
      const inputs = Array.isArray(input) ? input : [input];
      embedCalls.push(inputs);
      return inputs.map(embedOne);
    },
    /** Grounded-model stand-in: answers only from excerpt 1 in the prompt,
     * unless a scriptable `respond({ prompt })` was provided (Phase 5 JEV
     * tests script verdict JSON through this hook; the answer-generation
     * behavior above stays the no-script default). */
    async generate({ prompt }) {
      generateCalls.push({ prompt });
      if (typeof respond === 'function') {
        return respond({ prompt });
      }
      const start = prompt.indexOf('[_excerpt 1');
      const body = start === -1 ? '(no excerpts)' : prompt.slice(prompt.indexOf('\n', start) + 1);
      const firstLine = body.split('\n')[0];
      return `Grounded answer using: ${firstLine.slice(0, 240)}`;
    },
  };
}

/**
 * Approximate Qdrant filter evaluation for a single condition clause:
 * `match.value` equality, `match.any` membership, and `match.text` as
 * all-token substring matching over the payload value (Qdrant tokenizes on
 * word boundaries; substring is close enough for wiring tests).
 * @param {{ key: string, match?: { value?: unknown, any?: unknown[], text?: string } }} clause
 * @param {Record<string, unknown>} payload
 * @returns {boolean}
 */
function evalClause(clause, payload) {
  const value = payload[clause.key];
  const match = clause.match ?? {};
  if (match.value !== undefined) return String(value) === String(match.value);
  if (match.any !== undefined) return match.any.map(String).includes(String(value));
  if (match.text !== undefined) {
    const content = String(value ?? '').toLowerCase();
    const tokens = String(match.text).toLowerCase().split(/[^a-z0-9·]+/).filter(Boolean);
    return tokens.length > 0 && tokens.every((t) => content.includes(t));
  }
  return false;
}

/**
 * Approximate Qdrant filter evaluation: all `must` clauses pass, no
 * `must_not` clause passes, and at least one `should` clause passes when
 * `should` is present.
 * @param {{ must?: unknown[], should?: unknown[], must_not?: unknown[] }} filter
 * @param {Record<string, unknown>} payload
 * @returns {boolean}
 */
function evalFilter(filter, payload) {
  const clauses = /** @type {any[]} */ (filter.must ?? []);
  if (clauses.some((c) => !evalClause(c, payload))) return false;
  const mustNot = /** @type {any[]} */ (filter.must_not ?? []);
  if (mustNot.some((c) => evalClause(c, payload))) return false;
  const should = /** @type {any[]} */ (filter.should ?? []);
  if (should.length > 0 && !should.some((c) => evalClause(c, payload))) return false;
  return true;
}

/**
 * Serialize a JEV-shaped response object the way a small local model would
 * emit it: a JSON object, optionally wrapped in a code fence / prose.
 * @param {Record<string, unknown>} body
 * @param {{ fenced?: boolean }} [opts]
 * @returns {string}
 */
export function jevResponse(body, { fenced = false } = {}) {
  const json = JSON.stringify(body);
  return fenced ? `\`\`\`here is my assessment:\n${json}\n\`\`\`` : json;
}

/**
 * A scripted JEV responder: pops one raw response per generate() call and
 * keeps returning the last one (later calls than scripted are common when
 * evaluation retries retrieval). Records every prompt it saw.
 * @param {string[]} responses Raw model responses in order.
 */
export function makeScriptedJev(responses) {
  if (!Array.isArray(responses) || responses.length === 0) {
    throw new TypeError('makeScriptedJev requires a non-empty response array');
  }
  const seenPrompts = [];
  return {
    seenPrompts,
    respond({ prompt }) {
      seenPrompts.push(prompt);
      const next = Math.min(seenPrompts.length - 1, responses.length - 1);
      return responses[next];
    },
  };
}

/**
 * In-memory Qdrant stand-in with real cosine ranking and filter support.
 * @param {{ collection?: string }} [opts] Collection name the fake reports (mirrors the real client).
 */
export function makeFakeQdrant({ collection = 'aeroedge_edge_docs' } = {}) {
  /** @type {Map<string, { vector: number[], payload: Record<string, unknown> }>} */
  const points = new Map();
  /** @type {string[]} */
  const calls = [];

  /**
   * Cosine-score all stored points against `vector`.
   * @param {number[]} vector
   */
  function scoreAll(vector) {
    return [...points.values()].map((p) => {
      const dot = p.vector.reduce((s, v, i) => s + v * vector[i], 0);
      const nv = Math.sqrt(p.vector.reduce((s, v) => s + v * v, 0));
      return { id: String(p.payload.id), score: dot / (nv || 1), payload: p.payload };
    });
  }

  return {
    collection,
    calls,
    size: () => points.size,
    has: (id) => points.has(id),
    async ensureCollection(vectorSize) {
      calls.push(`ensureCollection:${vectorSize}`);
    },
    /** @param {{ id: string, vector: number[], payload: Record<string, unknown> }[]} pts */
    async upsertPoints(pts) {
      calls.push(`upsert:${pts.length}`);
      for (const p of pts) points.set(p.id, { vector: p.vector, payload: p.payload });
    },
    async ensurePayloadIndexes(indexes) {
      calls.push(`payloadIndexes:${indexes.length}`);
    },
    /**
     * @param {number[]} vector
     * @param {{ limit?: number }} [opts]
     */
    async search(vector, { limit = 4 } = {}) {
      calls.push(`search:${limit}`);
      return scoreAll(vector).sort((a, b) => b.score - a.score).slice(0, limit);
    },
    /**
     * Vector search constrained by a payload filter.
     * @param {number[]} vector
     * @param {{ limit?: number, filter?: { must?: unknown[], should?: unknown[], must_not?: unknown[] } }} [opts]
     */
    async searchWhere(vector, { limit = 4, filter } = {}) {
      calls.push(`searchWhere:${limit}:${filter ? 'filtered' : 'unfiltered'}`);
      return scoreAll(vector)
        .filter((hit) => !filter || evalFilter(filter, hit.payload))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    },
    /**
     * Fetch points by payload filter without vectors (keyword/metadata leg;
     * Phase 4 memory store). Returns REAL point ids (Map keys), matching the
     * real Qdrant scroll response — document-chunk payloads carry the same
     * id as their point, so this is observably identical for chunk tests.
     * @param {{ must?: unknown[], should?: unknown[], must_not?: unknown[] }} filter
     * @param {{ limit?: number }} [opts]
     */
    async scrollWithFilter(filter, { limit = 50 } = {}) {
      calls.push(`scroll:${limit}`);
      /** @type {{ id: string, score: number, payload: Record<string, unknown> }[]} */
      const out = [];
      for (const [pointId, p] of [...points]) {
        if (!evalFilter(filter, p.payload)) continue;
        out.push({ id: pointId, score: 1, payload: p.payload });
        if (out.length >= limit) break;
      }
      return out;
    },
    async deleteByDocument(documentId) {
      calls.push(`deleteByDocument:${documentId}`);
      for (const [id, p] of [...points]) {
        if (p.payload.document_id === documentId) points.delete(id);
      }
    },
    /** Delete by explicit point ids (Phase 4 memory expiry). */
    async deleteByIds(ids) {
      calls.push(`deleteByIds:${ids.length}`);
      for (const id of ids) points.delete(id);
    },
  };
}
