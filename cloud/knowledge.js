'use strict';

/**
 * Cloud Knowledge Layer for AeroEdge (Phase 6).
 *
 * Enterprise documents can be ingested into a DISTINCT Cloud knowledge
 * store: parsing → chunking → embedding → metadata → Qdrant Cloud. This is
 * the cloud counterpart of Phase 1's edge ingestion pipeline, writing to
 * the Qdrant instance/collection named by QDRANT_CLOUD_URL /
 * QDRANT_CLOUD_COLLECTION — architecturally separate from anything on the
 * edge (enforced by configuration and audited by the interconnect tests).
 *
 * The trust asymmetry is the point, and it is stamped IN CODE:
 *
 *   - Enterprise-sourced documents arrive from a controlled channel. They
 *     are pre-trusted on arrival: every chunk this pipeline writes carries
 *     `jev_status: "not_applicable"`. NO JEV pass runs here — JEV exists to
 *     evaluate knowledge whose trustworthiness is UNCERTAIN (field-
 *     originated technician knowledge), not controlled enterprise input.
 *   - Edge document chunks (Phases 1–5) carry NO jev_status at all: they
 *     are retrieval material, not yet knowledge. The field on
 *     DocumentChunk is optional precisely so edge records stay
 *     byte-compatible.
 *
 * This module lives in cloud/ and imports only the ENDPOINT-AGNOSTIC
 * transport primitives (edge/chunker.js, edge/ollama.js, edge/qdrant.js —
 * none of them hardcodes an endpoint or knows which side it serves). It
 * never imports the edge pipeline (rag.js/session.js/orchestrator.js/jev.js)
 * and never writes anywhere but the Cloud store.
 *
 * Scope guard (Phase 6): ingestion and query ONLY. No edge provisioning
 * (pulling cloud knowledge down to a device), no sync, no propagation.
 */

import { randomUUID } from 'node:crypto';
import { chunkText } from '../edge/chunker.js';
import { createOllamaClient } from '../edge/ollama.js';
import { createQdrantClient } from '../edge/qdrant.js';
import { validateDocumentChunk } from '../shared/schemas.js';

/** JEV standing of EVERY chunk this pipeline writes (stamped in code, not by callers). */
export const CLOUD_JEV_STATUS = 'not_applicable';

/** Max texts per /api/embed batch call (mirrors the edge pipeline's batching). */
const EMBED_BATCH_SIZE = 32;

/**
 * @typedef {import('../shared/schemas.js').DocumentChunk} DocumentChunk
 */

/**
 * Create the Cloud knowledge layer.
 *
 * @param {Object} options
 * @param {Readonly<Record<string, string>>} config Loaded shared config (QDRANT_CLOUD_URL / QDRANT_CLOUD_COLLECTION name the Cloud store).
 * @param {ReturnType<typeof import('../edge/ollama.js').createOllamaClient>} [ollama] Injected Ollama client (tests); built from config otherwise.
 * @param {ReturnType<typeof import('../edge/qdrant.js').createQdrantClient>} [qdrant] Injected Qdrant client (tests); bound to the CLOUD store from config otherwise.
 * @returns {{
 *   collection: string,
 *   jevStatus: 'not_applicable',
 *   qdrantClient: ReturnType<typeof createQdrantClient>,
 *   ingestDocument: (doc: {
 *     documentId: string, text: string, assetId: string, component: string, source: string,
 *     version?: string, keywords?: string[], equipmentModel?: string, docType?: string, applicability?: string[],
 *   }) => Promise<{ documentId: string, chunkCount: number, chunkIds: string[], jevStatus: 'not_applicable', collection: string }>,
 *   search: (query: string, opts?: { limit?: number, filters?: Record<string, string|string[]> }) => Promise<{ query: string, chunks: Array<{ chunkId: string, documentId: string, source: string, content: string, score: number, jevStatus: string }> }>,
 *   deleteByDocument: (documentId: string) => Promise<void>,
 * }}
 */
