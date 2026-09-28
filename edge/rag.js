'use strict';

/**
 * AeroEdge local RAG pipeline (Phase 1 loop + Phase 2 hybrid retrieval).
 *
 * Two paths, one embedding space:
 *   ingest: document text → chunks → Ollama embeddings → validateDocumentChunk
 *           (Phase 0 contract gate) → Qdrant Edge upsert (plus optional
 *           retrieval metadata: keywords, equipment model, doc type,
 *           applicability) over payload-indexed fields
 *   answer: question → [optional Phase 3 session context: query expansion
 *             for elliptical follow-ups + session-suggested metadata
 *             filters] → hybrid retrieval
 *             (semantic search + exact keyword search + metadata filtering
 *              → fusion → dedup → rerank → evidence pack)
 *           → grounded prompt (retrieved content verbatim, sources listed,
 *              compact session summary when a session is attached)
 *           → Ollama generation → answer + source citations
 *
 * Sessions are opt-in per call (`answerQuestion(q, { session })`): without
 * one, behavior is byte-identical to Phase 2. The session lives in
 * edge/session.js and is never persisted to Qdrant — it is working state for
 * one diagnostic conversation.
 *
 * This module is deliberately the seam everything later phases attach to:
 * the evidence pack and citations returned here become JEV evidence material
 * in the Edge Pass, and the Qdrant Edge client here never touches the cloud
 * instance.
 *
 * Fully disconnected: the only network calls are to the configured Ollama
 * base URL and Qdrant Edge URL (see test/unit/offline-only.test.js, which
 * enforces that no external-SDK/network module is imported on this path).
 */

import { randomUUID } from 'node:crypto';
import { chunkText } from './chunker.js';
import { createOllamaClient } from './ollama.js';
import { createQdrantClient } from './qdrant.js';
import { retrieveEvidence } from './retrieval.js';
import {
  createSession,
  expandQuery,
  extractAssetId,
  suggestSessionFilters,
  updateSessionFromQuery,
  updateSessionFromEvidence,
  recordActionsTaken,
  buildSessionSummary,
} from './session.js';
import { validateDocumentChunk } from '../shared/schemas.js';

/** Max texts per /api/embed batch call (keeps payloads modest on devices). */
const EMBED_BATCH_SIZE = 32;

/**
 * @typedef {import('./retrieval.js').RetrievedChunk} RetrievedChunk
 * @typedef {import('./retrieval.js').RetrievalFilters} RetrievalFilters
 * @typedef {import('./retrieval.js').EvidencePack} EvidencePack
 */

/**
 * A source citation for a grounded answer: one entry per document that
 * contributed evidence (chunkIds lists the chunks used from it).
 * @typedef {Object} Citation
 * @property {string} documentId
 * @property {string} source Human-readable source label (e.g. "AMM rev 42").
 * @property {string} [version] Document version, when known.
 * @property {string[]} chunkIds Chunks of this document used as evidence.
 */

/**
 * Extract source citations from an evidence pack: one entry per document
 * that contributed evidence, with the chunkIds used from it. Documents
 * with no usable document_id fall back to a per-chunk citation so a
 * citation is never silently dropped. Order follows the evidence order
 * (best chunk's document first).
 * @param {EvidencePack} evidence
 * @returns {Citation[]}
 */
export function extractCitations(evidence) {
  if (evidence === null || typeof evidence !== 'object' || !Array.isArray(evidence.chunks)) {
    throw new TypeError('extractCitations requires an evidence pack with a chunks array');
  }
  /** @type {Map<string, Citation>} */
  const byDoc = new Map();
  for (const chunk of evidence.chunks) {
    const key = chunk.documentId !== '' ? `doc:${chunk.documentId}` : `chunk:${chunk.chunkId}`;
    const existing = byDoc.get(key);
    if (existing) {
      existing.chunkIds.push(chunk.chunkId);
      continue;
    }
    byDoc.set(key, {
      documentId: chunk.documentId,
      source: chunk.source,
      ...(chunk.version !== undefined ? { version: chunk.version } : {}),
      chunkIds: [chunk.chunkId],
    });
  }
  return [...byDoc.values()];
}

