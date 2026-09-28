'use strict';

/**
 * Hybrid retrieval for AeroEdge (Phase 2).
 *
 * Pure logic + one orchestrating function; ALL network/model I/O is injected
 * (embedFn talks to Ollama, qdrant is the Edge client). Pipeline shape:
 *
 *   QUERY → Semantic Search + Keyword Search + Metadata Filtering
 *         → Result Fusion → Deduplication → Ranking/Reranking → Evidence Pack
 *
 * Why each leg exists:
 *   - Semantic (embeddings): natural-language symptom queries ("actuator runs
 *     hot during retraction") where exact strings are unknown.
 *   - Keyword/exact (Qdrant match.text over chunk content + match over
 *     indexed keyword fields): error codes, part numbers, model numbers,
 *     procedure IDs, bulletin IDs. Embeddings must NOT be trusted to surface
 *     an exact string like "ERR-4212" — identifiers are matched literally.
 *   - Metadata filtering: hard constraints (asset, equipment model,
 *     subsystem, document type, version, applicability) applied as a Qdrant
 *     filter on BOTH legs, so a filtered query can never return evidence
 *     from an excluded asset/model/type.
 *
 * Fusion is Reciprocal Rank Fusion over the two ranked legs (RRF is
 * ranking-only, so incompatible score scales never mix), followed by
 * deterministic deduplication (chunkId key; highest-confidence version kept)
 * and a deterministic rerank that boosts fused, identifier-exact hits and
 * newer document versions.
 *
 * Fully offline: the only I/O is the injected embedFn and the Edge Qdrant
 * client. Nothing here knows the cloud exists.
 */

/**
 * @typedef {Object} RetrievedChunk
 * @property {string} chunkId
 * @property {string} documentId
 * @property {string} source
 * @property {string} content  // verbatim chunk content from the payload
 * @property {number} score    // final fused score (see fuseResults)
 * @property {number} [semanticScore]
 * @property {number} [keywordScore]
 * @property {string} [version]
 * @property {string} [assetId]
 * @property {string} [component]
 * @property {string} [equipmentModel]
 * @property {string} [docType]
 * @property {string[]} [applicability]
 * @property {string[]} [keywords]
 * @property {string[]} [matchedKeywords] identifier-like tokens from the query found in this chunk
 */

/**
 * @typedef {Object} EvidencePack
 * @property {string} query
 * @property {{ assetId?: string, equipmentModel?: string, component?: string, docType?: string, docVersion?: string, applicableTo?: string[] }} appliedFilters
 * @property {string[]} exactTerms identifier-like tokens the query leg matched on
 * @property {RetrievedChunk[]} chunks deduped, reranked evidence (best first)
 */

/**
 * Metadata filter options. Omitted/undefined = no constraint on that field.
 * @typedef {Object} RetrievalFilters
 * @property {string} [assetId]
 * @property {string} [equipmentModel]
 * @property {string} [component]
 * @property {string} [docType]
 * @property {string} [docVersion]
 * @property {string[]} [applicableTo] point must list at least one of these (chunk with none passes)
 */

/** Keys/prefixes where identifiers live in queries (error codes, part numbers...). */
const IDENTIFIER_HINT_RE =
  /\b(?:err(?:or)?|code|pn|p\/n|part|mpn|msg|fault|fail|procedure|proc|bulletin|sb|ad|tid|doc|docid|manual|amm|cmm|ipc|rev|step|assembly|assy)\b[-.:_ ]*\s*([a-z0-9][a-z0-9-]*)/gi;

/**
 * An "identifier-like" token: enough digits or distinctive symbols that it
 * is meant to be matched literally, e.g. ZX-99Q, 88-42B, ERR-4212, PN 622-4901-201.
 * Plain words and hex-hash-like noise are excluded.
 * @param {string} token
 * @returns {boolean}
 */
function isIdentifierLike(token) {
  if (token.length < 3) return false;
  const digits = (token.match(/\d/g) ?? []).length;
  const hasDistinctive = /[A-Z]/.test(token) && digits >= 1; // mixed-case alphanumerics
  const letterDigitMix = /[a-z]/i.test(token) && digits >= 1 && /[-_./]/.test(token);
  const longCode = digits >= 3 && token.length >= 5; // e.g. 4212, 8842B
  return hasDistinctive || letterDigitMix || longCode;
}

/** Split a query into word tokens (identifier-friendly charset). */
const TOKEN_RE = /[A-Za-z0-9][A-Za-z0-9._/-]*/g;

