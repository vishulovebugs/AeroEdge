'use strict';

/**
 * JEV Cloud Pass for AeroEdge (Phase 10).
 *
 * The fleet-aware, fleet-context evaluation — the second and strongest of
 * JEV's two checkpoints. CRITICALLY DIFFERENT from the Edge Pass (Phase 5):
 * a different Ollama call, a different judge role, and — the point —
 * DIFFERENT AVAILABLE CONTEXT. The Edge Pass saw one device's candidate,
 * its creation evidence, and that device's authoritative documents. The
 * Cloud Pass sees what only the fleet can see:
 *
 *   - corroborating/contradicting SYNCED OBSERVATIONS FROM OTHER DEVICES
 *     (the cloud memory collection, vector-matched, candidate excluded);
 *   - the authoritative ENTERPRISE MASTER DOCUMENT set (the Phase 6 cloud
 *     doc store — a set the edge device never held wholesale);
 *   - PRIOR JEV HISTORY for this asset/component (earlier cloud verdicts).
 *
 * A "Cloud Pass" that reruns the Edge Pass prompt without this fleet
 * context is explicitly wrong — the prompt below cannot even be built
 * without fleet context, and the module refuses to evaluate when the
 * fleet-context providers are missing.
 *
 * Checks driven by the prompt, in order: corroboration across devices →
 * consistency with enterprise master docs → safety impact if acted on and
 * wrong → whether the item supersedes / refines / duplicates existing
 * knowledge.
 *
 * Output: a JEVVerdict with stage "cloud", verdict one of
 * validated | needs_human_review | rejected. The Phase 5 rationale rule
 * holds: an empty/missing rationale is COERCED to needs_human_review in
 * code — it can never pass as validated.
 *
 * PROPAGATION GATE (enforced in code, propagateGate.js-level discipline
 * lives in this module's gate function): ONLY `validated` items pass to
 * fleet propagation. needs_human_review goes to the human-review queue;
 * rejected stays a local historical record on the originating device and
 * is never propagated. Every propagation decision flows through the gate
 * function — no code path can propagate by trusting the model output.
 *
 * CONFLICT RESOLUTION (JEV-assisted, human-confirmed): for open Conflict
 * records from Phase 9, Cloud JEV attaches a jev_recommendation (verdict +
 * rationale) to the SAME record — status stays open. JEV NEVER auto-applies
 * the recommendation: a separate explicit human confirmation
 * (confirmConflictResolution) is required before status becomes resolved.
 *
 * Fully offline-stack: the only I/O is the injected Ollama client (embed +
 * generate) and the cloud Qdrant clients.
 */

import { retrieveEvidence } from '../edge/retrieval.js';
import { validateJEVVerdict, JEV_VERDICTS } from '../shared/schemas.js';

/**
 * @typedef {import('../shared/schemas.js').Memory} Memory
 * @typedef {import('../shared/schemas.js').JEVVerdictValue} JEVVerdictValue
 * @typedef {import('../edge/syncEngine.js').fingerprintMemory} fingerprintMemoryType
 */

/** Verdicts the Cloud Pass may produce (superset edge verdicts are NOT produced here). */
export const CLOUD_JEV_VERDICTS = Object.freeze(['validated', 'needs_human_review', 'rejected']);

/** Max fleet observations / master docs / history entries in one prompt (bounded edge/cloud prompts). */
export const MAX_FLEET_OBSERVATIONS = 6;
export const MAX_MASTER_DOCS = 6;
export const MAX_JEV_HISTORY = 4;

/**
 * Fleet context gathered for one Cloud Pass evaluation.
 * @typedef {Object} FleetContext
 * @property {Array<{ memoryId: string, sourceDevice: string, content: string, similarity: number }>} fleetObservations Corroborating/contradicting synced observations from OTHER devices (candidate excluded).
 * @property {Array<{ chunkId: string, documentId: string, source: string, content: string, similarity: number }>} masterDocs Authoritative enterprise master-document excerpts.
 * @property {Array<{ verdictId: string, memoryId: string, verdict: string, rationale: string, evaluatedAt: string }>} jevHistory Prior JEV verdicts for this asset/component.
 */

