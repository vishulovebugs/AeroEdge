'use strict';

/**
 * Contextual / session memory for AeroEdge (Phase 3).
 *
 * A diagnostic session is the technician's working context: which asset they
 * are on, which subsystem the fault is in, what the issue is, what has been
 * asked and found so far. This module owns that state and the TWO controlled
 * ways it touches the query path — nothing else reads or writes it:
 *
 *   1. QUERY EXPANSION: context-dependent follow-ups ("what about the
 *      sensor?") are expanded with the session's current asset/subsystem so
 *      hybrid retrieval (Phase 2) sees a self-contained query.
 *   2. CONTEXT INJECTION: a COMPACT, budgeted summary of the session is
 *      built for the generation prompt — never the raw conversation.
 *
 * Pure logic only: no I/O, no model calls, fully deterministic, offline.
 * The session is deliberately NOT persisted to Qdrant and has no lifecycle
 * states — the memory orchestrator is a later phase. This is working state
 * for one diagnostic conversation on one device.
 */

import { randomUUID } from 'node:crypto';

/** Recent queries kept in full in the session state. */
export const MAX_RECENT_QUERIES = 10;
/** Technician observations mirrored into the session (written by Phase 4). */
export const MAX_SESSION_OBSERVATIONS = 20;
/** Recent retrieved chunks kept as session evidence context. */
export const MAX_RECENT_EVIDENCE = 3;
/** Hard character budget for the injected context summary. */
export const SUMMARY_MAX_CHARS = 700;
/** History size above which the summary switches to compact/recent mode. */
export const HISTORY_THRESHOLD_CHARS = 600;

/**
 * One turn of the diagnostic conversation.
 * @typedef {Object} SessionTurn
 * @property {string} query The technician's query, verbatim (trimmed).
 * @property {string} askedAt ISO timestamp of the turn.
 */

/**
 * Session state object. Fields the technician or pipeline has not
 * established yet are null (not empty strings) so "unset" is explicit.
 * @typedef {Object} SessionState
 * @property {string} sessionId
 * @property {string|null} assetId Current asset under diagnosis.
 * @property {string|null} equipmentModel Current equipment model, when known.
 * @property {string|null} component Current subsystem (hydraulics, sensor...).
 * @property {string|null} issue Current issue being diagnosed.
 * @property {SessionTurn[]} recentQueries Newest LAST, bounded by MAX_RECENT_QUERIES.
 * @property {{ chunkId: string, documentId: string, source: string, content: string }[]} recentEvidence
 *           Newest LAST, bounded by MAX_RECENT_EVIDENCE (bounded content copies).
 * @property {string[]} actionsTaken Actions the technician says they already did.
 * @property {{ memoryId: string, content: string, notedAt: string }[]} observations
 *           Technician observations recorded through the Phase 4 memory
 *           orchestrator during this session ("technician observations so
 *           far"). Newest LAST, bounded by MAX_SESSION_OBSERVATIONS.
 * @property {string} startedAt
 * @property {string} lastActiveAt
 */

/**
 * Create an empty session (optionally seeded with the initial context).
 * @param {Object} [seed]
 * @param {string} [seed.assetId]
 * @param {string} [seed.equipmentModel]
 * @param {string} [seed.component]
 * @param {string} [seed.issue]
 * @returns {SessionState}
 */
export function createSession(seed = {}) {
  const now = new Date().toISOString();
  for (const key of ['assetId', 'equipmentModel', 'component', 'issue']) {
    const value = seed[key];
    if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) {
      throw new TypeError(`createSession: "${key}" must be a non-empty string when provided`);
    }
  }
  return {
    sessionId: `ses-${randomUUID()}`,
    assetId: seed.assetId?.trim() ?? null,
    equipmentModel: seed.equipmentModel?.trim() ?? null,
    component: seed.component !== undefined ? canonicalSubsystem(seed.component) : null,
    issue: seed.issue?.trim() ?? null,
    recentQueries: [],
    recentEvidence: [],
    actionsTaken: [],
    observations: [],
    startedAt: now,
    lastActiveAt: now,
  };
}

/** Subsystem words worth carrying across turns (lowercase in state). */
const SUBSYSTEM_WORD_RE =
  /\b(hydraulics?|fuel system|electrical|avionics|landing gear|oxygen|pneumatics?|cooling|lubrication|navigation|pressurization|sensor|actuator|pump|valve|filter)\b/gi;

