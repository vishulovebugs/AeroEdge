'use strict';

/**
 * JEV Edge Pass for AeroEdge (Phase 5).
 *
 * The moment a technician submits a field observation (or a revision), a
 * fast, local evaluation runs BEFORE the Memory Orchestrator routes it:
 *
 *   memory candidate + evidence pack + targeted retrieval of contradicting
 *   authoritative knowledge → one SEPARATE Ollama call → JEVVerdict
 *
 * Non-negotiables, enforced in code (not just in the prompt):
 *   - The JEV call is DISTINCT from answer generation. It never answers the
 *     technician's question, and the generator never certifies its own
 *     output. One model call doing both would be grading its own homework.
 *   - `rationale` is REQUIRED. A model response with an empty, missing, or
 *     whitespace-only rationale is not an evaluation — it is coerced to
 *     `needs_more_evidence` with a deterministic, honest rationale written
 *     by THIS code, never passed through.
 *   - Unparseable model output, out-of-contract verdicts, and evaluator
 *     crashes are all coerced the same way. JEV failure degrades to "not
 *     enough evidence to accept" — it never blocks recording (the
 *     orchestrator owns that guarantee end to end).
 *
 * Targeted contradiction retrieval reuses Phase 2's hybrid retrieval
 * (`retrieveEvidence`) against the AUTHORITATIVE DOCUMENT collection,
 * scoped to the candidate's asset (and subsystem when known). Authoritative
 * docs are high-confidence by construction — they are Type A manual
 * material, the baseline truth technician knowledge is measured against.
 *
 * Fully offline: the only I/O is the injected Ollama client (one generate
 * call + embeddings) and the Edge Qdrant document client.
 */

import { retrieveEvidence } from './retrieval.js';
import { validateJEVVerdict, JEV_VERDICTS } from '../shared/schemas.js';

/**
 * @typedef {import('./retrieval.js').EvidencePack} EvidencePack
 * @typedef {import('./retrieval.js').RetrievedChunk} RetrievedChunk
 * @typedef {import('../shared/schemas.js').Memory} Memory
 * @typedef {import('../shared/schemas.js').JEVVerdictValue} JEVVerdictValue
 */

/** Verdicts the Edge Pass may produce (Cloud Pass owns the rest). */
export const EDGE_JEV_VERDICTS = Object.freeze(['accept_local', 'needs_more_evidence', 'flag_risk']);

/**
 * A contradiction candidate surfaced by targeted retrieval. `similarity` is
 * the retrieval score (comparable within one pack, not across packs).
 * @typedef {Object} ContradictionCandidate
 * @property {string} chunkId
 * @property {string} documentId
 * @property {string} source
 * @property {string} content  // verbatim authoritative content
 * @property {number} similarity
 */

/**
 * The Edge Pass result: exactly the fields a JEVVerdict record requires,
 * plus the contradicting candidates the evaluator retrieved. The
 * orchestrator stamps verdict_id/memory_id (it owns the memory identity)
 * and persists the verdict alongside the memory.
 * @typedef {Object} EdgePassResult
 * @property {JEVVerdictValue} verdict
 * @property {string} rationale Always non-empty — see the coercion rules.
 * @property {number} confidence 0..1; 0 for any coerced verdict.
 * @property {string[]} risk_flags
 * @property {string[]} evidence_used Chunk ids the evaluation consulted.
 * @property {string} model_used
 * @property {string} evaluated_at
 * @property {'edge'} stage
 * @property {ContradictionCandidate[]} retrievedContradictions
 */

/** Maximum authoritative chunks pulled into one evaluation (edge devices: bounded prompts). */
const MAX_AUTHORITATIVE_CHUNKS = 6;

/**
 * Build the JEV evaluation prompt. Deliberately a DIFFERENT role and
 * contract from rag.js buildGroundedPrompt: the generator answers the
 * technician's question from evidence; the Edge Pass certifies a memory
 * candidate. The four checks are driven in a fixed order so responses stay
 * parseable and the evaluation is auditable.
 *
 * @param {Object} input
 * @param {Memory} input.candidate The memory being evaluated (content verbatim).
 * @param {EvidencePack|null} [input.evidencePack] Evidence retrieved at creation time, when available.
 * @param {ContradictionCandidate[]} input.contradictingDocs Targeted retrieval hits from authoritative knowledge.
 * @returns {{ system: string, prompt: string }}
 */