/**
 * Build the grounded prompt for the generation model.
 *
 * Retrieved chunk content is included VERBATIM — this function must never
 * reflow, truncate, or paraphrase evidence, because JEV (later phases) will
 * audit exactly what the generator was shown.
 *
 * @param {string} question
 * @param {RetrievedChunk[]} chunks Retrieved passages, best match first.
 * @param {{ includeSourceLine?: boolean, context?: string }} [opts]
 *        `includeSourceLine` appends the "Available sources" block (Phase 2);
 *        `context` injects a compact session summary (Phase 3) before the
 *        question — callers must pass buildSessionSummary() output, never raw
 *        conversation history.
 * @returns {{ system: string, prompt: string }}
 */
export function buildGroundedPrompt(question, chunks, { includeSourceLine = false, context } = {}) {
  if (typeof question !== 'string' || question.trim() === '') {
    throw new TypeError('buildGroundedPrompt requires a non-empty question');
  }
  if (!Array.isArray(chunks)) {
    throw new TypeError('buildGroundedPrompt requires a chunk array');
  }

  const system =
    'You are a maintenance assistant for disconnected industrial and aviation ' +
    'environments. Answer ONLY from the numbered document excerpts provided. ' +
    'If the excerpts do not contain the answer, say exactly that you have no ' +
    'relevant document content for this question. Cite the excerpt numbers you used.';

  /** @type {string[]} */
  const parts = [];
  if (chunks.length === 0) {
    parts.push('Document excerpts: (none available)');
  } else {
    parts.push('Document excerpts:');
    chunks.forEach((chunk, i) => {
      parts.push(`[_excerpt ${i + 1} | source: ${chunk.source}]`);
      parts.push(chunk.content); // verbatim, never rewritten
    });
  }
  if (context !== undefined) {
    if (typeof context !== 'string' || context.trim() === '') {
      throw new TypeError('buildGroundedPrompt: "context" must be a non-empty string when provided');
    }
    parts.push('');
    parts.push(context); // compact session summary — bounded, never the raw log
  }
  parts.push('');
  parts.push(`Question: ${question.trim()}`);
  parts.push('Answer (from the excerpts only, citing excerpt numbers):');
  if (includeSourceLine && chunks.length > 0) {
    parts.push('');
    parts.push('Available sources for citation:');
    for (const chunk of chunks) {
      parts.push(`- source: ${chunk.source} | document: ${chunk.documentId}`);
    }
  }

  return { system, prompt: parts.join('\n') };
}

/**
 * Create the RAG pipeline.
 *
 * @param {Object} options
 * @param {Readonly<Record<string, string>>} config Loaded shared config.
 * @param {ReturnType<typeof createOllamaClient>} [ollama] Injected client (tests).
 * @param {ReturnType<typeof createQdrantClient>} [qdrant] Injected client (tests).
 * @returns {{
 *   ingestDocument: (doc: { documentId: string, text: string, assetId: string, component: string, source: string, version?: string, keywords?: string[], equipmentModel?: string, docType?: string, applicability?: string[] }) => Promise<{ documentId: string, chunkCount: number, chunkIds: string[] }>,
 *   answerQuestion: (query: string, opts?: { limit?: number, filters?: RetrievalFilters, prompt?: { includeSourceLine?: boolean }, session?: import('./session.js').SessionState }) => Promise<{ query: string, answer: string, chunks: RetrievedChunk[], citations: Citation[], evidence: EvidencePack, prompt: { system: string, prompt: string }, sessionQuery?: string, usedSessionContext?: boolean, sessionId?: string }>,
 *   retrieveEvidence: (query: string, opts?: { limit?: number, filters?: RetrievalFilters }) => Promise<EvidencePack>,
 * }}
 */