/**
 * Extract identifier-like tokens to match EXACTLY during retrieval.
 * Order preserved, no duplicates, length >= 3.
 * @param {string} query
 * @returns {string[]}
 */
export function extractExactTerms(query) {
  if (typeof query !== 'string' || query.trim() === '') {
    throw new TypeError('extractExactTerms requires a non-empty query');
  }
  /** @type {Set<string>} */
  const found = new Set();
  for (const m of query.matchAll(TOKEN_RE)) {
    const token = m[0].replace(/[.,;:]+$/, '');
    if (token.length >= 3 && isIdentifierLike(token)) found.add(token);
  }
  // Hinted identifiers ("error 4212", "PN ZX-99Q") even when the bare token
  // alone did not look identifier-like. Hinted captures must contain a digit
  // so prose ("part of the pump") never becomes an exact term.
  for (const m of query.matchAll(IDENTIFIER_HINT_RE)) {
    const token = (m[1] ?? '').replace(/[.,;:]+$/, '');
    // Skip hinted tokens subsumed by an already-found term ("ERR-4212" also
    // hints "4212"; the full code is the exact term, the suffix is noise).
    if (
      token.length >= 2 &&
      /\d/.test(token) &&
      ![...found].some((t) => t.toLowerCase().includes(token.toLowerCase()))
    ) {
      found.add(token);
    }
  }
  return [...found];
}

/**
 * Build a Qdrant payload filter from retrieval filters. Unknown keys are
 * rejected (fail loudly rather than silently ignoring a constraint).
 * @param {RetrievalFilters} [filters]
 * @returns {import('./qdrant.js').QdrantFilter | undefined} undefined = no constraint.
 */
export function buildMetadataFilter(filters) {
  if (filters === undefined) return undefined;
  const allowed = ['assetId', 'equipmentModel', 'component', 'docType', 'docVersion', 'applicableTo'];
  for (const key of Object.keys(filters)) {
    if (!allowed.includes(key)) {
      throw new TypeError(`buildMetadataFilter: unknown filter field "${key}" (allowed: ${allowed.join(', ')})`);
    }
  }
  /** @type {import('./qdrant.js').MatchClause[]} */
  const must = [];
  if (filters.assetId !== undefined) must.push({ key: 'asset_id', match: { value: filters.assetId } });
  if (filters.equipmentModel !== undefined) must.push({ key: 'equipment_model', match: { value: filters.equipmentModel } });
  if (filters.component !== undefined) must.push({ key: 'component', match: { value: filters.component } });
  if (filters.docType !== undefined) must.push({ key: 'doc_type', match: { value: filters.docType } });
  if (filters.docVersion !== undefined) must.push({ key: 'version', match: { value: filters.docVersion } });
  if (filters.applicableTo !== undefined && filters.applicableTo.length > 0) {
    must.push({ key: 'applicability', match: { any: [...filters.applicableTo] } });
  }
  return must.length > 0 ? { must } : undefined;
}

/**
 * One match record from a single retrieval leg.
 * @typedef {Object} LegMatch
 * @property {string} chunkId Qdrant point id (dedup key across legs).
 * @property {Record<string, unknown>} payload Full Qdrant payload.
 * @property {number} rank 0-based rank within this leg (best = 0).
 * @property {'semantic'|'keyword'} leg Which ranked list this came from.
 */

/**
 * Reciprocal Rank Fusion over the semantic and keyword ranked lists.
 *
 * score(d) = Σ_legs weight_leg / (RRF_K + rank_leg + 1)
 *
 * Ties break deterministically: higher semanticScore, then lexicographic
 * chunkId — same inputs always produce the same order.
 *
 * @param {LegMatch[]} semantic
 * @param {LegMatch[]} keyword
 * @param {Object} [opts]
 * @param {number} [opts.k] RRF constant (default 60, standard from the literature).
 * @param {number} [opts.semanticWeight]
 * @param {number} [opts.keywordWeight]
 * @returns {Array<{ chunkId: string, payload: Record<string, unknown>, score: number, semanticScore?: number, keywordScore?: number }>}
 */