export function buildJEVPrompt({ candidate, evidencePack, contradictingDocs }) {
  if (candidate === null || typeof candidate !== 'object' || typeof candidate.content !== 'string' || candidate.content.trim() === '') {
    throw new TypeError('buildJEVPrompt requires a candidate Memory with non-empty content');
  }
  const docs = Array.isArray(contradictingDocs) ? contradictingDocs : [];

  const system =
    'You are JEV, a strict knowledge-evaluation judge for maintenance operations in ' +
    'disconnected environments. You do NOT answer questions and you do NOT assist ' +
    'repairs. You evaluate exactly one proposed field-knowledge record for internal ' +
    'consistency, contradiction against authoritative documents, evidence ' +
    'sufficiency, and provisional risk. Be conservative: when you cannot justify a ' +
    'verdict, choose needs_more_evidence. You MUST respond with a single JSON object ' +
    'and nothing else.';

  /** @type {string[]} */
  const parts = [];
  parts.push('Evaluate this proposed field-knowledge record:');
  parts.push(`[candidate | type: ${candidate.memory_type} | asset: ${candidate.asset_id} | source: ${candidate.source}]`);
  parts.push(candidate.content.trim());

  parts.push('');
  if (evidencePack !== null && evidencePack !== undefined && Array.isArray(evidencePack.chunks) && evidencePack.chunks.length > 0) {
    parts.push('Evidence pack retrieved when this record was created:');
    evidencePack.chunks.forEach((chunk, i) => {
      parts.push(`[_evidence ${i + 1} | source: ${chunk.source}]`);
      parts.push(chunk.content); // verbatim, same policy as the generator prompt
    });
  } else {
    parts.push('Evidence pack: (none available — this record was captured without supporting evidence)');
  }

  parts.push('');
  if (docs.length > 0) {
    parts.push('Authoritative documents possibly contradicting or constraining the record:');
    docs.forEach((doc, i) => {
      parts.push(`[_authoritative ${i + 1} | source: ${doc.source}]`);
      parts.push(doc.content); // verbatim
    });
  } else {
    parts.push('Authoritative documents: (none retrieved for this asset/subsystem)');
  }

  parts.push('');
  parts.push(
    'Work through ALL FOUR checks before deciding:\n' +
    '1. Internal consistency: is the record self-contradictory or incoherent?\n' +
    '2. Contradiction: does it conflict with any authoritative document above? ' +
    'Weight safety-critical procedures (torques, limits, pressures, shutdown and ' +
    'safety steps) most heavily — a safety conflict is always flag_risk.\n' +
    '3. Evidence sufficiency: does the record or its evidence actually support it?\n' +
    '4. Provisional risk: if acted on and wrong, what could be harmed?\n' +
    'Then respond with EXACTLY one JSON object, no other text:\n' +
    '{"verdict":"accept_local|needs_more_evidence|flag_risk",' +
    '"rationale":"<required, specific, non-empty — name the check(s) and excerpt(s) that drove it>",' +
    '"confidence":<number 0..1>,"risk_flags":["<short tags, e.g. safety_critical_conflict, torque_spec_conflict"]}'
  );

  return { system, prompt: parts.join('\n') };
}

/**
 * Extract the first JSON object from model output. Small local models wrap
 * JSON in prose or code fences; tolerate that but nothing sloppier.
 * @param {string} text Raw model response.
 * @returns {Record<string, unknown>|null} Parsed object, or null when no JSON object is found.
 */
export function extractJson(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  const start = text.indexOf('{');
  if (start === -1) return null;
  for (let end = text.lastIndexOf('}'); end > start; end = text.lastIndexOf('}', end - 1)) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return /** @type {Record<string, unknown>} */ (parsed);
      }
    } catch {
      // try the next smaller window
    }
  }
  return null;
}

/** @param {unknown} v @returns {boolean} Non-empty after trimming. */
const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * Normalize a raw model response into an Edge Pass result, enforcing every
 * code-level guarantee. The model never gets the final word on contract:
 *
 *   - rationale missing/empty/whitespace → verdict COERCED to
 *     needs_more_evidence, confidence 0, honest code-written rationale;
 *   - verdict missing/unknown/out of Edge Pass scope → same coercion;
 *   - non-numeric or out-of-range confidence → 0 when kept, otherwise
 *     clamped into [0, 1];
 *   - risk_flags non-strings or non-array → dropped (array stays valid).
 *
 * @param {Record<string, unknown>|null} parsed Parsed model JSON (null = unparseable).
 * @param {{ model: string, coercedReason?: string }} meta
 * @returns {EdgePassResult}
 */