export function createRagPipeline({ config, ollama, qdrant }) {
  // Re-exported so callers need only this module for the Phase 3 surface.
  // (The canonical definitions live in edge/session.js.)
  const ollamaClient = ollama ?? createOllamaClient({
    baseUrl: config.OLLAMA_BASE_URL,
    embedModel: config.EMBEDDING_MODEL,
    generateModel: config.OLLAMA_MODEL,
  });
  const qdrantClient = qdrant ?? createQdrantClient({
    baseUrl: config.QDRANT_EDGE_URL,
    collection: config.QDRANT_EDGE_COLLECTION,
  });

  /**
   * Embed texts in batches. Ingestion and query embedding both call THIS
   * function with the same client and model — the two paths physically
   * cannot diverge into different embedding spaces.
   * @param {string[]} texts
   * @returns {Promise<number[][]>}
   */
  async function embedAll(texts) {
    /** @type {number[][]} */
    const out = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
      const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
      out.push(...(await ollamaClient.embed(batch)));
    }
    return out;
  }

  /**
   * Ingest a document: chunk → embed → validate → replace-and-upsert into
   * Qdrant Edge. Re-ingesting the same documentId replaces its chunks
   * (delete-by-document then upsert), so ingestion is idempotent.
   */
  async function ingestDocument({ documentId, text, assetId, component, source, version = '1', keywords, equipmentModel, docType, applicability }) {
    for (const [name, value] of Object.entries({ documentId, text, assetId, component, source })) {
      if (typeof value !== 'string' || value.trim() === '') {
        throw new TypeError(`ingestDocument requires a non-empty "${name}"`);
      }
    }
    if (equipmentModel !== undefined && (typeof equipmentModel !== 'string' || equipmentModel.trim() === '')) {
      throw new TypeError('ingestDocument: "equipmentModel" must be a non-empty string when provided');
    }
    if (docType !== undefined && (typeof docType !== 'string' || docType.trim() === '')) {
      throw new TypeError('ingestDocument: "docType" must be a non-empty string when provided');
    }
    for (const [name, list] of [['keywords', keywords], ['applicability', applicability]]) {
      if (list !== undefined && (!Array.isArray(list) || !list.every((k) => typeof k === 'string' && k.trim() !== ''))) {
        throw new TypeError(`ingestDocument: "${name}" must be an array of non-empty strings when provided`);
      }
    }

    const chunks = chunkText(text);
    if (chunks.length === 0) {
      throw new TypeError('ingestDocument: document text produced no chunks (is it empty?)');
    }

    // Same embedding model/space as the query path (see embedAll).
    const embeddings = await embedAll(chunks);
    if (embeddings.length !== chunks.length) {
      throw new Error(`embedding count mismatch: ${embeddings.length} for ${chunks.length} chunks`);
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
        // Phase 2 retrieval metadata: only set when provided, so Phase 1
        // callers keep producing byte-compatible records.
        ...(keywords !== undefined ? { keywords } : {}),
        ...(equipmentModel !== undefined ? { equipment_model: equipmentModel } : {}),
        ...(docType !== undefined ? { doc_type: docType } : {}),
        ...(applicability !== undefined ? { applicability } : {}),
        created_at: now,
        updated_at: now,
      };
      // Phase 0 contract gate: nothing reaches Qdrant that isn't a valid DocumentChunk.
      const verdict = validateDocumentChunk(record);
      if (!verdict.valid) {
        throw new Error(`DocumentChunk failed validation before upsert: ${verdict.errors.join('; ')}`);
      }
      const { embedding, ...payload } = record;
      points.push({ id: chunkId, vector: embedding, payload });
    }

    await qdrantClient.ensureCollection(embeddings[0].length, [
      // Payload indexes for the keyword/metadata legs of hybrid retrieval.
      { fieldName: 'keywords' },
      { fieldName: 'doc_type' },
      { fieldName: 'equipment_model' },
      { fieldName: 'version' },
      { fieldName: 'applicability' },
    ]);
    await qdrantClient.deleteByDocument(documentId);
    await qdrantClient.upsertPoints(points);
    return { documentId, chunkCount: points.length, chunkIds: points.map((p) => p.id) };
  }

  /**
   * Answer a question from the Edge document store via the hybrid pipeline,
   * optionally aware of the current diagnostic session (Phase 3):
   *
   *   - context-dependent follow-ups are expanded with the session's current
   *     asset/subsystem before retrieval ("what about the sensor?" resolves);
   *   - when the caller passes no explicit filters, the session suggests
   *     hard identifier filters (asset/equipment model) — but if they
   *     over-restrict (zero evidence), retrieval is retried unfiltered so a
   *     stale session value can never silently blank an answer;
   *   - a COMPACT session summary is injected into the prompt (never the raw
   *     conversation), built from the state BEFORE this turn is recorded;
   *   - the session is then updated with this turn's query and evidence.
   *
   * Without `session`, behavior is byte-identical to Phase 2.
   */
  async function answerQuestion(query, { limit = 4, filters, prompt: promptOpts, session } = {}) {
    if (typeof query !== 'string' || query.trim() === '') {
      throw new TypeError('answerQuestion requires a non-empty query');
    }
    if (
      session !== undefined &&
      (session === null || typeof session !== 'object' || !Array.isArray(session.recentQueries))
    ) {
      throw new TypeError(
        'answerQuestion: "session" must be a session state object (see edge/session.js createSession) when provided'
      );
    }

    let expandedQuery = query.trim();
    /** @type {{ filters?: import('./retrieval.js').RetrievalFilters }|undefined} */
    let effectiveFilters = filters;
    if (session !== undefined) {
      recordActionsTaken(session, query);
      const expansion = expandQuery(query, session);
      expandedQuery = expansion.query;
      if (filters === undefined) {
        effectiveFilters = suggestSessionFilters(session).filters;
        // A query that EXPLICITLY names a different asset overrides the
        // session's suggested filter (explicit context beats stale state).
        const explicitAsset = extractAssetId(query);
        if (
          effectiveFilters !== undefined &&
          explicitAsset !== null &&
          effectiveFilters.assetId !== undefined &&
          effectiveFilters.assetId !== explicitAsset
        ) {
          delete effectiveFilters.assetId;
          if (Object.keys(effectiveFilters).length === 0) effectiveFilters = undefined;
        }
      }
    }

    let evidence = await retrieveEvidence(
      { embedFn: embedAll, qdrant: qdrantClient },
      expandedQuery,
      { limit, filters: effectiveFilters }
    );

    // Session-suggested filters are a convenience, never a cage: if they
    // over-restrict (zero evidence) and the caller did not ask for them
    // explicitly, retry unfiltered.
    if (session !== undefined && filters === undefined && effectiveFilters !== undefined && evidence.chunks.length === 0) {
      evidence = await retrieveEvidence(
        { embedFn: embedAll, qdrant: qdrantClient },
        expandedQuery,
        { limit, filters: undefined }
      );
    }

    // The injected summary reflects the state BEFORE this turn, so it carries
    // prior working context without duplicating the current question.
    const hasContext =
      session !== undefined &&
      (session.assetId !== null ||
        session.component !== null ||
        session.issue !== null ||
        session.actionsTaken.length > 0 ||
        session.recentQueries.length > 0);
    const context = hasContext ? buildSessionSummary(session) : undefined;

    if (session !== undefined) {
      updateSessionFromQuery(session, query);
      updateSessionFromEvidence(session, evidence);
    }

    const prompt = buildGroundedPrompt(query, evidence.chunks, {
      ...promptOpts,
      ...(context !== undefined ? { context } : {}),
    });
    const answer = await ollamaClient.generate(prompt);
    return {
      query,
      answer,
      chunks: evidence.chunks,
      citations: extractCitations(evidence),
      evidence,
      prompt,
      ...(session !== undefined
        ? { sessionQuery: expandedQuery, usedSessionContext: context !== undefined, sessionId: session.sessionId }
        : {}),
    };
  }

  return {
    ingestDocument,
    answerQuestion,
    /** Direct hybrid-retrieval access (no generation) — used by JEV later. */
    retrieveEvidence: (query, opts) => retrieveEvidence({ embedFn: embedAll, qdrant: qdrantClient }, query, opts),
    // Phase 3 session surface, re-exported for one-stop import by callers.
    // (Canonical definitions live in edge/session.js.)
    createSession,
    buildSessionSummary,
  };
}