export function createCloudKnowledge({ config, ollama, qdrant }) {
  if (config === null || typeof config !== 'object') {
    throw new TypeError('createCloudKnowledge requires a loaded shared config');
  }
  const collection = config.QDRANT_CLOUD_COLLECTION ?? 'aeroedge_cloud_docs';
  const ollamaClient =
    ollama ??
    createOllamaClient({
      baseUrl: config.OLLAMA_BASE_URL,
      embedModel: config.EMBEDDING_MODEL,
      generateModel: config.OLLAMA_MODEL,
    });
  const qdrantClient =
    qdrant ??
    createQdrantClient({
      // The CLOUD endpoint — never the edge URL. This is the architectural
      // separation, in one line of configuration.
      baseUrl: config.QDRANT_CLOUD_URL,
      collection,
    });

  /**
   * Embed texts in batches with the configured Cloud-side embedding model.
   * @param {string[]} texts
   * @returns {Promise<number[][]>}
   */
  async function embedAll(texts) {
    /** @type {number[][]} */
    const out = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
      out.push(...(await ollamaClient.embed(texts.slice(i, i + EMBED_BATCH_SIZE))));
    }
    return out;
  }

  /**
   * Ingest one enterprise document into the Cloud knowledge store:
   * normalize → chunk → embed → stamp jev_status 'not_applicable' →
   * validate against the Phase 0 contract → replace-and-upsert into
   * Qdrant Cloud (idempotent per documentId, like the edge pipeline).
   *
   * The JEV stamp happens HERE, inside the pipeline — no caller input can
   * set it to anything else, and no JEV evaluation runs at any point.
   */
  async function ingestDocument({ documentId, text, assetId, component, source, version = '1', keywords, equipmentModel, docType, applicability }) {
    for (const [name, value] of Object.entries({ documentId, text, assetId, component, source })) {
      if (typeof value !== 'string' || value.trim() === '') {
        throw new TypeError(`cloud ingestDocument requires a non-empty "${name}"`);
      }
    }
    if (equipmentModel !== undefined && (typeof equipmentModel !== 'string' || equipmentModel.trim() === '')) {
      throw new TypeError('cloud ingestDocument: "equipmentModel" must be a non-empty string when provided');
    }
    if (docType !== undefined && (typeof docType !== 'string' || docType.trim() === '')) {
      throw new TypeError('cloud ingestDocument: "docType" must be a non-empty string when provided');
    }
    for (const [name, list] of [['keywords', keywords], ['applicability', applicability]]) {
      if (list !== undefined && (!Array.isArray(list) || !list.every((k) => typeof k === 'string' && k.trim() !== ''))) {
        throw new TypeError(`cloud ingestDocument: "${name}" must be an array of non-empty strings when provided`);
      }
    }

    const chunks = chunkText(text);
    if (chunks.length === 0) {
      throw new TypeError('cloud ingestDocument: document text produced no chunks (is it empty?)');
    }

    const embeddings = await embedAll(chunks);
    if (embeddings.length !== chunks.length) {
      throw new Error(`cloud embedding count mismatch: ${embeddings.length} for ${chunks.length} chunks`);
    }

    const now = new Date().toISOString();
    /** @type {{ id: string, vector: number[], payload: Record<string, unknown> }[]} */
    const points = [];
    for (let i = 0; i < chunks.length; i++) {
      /** Qdrant point IDs must be unsigned ints or UUIDs; DocumentChunk.id is a UUID. */
      const chunkId = randomUUID();
      /** @type {Record<string, unknown>} */
      const record = {
        id: chunkId,
        document_id: documentId,
        version,
        content: chunks[i],
        embedding: embeddings[i],
        asset_id: assetId,
        component,
        source,
        // Phase 2 retrieval metadata: only set when provided.
        ...(keywords !== undefined ? { keywords } : {}),
        ...(equipmentModel !== undefined ? { equipment_model: equipmentModel } : {}),
        ...(docType !== undefined ? { doc_type: docType } : {}),
        ...(applicability !== undefined ? { applicability } : {}),
        // THE Phase 6 contract, stamped in code: enterprise documents are
        // pre-trusted. JEV does not evaluate controlled enterprise input —
        // it evaluates field-originated knowledge whose standing is uncertain.
        jev_status: CLOUD_JEV_STATUS,
        created_at: now,
        updated_at: now,
      };
      // Phase 0 contract gate: nothing reaches Qdrant Cloud that isn't a
      // valid DocumentChunk (including the JEV standing).
      const check = validateDocumentChunk(record);
      if (!check.valid) {
        throw new Error(`cloud DocumentChunk failed validation before upsert: ${check.errors.join('; ')}`);
      }
      const { embedding, ...payload } = record;
      points.push({ id: chunkId, vector: embedding, payload });
    }

    await qdrantClient.ensureCollection(embeddings[0].length, [
      { fieldName: 'keywords' },
      { fieldName: 'doc_type' },
      { fieldName: 'equipment_model' },
      { fieldName: 'version' },
      { fieldName: 'applicability' },
      { fieldName: 'jev_status' },
    ]);
    // Replace-and-upsert: re-ingesting the same documentId is idempotent.
    await qdrantClient.deleteByDocument(documentId);
    await qdrantClient.upsertPoints(points);
    return { documentId, chunkCount: points.length, chunkIds: points.map((p) => p.id), jevStatus: CLOUD_JEV_STATUS, collection };
  }

  /**
   * Query the Cloud knowledge store: embed the query and search Qdrant
   * Cloud (optionally constrained by metadata filters). Enterprise content
   * only — this never touches any edge collection.
   * @param {string} query
   * @param {Object} [opts]
   * @param {number} [opts.limit]
   * @param {Record<string, string|string[]>} [opts.filters] Metadata constraints (assetId, component, docType, docVersion, equipmentModel).
   * @returns {Promise<{ query: string, chunks: Array<{ chunkId: string, documentId: string, source: string, content: string, score: number, jevStatus: string }> }>}
   */
  async function search(query, { limit = 4, filters } = {}) {
    if (typeof query !== 'string' || query.trim() === '') {
      throw new TypeError('cloud search requires a non-empty query');
    }
    const [vector] = await embedAll([query.trim()]);
    /** @type {import('../edge/qdrant.js').QdrantFilter|undefined} */
    let filter;
    if (filters !== undefined && Object.keys(filters).length > 0) {
      const allowed = ['assetId', 'component', 'docType', 'docVersion', 'equipmentModel'];
      /** @type {import('../edge/qdrant.js').MatchClause[]} */
      const must = [];
      for (const key of Object.keys(filters)) {
        if (!allowed.includes(key)) {
          throw new TypeError(`cloud search: unknown filter field "${key}" (allowed: ${allowed.join(', ')})`);
        }
      }
      if (filters.assetId !== undefined) must.push({ key: 'asset_id', match: { value: filters.assetId } });
      if (filters.component !== undefined) must.push({ key: 'component', match: { value: filters.component } });
      if (filters.docType !== undefined) must.push({ key: 'doc_type', match: { value: filters.docType } });
      if (filters.docVersion !== undefined) must.push({ key: 'version', match: { value: filters.docVersion } });
      if (filters.equipmentModel !== undefined) must.push({ key: 'equipment_model', match: { value: filters.equipmentModel } });
      filter = must.length > 0 ? { must } : undefined;
    }
    const hits = await qdrantClient.searchWhere(vector, { limit, filter });
    return {
      query: query.trim(),
      chunks: hits.map((hit) => ({
        chunkId: String(hit.id),
        documentId: String(hit.payload.document_id ?? ''),
        source: String(hit.payload.source ?? ''),
        content: String(hit.payload.content ?? ''),
        score: hit.score,
        jevStatus: String(hit.payload.jev_status ?? ''),
      })),
    };
  }

  /**
   * Delete every Cloud chunk of a document (test isolation and admin
   * removal; re-ingestion is the normal replace path).
   * @param {string} documentId
   */
  async function deleteByDocument(documentId) {
    await qdrantClient.deleteByDocument(documentId);
  }

  return {
    collection,
    jevStatus: CLOUD_JEV_STATUS,
    /** Exposed for auditing/tests: the client bound to the CLOUD store. */
    qdrantClient,
    ingestDocument,
    search,
    deleteByDocument,
  };
}