export function fuseResults(semantic, keyword, { k = 60, semanticWeight = 1, keywordWeight = 1 } = {}) {
  for (const [name, list] of [['semantic', semantic], ['keyword', keyword]]) {
    if (!Array.isArray(list)) throw new TypeError(`fuseResults: ${name} must be an array`);
    list.forEach((m, i) => {
      if (typeof m?.chunkId !== 'string' || m.chunkId === '') {
        throw new TypeError(`fuseResults: ${name}[${i}] is missing a non-empty chunkId`);
      }
      if (typeof m?.rank !== 'number' || !Number.isInteger(m.rank) || m.rank < 0) {
        throw new TypeError(`fuseResults: ${name}[${i}].rank must be a non-negative integer`);
      }
    });
  }
  /** @type {Map<string, { payload: Record<string, unknown>, score: number, semanticScore?: number, keywordScore?: number }>} */
  const acc = new Map();
  for (const leg of [[semantic, semanticWeight, 'semanticScore'], [keyword, keywordWeight, 'keywordScore']]) {
    const list = /** @type {LegMatch[]} */ (leg[0]);
    const weight = /** @type {number} */ (leg[1]);
    const scoreKey = /** @type {'semanticScore'|'keywordScore'} */ (leg[2]);
    list.forEach((m) => {
      const contribution = weight / (k + m.rank + 1);
      const existing = acc.get(m.chunkId);
      if (existing) {
        existing.score += contribution;
        existing[scoreKey] = m.rank; // this leg's 0-based rank
      } else {
        acc.set(m.chunkId, {
          chunkId: m.chunkId,
          payload: m.payload,
          score: contribution,
          [scoreKey]: m.rank,
        });
      }
    });
  }
  return [...acc.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const semA = a.semanticScore ?? Number.POSITIVE_INFINITY;
    const semB = b.semanticScore ?? Number.POSITIVE_INFINITY;
    if (semA !== semB) return semA - semB;
    return a.chunkId < b.chunkId ? -1 : a.chunkId === b.chunkId ? 0 : 1;
  }).map((e) => Object.freeze({ ...e }));
}

/**
 * Deduplicate fused results by chunkId, keeping the highest-confidence
 * version of each chunk. "Confidence" for a chunk is the best score any
 * input occurrence carries; exact duplicate chunkIds compare score, then
 * document version (newer wins), then insertion order (stable). Output
 * preserves the highest-confidence occurrence's order position (earliest
 * best occurrence wins ties, so ordering stays deterministic).
 *
 * Accepts the raw per-leg hit shape ({ id, payload, score }) produced by
 * the qdrant client as well as pre-fused items ({ chunkId, ... }).
 *
 * @template T
 * @param {Array<T & { chunkId?: string, id?: string, payload: Record<string, unknown>, score: number, semanticScore?: number, keywordScore?: number, version?: string }>} results
 * @returns {T[]}
 */
export function dedupeResults(results) {
  if (!Array.isArray(results)) throw new TypeError('dedupeResults requires an array');
  /** @type {Map<string, { item: any, firstIndex: number }>} */
  const best = new Map();
  results.forEach((item, index) => {
    const chunkId = String(item.chunkId ?? item.id ?? '');
    if (chunkId === '') {
      throw new TypeError(`dedupeResults: results[${index}] has no chunkId/id`);
    }
    const version = String(item.payload?.version ?? item.version ?? '');
    const existing = best.get(chunkId);
    if (!existing) {
      best.set(chunkId, { item, firstIndex: index });
      return;
    }
    const curScore = Number(item.score) || 0;
    const prev = existing.item;
    const prevScore = Number(prev.score) || 0;
    const prevVersion = String(prev.payload?.version ?? prev.version ?? '');
    let takeNew;
    if (curScore !== prevScore) takeNew = curScore > prevScore;
    else if (version !== prevVersion) takeNew = version > prevVersion; // "10" > "9" lexically on padded or single digits; documented limitation
    else takeNew = false; // exact tie: keep the earlier occurrence (stable)
    if (takeNew) best.set(chunkId, { item, firstIndex: existing.firstIndex });
  });
  return [...best.values()]
    .sort((a, b) => a.firstIndex - b.firstIndex)
    .map((e) => e.item);
}

