'use strict';

/**
 * AeroEdge basic local RAG pipeline (Phase 1).
 *
 * Two paths, one embedding space:
 *   ingest: document text → chunks → Ollama embeddings → validateDocumentChunk
 *           (Phase 0 contract gate) → Qdrant Edge upsert
 *   answer: question → Ollama query embedding (SAME model) → Qdrant Edge
 *           similarity search → grounded prompt (retrieved content verbatim)
 *           → Ollama generation
 *
 * This module is deliberately the seam everything later phases attach to:
 * retrieval grounding here becomes JEV evidence material in the Edge Pass,
 * and the Qdrant Edge client here never touches the cloud instance.
 *
 * Fully disconnected: the only network calls are to the configured Ollama
 * base URL and Qdrant Edge URL (see test/unit/offline-only.test.js, which
 * enforces that no external-SDK/network module is imported on this path).
 */

import { randomUUID } from 'node:crypto';
import { chunkText } from './chunker.js';
import { createOllamaClient } from './ollama.js';
import { createQdrantClient } from './qdrant.js';
import { validateDocumentChunk } from '../shared/schemas.js';

/** Max texts per /api/embed batch call (keeps payloads modest on devices). */
const EMBED_BATCH_SIZE = 32;

/**
 * @typedef {Object} RetrievedChunk
 * @property {string} chunkId
 * @property {string} documentId
 * @property {string} source
 * @property {string} content  // verbatim chunk content from the payload
 * @property {number} score
 */

/**
 * Build the grounded prompt for the generation model.
 *
 * Retrieved chunk content is included VERBATIM — this function must never
 * reflow, truncate, or paraphrase evidence, because JEV (later phases) will
 * audit exactly what the generator was shown.
 *
 * @param {string} question
 * @param {RetrievedChunk[]} chunks Retrieved passages, best match first.
 * @returns {{ system: string, prompt: string }}
 */
export function buildGroundedPrompt(question, chunks) {
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
  parts.push('');
  parts.push(`Question: ${question.trim()}`);
  parts.push('Answer (from the excerpts only, citing excerpt numbers):');

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
 *   ingestDocument: (doc: { documentId: string, text: string, assetId: string, component: string, source: string, version?: string }) => Promise<{ documentId: string, chunkCount: number, chunkIds: string[] }>,
 *   answerQuestion: (query: string, opts?: { limit?: number }) => Promise<{ query: string, answer: string, chunks: RetrievedChunk[], prompt: { system: string, prompt: string } }>,
 * }}
 */
export function createRagPipeline({ config, ollama, qdrant }) {
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
  async function ingestDocument({ documentId, text, assetId, component, source, version = '1' }) {
    for (const [name, value] of Object.entries({ documentId, text, assetId, component, source })) {
      if (typeof value !== 'string' || value.trim() === '') {
        throw new TypeError(`ingestDocument requires a non-empty "${name}"`);
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
        component: component,
        source,
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

    await qdrantClient.ensureCollection(embeddings[0].length);
    await qdrantClient.deleteByDocument(documentId);
    await qdrantClient.upsertPoints(points);
    return { documentId, chunkCount: points.length, chunkIds: points.map((p) => p.id) };
  }

  /**
   * Answer a question from the Edge document store: embed query → search →
   * grounded prompt → generate. Returns the answer plus the exact chunks
   * and prompt used, so later phases (JEV) can audit the evidence trail.
   */
  async function answerQuestion(query, { limit = 4 } = {}) {
    if (typeof query !== 'string' || query.trim() === '') {
      throw new TypeError('answerQuestion requires a non-empty query');
    }

    // Same embedding model/space as ingestion (see embedAll).
    const [queryVector] = await embedAll([query.trim()]);
    const hits = await qdrantClient.search(queryVector, { limit });

    /** @type {RetrievedChunk[]} */
    const chunks = hits.map((hit) => ({
      chunkId: String(hit.payload.id ?? hit.id),
      documentId: String(hit.payload.document_id ?? ''),
      source: String(hit.payload.source ?? ''),
      content: String(hit.payload.content ?? ''),
      score: hit.score,
    }));

    const prompt = buildGroundedPrompt(query, chunks);
    const answer = await ollamaClient.generate(prompt);
    return { query, answer, chunks, prompt };
  }

  return { ingestDocument, answerQuestion };
}