/**
 * Asset ids are only extracted from explicit designations ("asset A320-201",
 * "aircraft MSN 4453") — never from arbitrary code-like tokens, which are
 * usually part numbers and would poison the metadata filter.
 */
const ASSET_DESIGNATION_RE =
  /\b(?:asset|aircraft|vehicle|unit|truck|rig|airframe)\s+(?:id\s+)?([A-Za-z0-9][A-Za-z0-9-]{2,})/i;
const MSN_DESIGNATION_RE = /\bMSN\s?(\d{3,})\b/i;

/**
 * "Actions already taken" lead-ins ("we already replaced the filter"). The
 * object phrase is captured lazily up to a conjunction, punctuation, or end
 * of string, so "replaced the filter and reset the breaker" yields TWO
 * actions ("and reset the breaker" is re-scanned as its own action).
 */
const ACTION_LEAD_RE =
  /\b(?:already\s+)?(replaced|swapped|reset|cleaned|inspected|torqued|checked|removed|installed|reinstalled|tightened|lubricated)\b\s+([^.,;!?]*?)(?=\s+and\s+|[,;!?]|$)/gi;

/**
 * Record a technician query into the session, extracting current
 * asset/subsystem/issue when the query establishes or changes them.
 *
 * A NEW asset/subsystem value replaces the old one (the technician moved on);
 * the SAME value merely refreshes lastActiveAt. Returns true when a
 * substantive session field was set or changed by this query.
 *
 * @param {SessionState} state Mutated in place.
 * @param {string} query
 * @returns {boolean} true when asset/component/issue changed.
 */
export function updateSessionFromQuery(state, query) {
  if (typeof query !== 'string' || query.trim() === '') {
    throw new TypeError('updateSessionFromQuery requires a non-empty query');
  }
  const trimmed = query.trim();
  const now = new Date().toISOString();
  state.lastActiveAt = now;
  state.recentQueries.push({ query: trimmed, askedAt: now });
  if (state.recentQueries.length > MAX_RECENT_QUERIES) {
    state.recentQueries.splice(0, state.recentQueries.length - MAX_RECENT_QUERIES);
  }

  let changed = false;

  const msn = trimmed.match(MSN_DESIGNATION_RE);
  const assetMatch = trimmed.match(ASSET_DESIGNATION_RE);
  const extractedAsset = msn ? `MSN${msn[1]}` : assetMatch ? assetMatch[1].trim() : null;
  if (extractedAsset !== null && extractedAsset !== state.assetId) {
    state.assetId = extractedAsset;
    changed = true;
  }

  const subsystemMatch = [...trimmed.matchAll(SUBSYSTEM_WORD_RE)][0];
  if (subsystemMatch) {
    const subsystem = canonicalSubsystem(subsystemMatch[1]);
    if (subsystem !== state.component) {
      state.component = subsystem;
      changed = true;
    }
  }

  return changed;
}

/**
 * Record the evidence a turn retrieved into the session (bounded copies —
 * content is truncated when stored so the session can never grow without
 * bound even over very long sessions).
 * @param {SessionState} state Mutated in place.
 * @param {{ chunks: Array<{ chunkId: string, documentId: string, source: string, content: string }> }} evidence Evidence pack (Phase 2 shape).
 */
export function updateSessionFromEvidence(state, evidence) {
  if (evidence === null || typeof evidence !== 'object' || !Array.isArray(evidence.chunks)) {
    throw new TypeError('updateSessionFromEvidence requires an evidence pack with a chunks array');
  }
  for (const chunk of evidence.chunks.slice(0, MAX_RECENT_EVIDENCE)) {
    state.recentEvidence.push({
      chunkId: String(chunk.chunkId),
      documentId: String(chunk.documentId),
      source: String(chunk.source),
      content: String(chunk.content).slice(0, 200),
    });
  }
  if (state.recentEvidence.length > MAX_RECENT_EVIDENCE) {
    state.recentEvidence.splice(0, state.recentEvidence.length - MAX_RECENT_EVIDENCE);
  }
  // If the session has no subsystem yet, borrow the component from the best
  // evidence hit (a follow-up about "the sensor" lands on sensor documents).
  if (state.component === null && evidence.chunks.length > 0) {
    const comp = evidence.chunks[0].component;
    if (typeof comp === 'string' && comp.trim() !== '') state.component = canonicalSubsystem(comp);
  }
}