export function normalizeEdgeResponse(parsed, { model, coercedReason }) {
  const evaluated_at = new Date().toISOString();

  // Unparseable output: nothing the model said can be trusted or quoted.
  if (parsed === null || typeof parsed !== 'object') {
    return {
      verdict: 'needs_more_evidence',
      rationale:
        coercedReason ??
        'Edge Pass could not parse the evaluator model output (no valid JSON object). ' +
          'Coerced to needs_more_evidence by code: an evaluation without a parsable result is not an evaluation.',
      confidence: 0,
      risk_flags: [],
      evidence_used: [],
      model_used: model,
      evaluated_at,
      stage: 'edge',
      retrievedContradictions: [],
    };
  }

  const rawVerdict = parsed.verdict;
  const rationale = isNonEmptyString(parsed.rationale) ? /** @type {string} */ (parsed.rationale).trim() : '';
  const verdictOk = isNonEmptyString(rawVerdict) && EDGE_JEV_VERDICTS.includes(/** @type {string} */ (rawVerdict));

  // THE hard rule of this phase: an evaluation without a stated, non-empty
  // reason is not an evaluation. Never pass an empty rationale through, and
  // never leave a positive verdict standing on one.
  if (!verdictOk || rationale === '') {
    const why = !verdictOk
      ? `evaluator returned ${rawVerdict === undefined ? 'no verdict' : `out-of-scope verdict "${String(rawVerdict)}"`}`
      : 'evaluator returned an empty or missing rationale';
    return {
      verdict: 'needs_more_evidence',
      rationale:
        coercedReason ??
        `Edge Pass verdict coerced by code: ${why}. A JEV evaluation requires a specific, ` +
          'non-empty rationale; without one the record cannot be accepted or flagged on the model\u2019s word alone.',
      confidence: 0,
      risk_flags: [],
      evidence_used: [],
      model_used: model,
      evaluated_at,
      stage: 'edge',
      retrievedContradictions: [],
    };
  }

  let confidence = typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence) ? parsed.confidence : 0;
  confidence = Math.min(1, Math.max(0, confidence));

  /** @type {string[]} */
  const riskFlags = Array.isArray(parsed.risk_flags)
    ? parsed.risk_flags.filter((f) => isNonEmptyString(f)).map((f) => /** @type {string} */ (f).trim())
    : [];

  return {
    verdict: /** @type {JEVVerdictValue} */ (/** @type {string} */ (rawVerdict)),
    rationale,
    confidence,
    risk_flags: riskFlags,
    evidence_used: [],
    model_used: model,
    evaluated_at,
    stage: 'edge',
    retrievedContradictions: [],
  };
}

/**
 * Create the JEV Edge Pass evaluator.
 *
 * @param {Object} options
 * @param {Readonly<Record<string, string>>} config Loaded shared config (OLLAMA_MODEL names the evaluator model).
 * @param {ReturnType<typeof import('./ollama.js').createOllamaClient>} ollama Injected Ollama client.
 * @param {ReturnType<typeof import('./qdrant.js').createQdrantClient>} qdrant Qdrant client bound to the AUTHORITATIVE DOCUMENT collection.
 * @returns {{
 *   stage: 'edge',
 *   model: string,
 *   evaluateMemory: (candidate: Memory, opts?: { evidencePack?: EvidencePack|null, retrievalFilters?: Record<string, string|string[]>, retrievalLimit?: number }) => Promise<EdgePassResult>,
 *   verdictRecord: (result: EdgePassResult, memoryId: string) => Record<string, unknown>,
 * }}
 */