/**
 * Rerank deduped candidates into a final evidence ordering. The base RRF
 * score is preserved as `score` (fusion stays auditable); the rerank applies
 * deterministic, explainable boosts on top:
 *   +0.25 identifier-exact: an extracted exact term appears in the chunk
 *        content or its indexed keywords (this is what makes ERR-4212 beat
 *        a fluent but wrong paraphrase);
 *   +0.15 both legs agree (retrieved by semantic AND keyword);
 *   +0.10 newest document version among candidates (local tiebreaker).
 *
 * @template T
 * @param {T & { score: number, semanticScore?: number, keywordScore?: number, payload?: Record<string, unknown> }} item
 * @param {Object} [opts]
 * @param {string[]} [opts.exactTerms] identifier-like tokens extracted from the query
 * @param {string} [opts.maxVersion] all-candidates maximum document version (internal)
 * @returns {{ item: T, boosts: { identifierExact: boolean, bothLegs: boolean, newestVersion: boolean }, finalScore: number }}
 */
function rerankItem(item, { exactTerms = [], maxVersion } = {}) {
  const haystacks = [
    String(item.payload?.content ?? ''),
    ...(Array.isArray(item.payload?.keywords) ? item.payload.keywords.map(String) : []),
    ...(Array.isArray(item.keywords) ? item.keywords.map(String) : []),
  ].map((s) => s.toLowerCase());
  const identifierExact = exactTerms.some((term) =>
    haystacks.some((h) => h.includes(term.toLowerCase()))
  );
  const bothLegs = item.semanticScore !== undefined && item.keywordScore !== undefined;
  const version = String(item.payload?.version ?? item.version ?? '');
  const newestVersion = maxVersion !== undefined && version !== '' && version === maxVersion;
  const boosts = {
    identifierExact,
    bothLegs,
    newestVersion,
  };
  const finalScore =
    (Number(item.score) || 0) +
    (identifierExact ? 0.25 : 0) +
    (bothLegs ? 0.15 : 0) +
    (newestVersion ? 0.10 : 0);
  return { item, boosts, finalScore };
}

/**
 * Rerank a deduped list (see rerankItem for the boost schedule). Ties break
 * on finalScore desc, then semanticScore asc (better semantic rank first),
 * then lexicographic chunkId — fully deterministic.
 * @template T
 * @param {T[]} items
 * @param {{ exactTerms?: string[] }} [opts]
 * @returns {T[]}
 */
export function rerank(items, { exactTerms = [] } = {}) {
  if (!Array.isArray(items)) throw new TypeError('rerank requires an array');
  const versions = items.map((it) => String(it?.payload?.version ?? it?.version ?? '')).filter((v) => v !== '');
  const maxVersion = versions.length > 0 ? versions.reduce((a, b) => (a > b ? a : b)) : undefined;
  return items
    .map((item) => rerankItem(item, { exactTerms, maxVersion }))
    .sort((a, b) => {
      if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
      const semA = a.item.semanticScore ?? Number.POSITIVE_INFINITY;
      const semB = b.item.semanticScore ?? Number.POSITIVE_INFINITY;
      if (semA !== semB) return semA - semB;
      return a.item.chunkId < b.item.chunkId ? -1 : a.item.chunkId === b.item.chunkId ? 0 : 1;
    })
    .map((e) => e.item);
}

/**
 * Run hybrid retrieval and build the evidence pack. Legs:
 *   1. metadata filter built from `filters` (hard constraint on both legs);
 *   2. semantic leg — filtered vector search with the query embedding;
 *   3. keyword leg — (a) filtered scroll for exact identifier matches
 *      (chunk content and/or indexed keywords), (b) filtered vector search
 *      when no identifiers were extracted (natural-language keyword leg is
 *      handled by fusing the semantic list with itself weighted down — the
 *      fusion still dedups and ranks deterministically);
 *   4. fuse → dedupe → rerank → evidence pack with verbatim content.
 *
 * @param {Object} deps Injected I/O (no direct imports: this stays unit-testable offline).
 * @param {(texts: string[]) => Promise<number[][]>} deps.embedFn Ollama embedder (same model/space as ingestion).
 * @param {import('./qdrant.js').QdrantClient} deps.qdrant Edge Qdrant client.
 * @param {string} query The technician's question/lookup.
 * @param {Object} [opts]
 * @param {number} [opts.limit] Final evidence-pack size (default 4).
 * @param {RetrievalFilters} [opts.filters] Hard metadata constraints.
 * @param {number} [opts.perLeg] How many hits each leg fetches before fusion.
 * @returns {Promise<EvidencePack>}
 */