/**
 * Canonicalize a subsystem word so plural/singular phrasing does not
 * flip-flop the session state ("hydraulics" and "hydraulic" are the same
 * subsystem). This is a canonical KEY, not display prose.
 * @param {string} raw
 * @returns {string}
 */
function canonicalSubsystem(raw) {
  const w = raw.toLowerCase().trim();
  return w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w;
}

/**
 * Record an action the technician reports as already taken ("we already
 * replaced the filter" → actionsTaken). The action key is the verb plus the
 * first words of the object phrase ("replaced the filter yesterday" dedupes
 * against "replaced the filter"). Deduplicated, bounded to 10.
 * @param {SessionState} state Mutated in place.
 * @param {string} text Technician text (query or observation).
 * @returns {string[]} Actions added by this call (may be empty).
 */
export function recordActionsTaken(state, text) {
  if (typeof text !== 'string') {
    throw new TypeError('recordActionsTaken requires a string');
  }
  const added = [];
  for (const match of text.matchAll(ACTION_LEAD_RE)) {
    const object = match[2].trim().toLowerCase().split(/\s+/).slice(0, 2).join(' ');
    if (object === '') continue;
    const action = `${match[1].toLowerCase()} ${object}`;
    if (!state.actionsTaken.includes(action)) {
      state.actionsTaken.push(action);
      added.push(action);
    }
  }
  if (state.actionsTaken.length > 10) {
    state.actionsTaken.splice(0, state.actionsTaken.length - 10);
  }
  return added;
}

/** Pronouns and elliptical references that make a query context-dependent. */
const DEICTIC_RE =
  /\b(it|its|this|that|these|those|the\s+same|same|also|again|still|there|their)\b|\babout (?:the|that|this)\b|\bother\b/i;

/** Stop-tokens never worth expanding a query with. */
const EXPANSION_STOP = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'is', 'are']);

/**
 * Decide whether a query is context-dependent (needs session context to
 * resolve). Short elliptical queries and ones carrying pronouns are; fully
 * specified queries ("What torque applies to the B-nut on aircraft MSN4453?")
 * are not.
 * @param {string} query
 * @param {SessionState} state
 * @returns {boolean}
 */
export function isContextDependent(query, state) {
  const trimmed = query.trim();
  if (trimmed === '') return false;
  const wordCount = (trimmed.match(/[A-Za-z0-9][A-Za-z0-9-]*/g) ?? []).length;
  if (wordCount <= 6) return true; // short follow-ups are almost always elliptical
  return DEICTIC_RE.test(trimmed);
}

/**
 * Expand a context-dependent query with the session's current asset and
 * subsystem so hybrid retrieval sees a self-contained query. Only terms that
 * are not already present (case-insensitive, word-bounded) are appended.
 *
 * @param {string} query
 * @param {SessionState} state
 * @returns {{ query: string, usedSession: boolean }} `usedSession` is false
 *          when the query was already self-contained or the session had
 *          nothing to add.
 */
export function expandQuery(query, state) {
  if (typeof query !== 'string' || query.trim() === '') {
    throw new TypeError('expandQuery requires a non-empty query');
  }
  const trimmed = query.trim();
  if (!isContextDependent(trimmed, state)) {
    return { query: trimmed, usedSession: false };
  }
  const lower = trimmed.toLowerCase();
  const hasTerm = (term) => {
    if (term === null || term === '') return true; // nothing to add, do not flip usedSession
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i').test(lower);
  };
  /** @type {string[]} */
  const additions = [];
  for (const term of [state.component, state.assetId]) {
    if (term !== null && !hasTerm(term) && !EXPANSION_STOP.has(term.toLowerCase())) {
      additions.push(term);
    }
  }
  if (additions.length === 0) {
    return { query: trimmed, usedSession: false };
  }
  return { query: `${trimmed} (${additions.join(', ')})`, usedSession: true };
}

/**
 * Build the COMPACT context summary injected into the generation prompt.
 *
 * Contract (tested): the output is a bounded summary of the session state —
 * current asset/subsystem/issue, a bounded list of RECENT queries, and
 * bounded evidence references — never the concatenated raw conversation.
 * Under the history threshold every recent query is listed; above it, older
 * turns collapse into a "+N earlier" marker and evidence lines truncate, so
 * the summary stays within SUMMARY_MAX_CHARS for arbitrarily long sessions.
 *
 * @param {SessionState} state
 * @param {{ maxChars?: number }} [opts]
 * @returns {string} '' when the session has no context worth injecting.
 */