export function createEdgeJev({ config, ollama, qdrant }) {
  if (ollama === null || typeof ollama !== 'object' || typeof ollama.generate !== 'function' || typeof ollama.embed !== 'function') {
    throw new TypeError('createEdgeJev requires an Ollama client with embed() and generate()');
  }
  if (qdrant === null || typeof qdrant !== 'object') {
    throw new TypeError('createEdgeJev requires a Qdrant client for the authoritative document collection');
  }
  const model = typeof config?.OLLAMA_MODEL === 'string' && config.OLLAMA_MODEL.trim() !== ''
    ? config.OLLAMA_MODEL
    : 'unknown';

  /**
   * Targeted retrieval of authoritative knowledge that may contradict the
   * candidate: Phase 2 hybrid retrieval against the authoritative document
   * collection, scoped to the candidate's asset (and subsystem when known).
   * Authoritative docs are high-confidence by construction; every hit is a
   * candidate contradiction the model must weigh. Failure here degrades to
   * "no candidates retrieved" — evaluation still runs, still local.
   * @param {Memory} candidate
   * @param {Record<string, string|string[]>|undefined} extraFilters
   * @param {number} limit
   * @returns {Promise<ContradictionCandidate[]>}
   */
  async function retrieveContradictingDocs(candidate, extraFilters, limit) {
    /** @type {Record<string, string|string[]>} */
    const filters = { ...(extraFilters ?? {}) };
    if (filters.assetId === undefined && typeof candidate.asset_id === 'string' && candidate.asset_id.trim() !== '') {
      filters.assetId = candidate.asset_id;
    }
    try {
      const pack = await retrieveEvidence(
        { embedFn: (texts) => ollama.embed(texts), qdrant },
        candidate.content,
        { limit, filters }
      );
      return pack.chunks.map((chunk) => ({
        chunkId: chunk.chunkId,
        documentId: chunk.documentId,
        source: chunk.source,
        content: chunk.content,
        similarity: chunk.score,
      }));
    } catch {
      // Retrieval is an input to evaluation, never its gate: the model can
      // still judge internal consistency and evidence sufficiency.
      return [];
    }
  }

  /**
   * Evaluate one memory candidate through the Edge Pass.
   * @param {Memory} candidate
   * @param {Object} [opts]
   * @param {EvidencePack|null} [opts.evidencePack] Evidence captured at creation time.
   * @param {Record<string, string|string[]>} [opts.retrievalFilters] Extra hard filters for the contradiction retrieval (asset is added automatically).
   * @param {number} [opts.retrievalLimit] Max authoritative chunks (default 6).
   * @returns {Promise<EdgePassResult>}
   */
  async function evaluateMemory(candidate, opts = {}) {
    const limit = typeof opts.retrievalLimit === 'number' && Number.isFinite(opts.retrievalLimit) && opts.retrievalLimit > 0
      ? Math.min(opts.retrievalLimit, MAX_AUTHORITATIVE_CHUNKS)
      : MAX_AUTHORITATIVE_CHUNKS;
    const contradictingDocs = await retrieveContradictingDocs(candidate, opts.retrievalFilters, limit);
    const prompt = buildJEVPrompt({ candidate, evidencePack: opts.evidencePack ?? null, contradictingDocs });

    let parsed = null;
    try {
      const raw = await ollama.generate(prompt);
      parsed = extractJson(raw);
    } catch (err) {
      // Ollama down / malformed transport: coerce, never throw, never block.
      return normalizeEdgeResponse(null, {
        model,
        coercedReason:
          `Edge Pass could not reach or parse the evaluator model (${/** @type {Error} */ (err).message}). ` +
          'Coerced to needs_more_evidence by code: recording is never blocked by evaluation.',
      });
    }

    const result = normalizeEdgeResponse(parsed, { model });
    // The model responds only about risk/rationale; evidence_used is stamped
    // by THIS code from what it actually showed the model (plus the pack it
    // was given), so the audit trail cannot be fabricated by the model.
    const evidenceUsed = new Set([
      ...contradictingDocs.map((d) => d.chunkId),
      ...(opts.evidencePack?.chunks ?? []).map((c) => c.chunkId),
    ]);
    return { ...result, evidence_used: [...evidenceUsed], retrievedContradictions: contradictingDocs };
  }

  /**
   * Stamp the orchestrator-owned identity onto an Edge Pass result and
   * validate it against the Phase 0 JEVVerdict contract. Throws loudly if
   * the record would violate the schema — a verdict that fails validation
   * must never be persisted.
   * @param {EdgePassResult} result
   * @param {string} memoryId
   * @returns {Record<string, unknown>} A schema-valid JEVVerdict record.
   */
  function verdictRecord(result, memoryId) {
    if (typeof memoryId !== 'string' || memoryId.trim() === '') {
      throw new TypeError('verdictRecord requires a non-empty memoryId');
    }
    const record = {
      verdict_id: `jev-${result.evaluated_at}-${Math.random().toString(36).slice(2, 10)}`,
      memory_id: memoryId,
      stage: 'edge',
      verdict: result.verdict,
      rationale: result.rationale,
      confidence: result.confidence,
      risk_flags: [...result.risk_flags],
      evidence_used: [...result.evidence_used],
      model_used: result.model_used,
      evaluated_at: result.evaluated_at,
    };
    const check = validateJEVVerdict(record);
    if (!check.valid) {
      throw new Error(`JEVVerdict failed contract validation: ${check.errors.join('; ')}`);
    }
    if (!JEV_VERDICTS.includes(record.verdict)) {
      throw new Error(`JEVVerdict carries out-of-contract verdict "${String(record.verdict)}"`);
    }
    return record;
  }

  return { stage: /** @type {'edge'} */ ('edge'), model, evaluateMemory, verdictRecord };
}