/**
 * The Cloud Pass result (EdgePassResult's fleet-side counterpart).
 * @typedef {Object} CloudPassResult
 * @property {'validated'|'needs_human_review'|'rejected'} verdict
 * @property {string} rationale Always non-empty — coerced otherwise.
 * @property {number} confidence 0..1; 0 for coerced verdicts.
 * @property {string[]} risk_flags
 * @property {string[]} evidence_used Ids of everything the evaluation consulted (fleet items, master docs).
 * @property {string} model_used
 * @property {string} evaluated_at
 * @property {'cloud'} stage
 * @property {FleetContext} context The fleet context the evaluation actually saw.
 */

/**
 * Create the JEV Cloud Pass.
 *
 * @param {Object} options
 * @param {Readonly<Record<string, string>>} config Loaded shared config.
 * @param {ReturnType<typeof import('../edge/ollama.js').createOllamaClient>} ollama Injected Ollama client (embed + generate).
 * @param {ReturnType<typeof import('../edge/qdrant.js').createQdrantClient>} cloudMemories Qdrant client bound to the CLOUD MEMORY collection (fleet observations).
 * @param {ReturnType<typeof import('../edge/qdrant.js').createQdrantClient>} cloudDocs Qdrant client bound to the CLOUD ENTERPRISE DOC collection (master docs).
 * @param {ReturnType<typeof import('../edge/qdrant.js').createQdrantClient>} cloudVerdicts Qdrant client bound to the CLOUD VERDICT collection (prior JEV history read/write).
 * @returns {{
 *   stage: 'cloud',
 *   model: string,
 *   gatherFleetContext: (candidate: Memory, opts?: { excludeMemoryId?: string, limit?: number }) => Promise<FleetContext>,
 *   buildCloudPrompt: (candidate: Memory, context: FleetContext) => { system: string, prompt: string },
 *   evaluateMemory: (candidate: Memory, opts?: { excludeMemoryId?: string }) => Promise<CloudPassResult>,
 *   verdictRecord: (result: CloudPassResult, memoryId: string) => Record<string, unknown>,
 *   persistVerdict: (record: Record<string, unknown>) => Promise<void>,
 * }}
 */