export async function retrieveEvidence(deps, query, opts = {}) {
  if (typeof query !== 'string' || query.trim() === '') {
    throw new TypeError('retrieveEvidence requires a non-empty query');
  }
  const { limit = 4, filters, perLeg = Math.max(limit * 3, 12) } = opts;
  const trimmed = query.trim();
  const exactTerms = extractExactTerms(trimmed);
  const filter = buildMetadataFilter(filters);

  // Leg 1 (semantic): one embedding for the query — same embed path/model as ingestion.
  const [queryVector] = await deps.embedFn([trimmed]);
  const semanticHits = await deps.qdrant.searchWhere(queryVector, { limit: perLeg, filter });

  // Leg 2 (keyword/exact): scroll for identifier matches; fall back to a
  // second vector pass only when the query carries NO identifiers.
  /** @type {LegMatch[]} */
  let keywordMatches = [];
  if (exactTerms.length > 0) {
    const filterWithTerms = {
      ...filter,
      should: [
        { key: 'content', match: { text: exactTerms.join(' ') } },
        { key: 'keywords', match: { text: exactTerms.join(' ') } },
      ],
    };
    const kwHits = await deps.qdrant.scrollWithFilter(filterWithTerms, { limit: perLeg });
    // Qdrant match.text is all-tokens-across-terms; keep only chunks that
    // actually contain at least ONE extracted term (exact-or-nothing).
    keywordMatches = kwHits
      .filter((hit) => {
        const content = String(hit.payload.content ?? '').toLowerCase();
        const keywords = Array.isArray(hit.payload.keywords)
          ? hit.payload.keywords.map((k) => String(k).toLowerCase())
          : [];
        return exactTerms.some(
          (term) => content.includes(term.toLowerCase()) || keywords.some((k) => k.includes(term.toLowerCase()))
        );
      })
      .map((hit, rank) => ({ chunkId: hit.id, payload: hit.payload, rank, leg: /** @type {'keyword'} */ ('keyword') }));
  } else {
    // No identifiers: the "keyword" leg degenerates to a low-weight second
    // opinion from the same embedding space. Fusion still dedups and the
    // semantic leg keeps its usual weight, so ordering is stable.
    const kwHits = await deps.qdrant.searchWhere(queryVector, { limit: perLeg, filter });
    keywordMatches = kwHits.map((hit, rank) => ({ chunkId: hit.id, payload: hit.payload, rank, leg: /** @type {'keyword'} */ ('keyword') }));
  }

  const semanticMatches = semanticHits.map((hit, rank) => ({
    chunkId: hit.id,
    payload: hit.payload,
    rank,
    leg: /** @type {'semantic'} */ ('semantic'),
  }));

  const fused = fuseResults(semanticMatches, keywordMatches, { semanticWeight: 1, keywordWeight: exactTerms.length > 0 ? 1.2 : 0.4 });
  const deduped = dedupeResults(fused);
  const reranked = rerank(deduped, { exactTerms }).slice(0, limit);

  /** @type {RetrievedChunk[]} */
  const chunks = reranked.map((item) => ({
    chunkId: String(item.chunkId),
    documentId: String(item.payload?.document_id ?? ''),
    source: String(item.payload?.source ?? ''),
    content: String(item.payload?.content ?? ''), // verbatim, never rewritten
    score: Number(item.score.toFixed(6)),
    semanticScore: item.semanticScore,
    keywordScore: item.keywordScore,
    version: item.payload?.version !== undefined ? String(item.payload.version) : undefined,
    assetId: item.payload?.asset_id !== undefined ? String(item.payload.asset_id) : undefined,
    component: item.payload?.component !== undefined ? String(item.payload.component) : undefined,
    equipmentModel: item.payload?.equipment_model !== undefined ? String(item.payload.equipment_model) : undefined,
    docType: item.payload?.doc_type !== undefined ? String(item.payload.doc_type) : undefined,
    applicability: Array.isArray(item.payload?.applicability)
      ? item.payload.applicability.map(String)
      : undefined,
    keywords: Array.isArray(item.payload?.keywords) ? item.payload.keywords.map(String) : undefined,
    matchedKeywords: exactTerms.filter((term) => {
      const content = String(item.payload?.content ?? '').toLowerCase();
      const keywords = Array.isArray(item.payload?.keywords)
        ? item.payload.keywords.map((k) => String(k).toLowerCase())
        : [];
      return content.includes(term.toLowerCase()) || keywords.some((k) => k.includes(term.toLowerCase()));
    }),
  }));

  return {
    query: trimmed,
    appliedFilters: {
      ...(filters ?? {}),
    },
    exactTerms,
    chunks,
  };
}