export function buildSessionSummary(state, { maxChars = SUMMARY_MAX_CHARS } = {}) {
  if (state === null || typeof state !== 'object') {
    throw new TypeError('buildSessionSummary requires a session state object');
  }
  const hasContext =
    state.assetId !== null ||
    state.equipmentModel !== null ||
    state.component !== null ||
    state.issue !== null ||
    state.actionsTaken.length > 0 ||
    (Array.isArray(state.observations) && state.observations.length > 0) ||
    state.recentQueries.length > 0 ||
    state.recentEvidence.length > 0;
  if (!hasContext) return '';

  const lines = [];
  lines.push('Diagnostic session context (working memory, summarized):');
  lines.push(`- Asset: ${state.assetId ?? 'unspecified'} | Subsystem: ${state.component ?? 'unspecified'}`);
  if (state.equipmentModel !== null) lines.push(`- Equipment model: ${state.equipmentModel}`);
  if (state.issue !== null) lines.push(`- Current issue: ${state.issue}`);
  if (state.actionsTaken.length > 0) {
    lines.push(`- Actions already taken: ${state.actionsTaken.slice(-3).join('; ')}`);
  }
  if (Array.isArray(state.observations) && state.observations.length > 0) {
    lines.push('- Technician observations so far:');
    for (const obs of state.observations.slice(-3)) {
      lines.push(`  * ${obs.content}`);
    }
  }

  const historyChars = state.recentQueries.reduce((sum, t) => sum + t.query.length, 0);
  const compact = historyChars > HISTORY_THRESHOLD_CHARS;

  if (state.recentQueries.length > 0) {
    const turns = compact ? state.recentQueries.slice(-3) : state.recentQueries;
    const omitted = state.recentQueries.length - turns.length;
    lines.push('- Recent queries:');
    for (const turn of turns) {
      lines.push(`  * ${turn.query}`);
    }
    if (omitted > 0) lines.push(`  * (+${omitted} earlier queries omitted)`);
  }

  if (state.recentEvidence.length > 0) {
    lines.push('- Recent evidence consulted:');
    for (const ev of state.recentEvidence) {
      const content = compact ? ev.content.slice(0, 140) : ev.content;
      lines.push(`  * ${ev.source} (${ev.documentId}): ${content}${content.length < ev.content.length ? '…' : ''}`);
    }
  }

  let summary = lines.join('\n');
  const hardCap = Math.max(200, maxChars);
  if (summary.length > hardCap) {
    // Deterministic truncation with an explicit marker: the prompt always
    // knows when it is looking at an abridged session.
    summary = `${summary.slice(0, hardCap - 3).trimEnd()}…`;
  }
  return summary;
}

/**
 * Extract an EXPLICIT asset designation from free text ("aircraft MSN4453",
 * "asset rig-07"), or null when the text names no asset. Used so a query
 * that explicitly names a different asset than the session overrides the
 * session's suggested filter (explicit context beats stale session state).
 * @param {string} text
 * @returns {string|null}
 */
export function extractAssetId(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  const msn = text.match(MSN_DESIGNATION_RE);
  if (msn) return `MSN${msn[1]}`;
  const assetMatch = text.match(ASSET_DESIGNATION_RE);
  return assetMatch ? assetMatch[1].trim() : null;
}

/**
 * Metadata filters the session suggests for retrieval — ONLY for fields that
 * are hard, well-formed identifiers (asset id, equipment model). Subsystem
 * words are deliberately excluded: they are too coarse for exact match
 * filtering and would over-restrict hybrid retrieval.
 * @param {SessionState} state
 * @returns {{ filters?: { assetId?: string, equipmentModel?: string } }} undefined filters = no suggestion.
 */
export function suggestSessionFilters(state) {
  if (state === null || typeof state !== 'object') {
    throw new TypeError('suggestSessionFilters requires a session state object');
  }
  /** @type {{ assetId?: string, equipmentModel?: string }} */
  const filters = {};
  if (state.assetId !== null) filters.assetId = state.assetId;
  if (state.equipmentModel !== null) filters.equipmentModel = state.equipmentModel;
  return Object.keys(filters).length > 0 ? { filters } : {};
}