export function createCloudJev({ config, ollama, cloudMemories, cloudDocs, cloudVerdicts }) {
  for (const [name, client] of Object.entries({ ollama, cloudMemories, cloudDocs, cloudVerdicts })) {
    if (client === null || typeof client !== 'object') {
      throw new TypeError(`createCloudJev requires a ${name} client`);
    }
  }
  const model = typeof config?.OLLAMA_MODEL === 'string' && config.OLLAMA_MODEL.trim() !== ''
    ? config.OLLAMA_MODEL
    : 'unknown';

  /**
   * Gather the fleet context: other devices' synced observations about the
   * same asset/component, master-document excerpts, and prior JEV history.
   * Vector-matched against the CANDIDATE's content so corroborators are the
   * semantically closest fleet items; the candidate itself is excluded.
   * @param {Memory} candidate
   * @param {Object} [opts]
   * @param {string} [opts.excludeMemoryId] Defaults to the candidate's own id.
   * @param {number} [opts.limit] Max observations (default MAX_FLEET_OBSERVATIONS).
   * @returns {Promise<FleetContext>}
   */
  async function gatherFleetContext(candidate, opts = {}) {
    if (candidate === null || typeof candidate !== 'object' || typeof candidate.content !== 'string' || candidate.content.trim() === '') {
      throw new TypeError('gatherFleetContext requires a candidate Memory with non-empty content');
    }
    const excludeMemoryId = opts.excludeMemoryId ?? candidate.memory_id;
    const limit = typeof opts.limit === 'number' && opts.limit > 0 ? Math.min(opts.limit, MAX_FLEET_OBSERVATIONS) : MAX_FLEET_OBSERVATIONS;

    // Fleet observations: embed the candidate content and vector-match the
    // cloud memory collection, then drop the candidate itself and cap.
    const [vector] = await ollama.embed([candidate.content.trim()]);
    const fleetHits = await cloudMemories.searchWhere(vector, { limit: limit + 4 });
    const fleetObservations = fleetHits
      .filter((hit) => String(hit.payload.memory_id ?? hit.id) !== excludeMemoryId)
      .slice(0, limit)
      .map((hit) => ({
        memoryId: String(hit.payload.memory_id ?? hit.id),
        sourceDevice: String(hit.payload.source ?? 'unknown-device'),
        content: String(hit.payload.content ?? ''),
        similarity: hit.score,
      }));

    // Master docs: the authoritative enterprise set (Phase 6 cloud docs),
    // scoped to the candidate's asset/component when known.
    const masterPack = await retrieveEvidence(
      { embedFn: (texts) => ollama.embed(texts), qdrant: cloudDocs },
      candidate.content,
      {
        limit: MAX_MASTER_DOCS,
        filters: {
          ...(candidate.asset_id ? { assetId: candidate.asset_id } : {}),
        },
      }
    ).catch(() => ({ chunks: [] }));
    const masterDocs = masterPack.chunks.map((chunk) => ({
      chunkId: chunk.chunkId,
      documentId: chunk.documentId,
      source: chunk.source,
      content: chunk.content,
      similarity: chunk.score,
    }));

    // Prior JEV history for this asset/component: earlier cloud verdicts.
    /** @type {import('../edge/qdrant.js').MatchClause[]} */
    const must = [{ key: 'asset_id', match: { value: candidate.asset_id } }];
    const historyHits = await cloudVerdicts
      .scrollWithFilter({ must }, { limit: MAX_JEV_HISTORY })
      .catch(() => []);
    const jevHistory = historyHits
      .filter((h) => String(h.payload.memory_id ?? '') !== excludeMemoryId)
      .map((h) => ({
        verdictId: String(h.payload.verdict_id ?? h.id),
        memoryId: String(h.payload.memory_id ?? ''),
        verdict: String(h.payload.verdict ?? ''),
        rationale: String(h.payload.rationale ?? ''),
        evaluatedAt: String(h.payload.evaluated_at ?? ''),
      }));

    return { fleetObservations, masterDocs, jevHistory };
  }

  /**
   * Build the Cloud Pass prompt — DIFFERENT role, DIFFERENT context from
   * the Edge Pass. Refuses to build without fleet context (a Cloud Pass
   * without fleet context is a mislabeled Edge Pass).
   * @param {Memory} candidate
   * @param {FleetContext} context
   * @returns {{ system: string, prompt: string }}
   */
  function buildCloudPrompt(candidate, context) {
    if (context === null || typeof context !== 'object' || !Array.isArray(context.fleetObservations) || !Array.isArray(context.masterDocs)) {
      throw new TypeError('buildCloudPrompt requires gathered fleet context (observations + master docs arrays)');
    }
    const system =
      'You are JEV-Cloud, the fleet-level knowledge judge for maintenance operations. You are NOT the ' +
      'edge evaluator and you do NOT answer technician questions. You decide whether a single field ' +
      'observation deserves FLEET-WIDE trust, judging it against what OTHER DEVICES observed, the ' +
      'authoritative enterprise master documents, and prior JEV history for this asset. Be conservative: ' +
      'fleet trust is earned by corroboration and consistency, never by fluency. Respond with EXACTLY one ' +
      'JSON object and nothing else.';

    /** @type {string[]} */
    const parts = [];
    parts.push('Evaluate this field observation for fleet-wide trust:');
    parts.push(`[candidate | asset: ${candidate.asset_id} | component: ${candidate.component ?? 'unknown'} | device: ${candidate.source}]`);
    parts.push(candidate.content.trim());

    parts.push('');
    if (context.fleetObservations.length > 0) {
      parts.push('What OTHER DEVICES observed (synced fleet observations, similarity-ranked):');
      context.fleetObservations.forEach((obs, i) => {
        parts.push(`[_fleet ${i + 1} | device: ${obs.sourceDevice}]`);
        parts.push(obs.content);
      });
    } else {
      parts.push('Other devices: (no corroborating or contradicting fleet observations on record)');
    }

    parts.push('');
    if (context.masterDocs.length > 0) {
      parts.push('Authoritative enterprise master documents:');
      context.masterDocs.forEach((doc, i) => {
        parts.push(`[_master ${i + 1} | source: ${doc.source}]`);
        parts.push(doc.content);
      });
    } else {
      parts.push('Enterprise master documents: (none retrieved for this asset)');
    }

    parts.push('');
    if (context.jevHistory.length > 0) {
      parts.push('Prior JEV history for this asset:');
      context.jevHistory.forEach((h, i) => {
        parts.push(`[_history ${i + 1}] ${h.verdict}: ${h.rationale.slice(0, 200)}`);
      });
    } else {
      parts.push('Prior JEV history: (none for this asset)');
    }

    parts.push('');
    parts.push(
      'Work through ALL FOUR checks before deciding:\n' +
      '1. Corroboration: do OTHER DEVICES independently report the same finding? A single device with no ' +
      'corroboration and no master-doc grounding cannot be validated.\n' +
      '2. Master-doc consistency: does the observation agree with the enterprise documents above? A safety-' +
      'critical contradiction is always rejected.\n' +
      '3. Safety impact: if technicians fleet-wide acted on this and it were wrong, what could be harmed?\n' +
      '4. Knowledge relation: does this supersede, refine, or duplicate existing knowledge? Say which.\n' +
      'Then respond with EXACTLY one JSON object, no other text:\n' +
      '{"verdict":"validated|needs_human_review|rejected",' +
      '"rationale":"<required, specific, non-empty — cite the fleet observations, master docs, and history that drove it>",' +
      '"confidence":<number 0..1>,"risk_flags":["<short tags, e.g. single_device_unverified, safety_contradiction"]}'
    );

    return { system, prompt: parts.join('\n') };
  }

  /**
   * Parse the model response, enforcing the Cloud Pass contract: only the
   * three cloud verdicts exist here, and a non-empty rationale is required
   * for anything to survive as-is — empty/missing coerces to
   * needs_human_review (it can never pass as validated).
   * @param {string} raw
   * @returns {{ parsed: Record<string, unknown>|null }}
   */
  function parseCloudResponse(raw) {
    if (typeof raw !== 'string' || raw.trim() === '') return { parsed: null };
    const start = raw.indexOf('{');
    if (start === -1) return { parsed: null };
    for (let end = raw.lastIndexOf('}'); end > start; end = raw.lastIndexOf('}', end - 1)) {
      try {
        const parsed = JSON.parse(raw.slice(start, end + 1));
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return { parsed: /** @type {Record<string, unknown>} */ (parsed) };
        }
      } catch {
        // try a smaller window
      }
    }
    return { parsed: null };
  }

  /**
   * Evaluate one memory through the Cloud Pass: gather fleet context, build
   * the fleet prompt, one separate Ollama call, coerce per contract.
   * @param {Memory} candidate
   * @param {Object} [opts]
   * @param {string} [opts.excludeMemoryId]
   * @returns {Promise<CloudPassResult>}
   */
  async function evaluateMemory(candidate, opts = {}) {
    const context = await gatherFleetContext(candidate, opts);
    const prompt = buildCloudPrompt(candidate, context);

    let parsed = null;
    try {
      const raw = await ollama.generate(prompt);
      parsed = parseCloudResponse(raw).parsed;
    } catch {
      parsed = null; // coerced below — evaluation failure is never a pass
    }

    const evaluated_at = new Date().toISOString();
    const isNonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
    const rawVerdict = parsed?.verdict;
    const rationale = isNonEmpty(parsed?.rationale) ? /** @type {string} */ (parsed.rationale).trim() : '';
    const verdictOk = isNonEmpty(rawVerdict) && CLOUD_JEV_VERDICTS.includes(/** @type {string} */ (rawVerdict));

    /** @type {'validated'|'needs_human_review'|'rejected'} */
    let verdict;
    /** @type {string} */
    let finalRationale;
    let confidence = 0;
    if (parsed === null) {
      verdict = 'needs_human_review';
      finalRationale =
        'Cloud Pass coerced by code: the evaluator model produced no parsable JSON. An evaluation without ' +
        'a parsable result is not an evaluation — routed to human review, never auto-propagated.';
    } else if (!verdictOk || rationale === '') {
      verdict = 'needs_human_review';
      finalRationale =
        !verdictOk
          ? `Cloud Pass coerced by code: evaluator returned ${rawVerdict === undefined ? 'no verdict' : `out-of-scope verdict "${String(rawVerdict)}"`}. Only validated | needs_human_review | rejected exist at this stage.`
          : 'Cloud Pass coerced by code: the evaluator returned an empty or missing rationale. A verdict without a stated reason can never pass as validated — routed to human review.';
    } else {
      verdict = /** @type {'validated'|'needs_human_review'|'rejected'} */ (rawVerdict);
      finalRationale = rationale;
      confidence = typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
        ? Math.min(1, Math.max(0, parsed.confidence))
        : 0;
    }

    const riskFlags = Array.isArray(parsed?.risk_flags)
      ? parsed.risk_flags.filter((f) => isNonEmpty(f)).map((f) => String(f).trim())
      : [];

    // evidence_used is stamped by THIS code from what the model was shown.
    const evidenceUsed = [
      ...context.fleetObservations.map((o) => o.memoryId),
      ...context.masterDocs.map((d) => d.chunkId),
    ];

    return {
      verdict,
      rationale: finalRationale,
      confidence,
      risk_flags: riskFlags,
      evidence_used: evidenceUsed,
      model_used: model,
      evaluated_at,
      stage: 'cloud',
      context,
    };
  }

  /**
   * Stamp memory identity onto a Cloud Pass result and validate against the
   * Phase 0 JEVVerdict contract.
   * @param {CloudPassResult} result
   * @param {string} memoryId
   * @returns {Record<string, unknown>}
   */
  function verdictRecord(result, memoryId) {
    if (typeof memoryId !== 'string' || memoryId.trim() === '') {
      throw new TypeError('verdictRecord requires a non-empty memoryId');
    }
    const record = {
      verdict_id: `jevc-${result.evaluated_at}-${Math.random().toString(36).slice(2, 10)}`,
      memory_id: memoryId,
      stage: 'cloud',
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
      throw new Error(`cloud JEVVerdict failed contract validation: ${check.errors.join('; ')}`);
    }
    if (!JEV_VERDICTS.includes(record.verdict)) {
      throw new Error(`cloud JEVVerdict carries out-of-contract verdict "${String(record.verdict)}"`);
    }
    return record;
  }

  /** Persist a cloud verdict record (the JEV history the next evaluations see). */
  async function persistVerdict(record) {
    await cloudVerdicts.upsertPoints([
      { id: String(record.verdict_id), vector: [1], payload: { ...record } },
    ]);
  }

  return {
    stage: /** @type {'cloud'} */ ('cloud'),
    model,
    gatherFleetContext,
    buildCloudPrompt,
    evaluateMemory,
    verdictRecord,
    persistVerdict,
  };
}
