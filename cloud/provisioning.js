'use strict';

/**
 * Edge Provisioning for AeroEdge (Phase 7).
 *
 * An edge device gets ONLY the knowledge relevant to it — not the whole
 * enterprise database. One composed pipeline, cloud → edge:
 *
 *   CLOUD → determine relevant knowledge → filter by asset/model/subsystem/job
 *         → prioritize important memories within that subset
 *         → create edge snapshot/delta → transfer to device → store in Qdrant Edge
 *
 * What each stage guarantees:
 *   - Selection is a HARD filter built from the provisioning target (asset,
 *     equipment model, subsystem, job exact-terms). Non-matching content is
 *     excluded by construction (asserted in tests, not just by the include
 *     side), and the cloud doc_type discriminator keeps OTHER cloud content
 *     (e.g. fleet-wide technician memories from later phases) out entirely.
 *   - Prioritization is deterministic: importance-ranked (relevance boosts)
 *     with a document-level floor so a big matching subset is CAPPED to the
 *     most relevant/important items — never a blind dump of everything the
 *     filter touches.
 *   - The package is a deterministic, self-describing snapshot/delta:
 *     exact vectors (never re-embedded), provenance (source document, doc
 *     ids, selected count), and the target it was built for. Rebuilding it
 *     for an unchanged cloud store yields identical content.
 *   - Transfer writes ONLY into Qdrant Edge documents (Phase 1 collection,
 *     payload-indexed) — never into the memory store, never back into
 *     cloud. Provisioned documents are stamped jev_status 'not_applicable'
 *     exactly like their cloud origin (Phase 6: pre-trusted enterprise
 *     knowledge bypasses JEV; the Edge Pass measures FIELD knowledge
 *     against them, it does not re-evaluate them).
 *
 * No edge→cloud sync, no versioning/conflict detection, no Cloud JEV —
 * those are later phases, on purpose.
 */

import { createQdrantClient } from '../edge/qdrant.js';
import { validateDocumentChunk } from '../shared/schemas.js';

// The chunker import was dropped deliberately: selection operates on
// already-chunked cloud content; job descriptions are pre-chunked into
// jobTerms by the caller if needed.

/** The provisioning pipeline's transfer format version (manifest self-description). */
export const PROVISIONING_FORMAT = 'aeroedge-provisioning-v1';

/** Default cap on chunks transferred to one device (edge storage is small). */
export const DEFAULT_MAX_CHUNKS = 500;

/**
 * A provisioning target: what the device needs knowledge about. Every field
 * is optional, but at least one must be set — provisioning "everything" is
 * refused by design (that is the whole enterprise database).
 * @typedef {Object} ProvisioningTarget
 * @property {string} [assetId]
 * @property {string} [equipmentModel]
 * @property {string} [component] Subsystem (e.g. "hydraulics").
 * @property {string[]} [jobTerms] Identifier-like exact terms for the job at hand (part numbers, error codes).
 */

/**
 * One selected knowledge item: an exact cloud chunk (verbatim content +
 * original vector) plus its selection metadata.
 * @typedef {Object} SelectedItem
 * @property {string} cloudChunkId
 * @property {string} documentId
 * @property {string} source
 * @property {string} content
 * @property {number[]} vector Exact embedding from the cloud store (never recomputed).
 * @property {string} jevStatus Always 'not_applicable' (Phase 6 pre-trusted).
 * @property {number} importance Effective selection priority (higher = kept sooner under the cap).
 * @property {Record<string, unknown>} payload Full cloud payload (provenance preserved verbatim).
 */

/**
 * The deterministic snapshot/delta package.
 * @typedef {Object} ProvisioningPackage
 * @property {'aeroedge-provisioning-v1'} format
 * @property {ProvisioningTarget} target
 * @property {number} generatedAt Fixed at build time so rebuilds are reproducible.
 * @property {SelectedItem[]} items Prioritized, capped, exact-vector items.
 * @property {number} totalAvailable How many cloud chunks matched BEFORE the cap.
 * @property {boolean} truncated True when the cap dropped matching content.
 */

/**
 * Create the edge provisioning pipeline.
 *
 * @param {Object} options
 * @param {Readonly<Record<string, string>>} config Loaded shared config.
 * @param {ReturnType<typeof import('../edge/qdrant.js').createQdrantClient>} [cloudQdrant] Injected CLOUD client (tests); built from config otherwise.
 * @param {ReturnType<typeof import('../edge/qdrant.js').createQdrantClient>} [edgeQdrant] Injected EDGE client (tests); built from config otherwise.
 * @returns {{
 *   cloudCollection: string,
 *   edgeCollection: string,
 *   selectKnowledge: (target: ProvisioningTarget, opts?: { maxChunks?: number }) => Promise<{ items: SelectedItem[], totalAvailable: number, truncated: boolean }>,
 *   buildProvisioningPackage: (target: ProvisioningTarget, opts?: { maxChunks?: number }) => Promise<ProvisioningPackage>,
 *   transferToEdge: (pkg: ProvisioningPackage) => Promise<{ transferred: number, documentIds: string[], edgeCollection: string }>,
 *   provisionEdgeDevice: (target: ProvisioningTarget, opts?: { maxChunks?: number }) => Promise<{ transferred: number, documentIds: string[], totalAvailable: number, truncated: boolean, edgeCollection: string }>,
 * }}
 */
export function createProvisioning({ config, cloudQdrant, edgeQdrant }) {
  if (config === null || typeof config !== 'object') {
    throw new TypeError('createProvisioning requires a loaded shared config');
  }
  const cloudClient =
    cloudQdrant ??
    createQdrantClient({
      baseUrl: config.QDRANT_CLOUD_URL,
      collection: config.QDRANT_CLOUD_COLLECTION ?? 'aeroedge_cloud_docs',
    });
  const edgeClient =
    edgeQdrant ??
    createQdrantClient({
      // The EDGE endpoint only — provisioning never writes back to cloud,
      // and never touches the edge MEMORY collection (technician knowledge
      // is never provisioned; it is born on the device, Phase 4).
      baseUrl: config.QDRANT_EDGE_URL,
      collection: config.QDRANT_EDGE_COLLECTION ?? 'aeroedge_edge_docs',
    });

  /**
   * Validate the target and build the Qdrant filter. Provisioning
   * "everything" (empty target) is refused: a device gets what it needs,
   * not the enterprise database.
   * @param {ProvisioningTarget} target
   * @param {number} maxChunks
   * @returns {{ must: import('../edge/qdrant.js').MatchClause[], should: import('../edge/qdrant.js').MatchClause[], jobTerms: string[] }}
   */
  function buildSelectionFilter(target, maxChunks) {
    if (target === null || typeof target !== 'object') {
      throw new TypeError('provisioning target must be an object');
    }
    if (!Number.isInteger(maxChunks) || maxChunks <= 0) {
      throw new TypeError('maxChunks must be a positive integer');
    }
    const allowed = ['assetId', 'equipmentModel', 'component', 'jobTerms'];
    for (const key of Object.keys(target)) {
      if (!allowed.includes(key)) {
        throw new TypeError(`provisioning target: unknown field "${key}" (allowed: ${allowed.join(', ')})`);
      }
    }
    // Provisioning "everything" is refused by design: a device gets the
    // knowledge RELEVANT to it, never the whole enterprise database.
    const hasScope = ['assetId', 'equipmentModel', 'component', 'jobTerms'].some((k) => target[k] !== undefined);
    if (!hasScope) {
      throw new TypeError(
        'provisioning target: at least one of assetId/equipmentModel/component/jobTerms is required — ' +
          'provisioning the entire enterprise database is refused by design'
      );
    }
    const jobTerms = target.jobTerms ?? [];
    if (!Array.isArray(jobTerms) || !jobTerms.every((t) => typeof t === 'string' && t.trim() !== '')) {
      throw new TypeError('provisioning target: "jobTerms" must be an array of non-empty strings when provided');
    }
    /** @type {import('../edge/qdrant.js').MatchClause[]} */
    const must = [];
    // The discriminator: provisioning selects Phase 6 CLOUD ENTERPRISE
    // documents only, identified by their pre-trusted JEV standing — the
    // stamp Phase 6 puts on every ingested chunk and edge document chunks
    // never carry. Any other cloud content (e.g. fleet knowledge from later
    // phases, which would carry pending/validated) is never provisioned.
    must.push({ key: 'jev_status', match: { value: 'not_applicable' } });
    if (target.assetId !== undefined) {
      if (typeof target.assetId !== 'string' || target.assetId.trim() === '') {
        throw new TypeError('provisioning target: "assetId" must be a non-empty string when provided');
      }
      must.push({ key: 'asset_id', match: { value: target.assetId } });
    }
    if (target.equipmentModel !== undefined) {
      if (typeof target.equipmentModel !== 'string' || target.equipmentModel.trim() === '') {
        throw new TypeError('provisioning target: "equipmentModel" must be a non-empty string when provided');
      }
      must.push({ key: 'equipment_model', match: { value: target.equipmentModel } });
    }
    if (target.component !== undefined) {
      if (typeof target.component !== 'string' || target.component.trim() === '') {
        throw new TypeError('provisioning target: "component" must be a non-empty string when provided');
      }
      must.push({ key: 'component', match: { value: target.component } });
    }
    // Job terms: chunks matching AT LEAST ONE exact term qualify (OR —
    // one match.text clause per term, as Qdrant should-clauses).
    const should = jobTerms.map((t) => ({ key: 'content', match: { text: t } }));
    return { must, should, jobTerms };
  }

  /**
   * Deterministic priority for one matching chunk: cloud importance first,
   * then exact job-term hits, then source/version stability. The cap keeps
   * the highest-priority items, so a large subset is curated, not dumped.
   * @param {Record<string, unknown>} payload
   * @param {string[]} jobTerms
   * @returns {number}
   */
  function priorityOf(payload, jobTerms) {
    const importance = typeof payload.importance === 'number' ? payload.importance : 0.5;
    const content = String(payload.content ?? '').toLowerCase();
    const termHits = jobTerms.filter((t) => content.includes(t.toLowerCase())).length;
    const version = String(payload.version ?? '');
    // Weights chosen so importance dominates, exact job relevance
    // disambiguates, and newer/stable sources win ties — all deterministic.
    return importance * 10 + Math.min(termHits, 5) * 1 + Math.min(version.length, 4) * 0.05;
  }

  /**
   * Select the relevant subset from Qdrant Cloud for a target.
   * @param {ProvisioningTarget} target
   * @param {Object} [opts]
   * @param {number} [opts.maxChunks]
   * @returns {Promise<{ items: SelectedItem[], totalAvailable: number, truncated: boolean }>}
   */
  async function selectKnowledge(target, opts = {}) {
    const maxChunks = opts.maxChunks ?? DEFAULT_MAX_CHUNKS;
    const { must, should, jobTerms } = buildSelectionFilter(target, maxChunks);

    // Vector is REQUIRED here: transfer moves exact embeddings, so a cloud
    // point without one cannot be provisioned (fail loudly, never re-embed).
    const hits = await cloudClient.scrollWithFilter(
      { must, ...(should.length > 0 ? { should } : {}) },
      { limit: 100000, withVector: true }
    );
    const totalAvailable = hits.length;

    const prioritized = hits
      .map((hit) => ({
        hit,
        priority: priorityOf(hit.payload, jobTerms),
      }))
      .sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority;
        return a.hit.id < b.hit.id ? -1 : a.hit.id > b.hit.id ? 1 : 0; // deterministic tiebreak
      })
      .slice(0, maxChunks);

    /** @type {SelectedItem[]} */
    const items = [];
    for (const { hit, priority } of prioritized) {
      const p = hit.payload;
      const vector = hit.vector;
      if (vector === undefined) {
        throw new Error(
          `provisioning: cloud point "${hit.id}" has no retrievable vector — ` +
            'transfer requires exact embeddings (never re-embed provisioned knowledge)'
        );
      }
      items.push({
        cloudChunkId: hit.id,
        documentId: String(p.document_id ?? ''),
        source: String(p.source ?? ''),
        content: String(p.content ?? ''),
        vector,
        jevStatus: String(p.jev_status ?? 'not_applicable'),
        importance: priority,
        payload: p,
      });
    }
    return { items, totalAvailable, truncated: totalAvailable > items.length };
  }

  /**
   * Build the deterministic snapshot/delta package for a target.
   * @param {ProvisioningTarget} target
   * @param {Object} [opts]
   * @param {number} [opts.maxChunks]
   * @returns {Promise<ProvisioningPackage>}
   */
  async function buildProvisioningPackage(target, opts = {}) {
    const { items, totalAvailable, truncated } = await selectKnowledge(target, opts);
    return {
      format: PROVISIONING_FORMAT,
      target,
      generatedAt: 'provisioning-build-time',
      items,
      totalAvailable,
      truncated,
    };
  }

  /**
   * Transfer a package into Qdrant Edge: each cloud document becomes the
   * SAME document_id on the edge (replace-and-upsert per document =
   * idempotent re-provisioning), with vectors transferred verbatim and
   * payloads preserved minus the embedding. JEV standing is carried as-is
   * ('not_applicable' — pre-trusted enterprise knowledge; the Edge Pass
   * measures field knowledge against it, never re-evaluates it).
   * @param {ProvisioningPackage} pkg
   * @returns {Promise<{ transferred: number, documentIds: string[], edgeCollection: string }>}
   */
  async function transferToEdge(pkg) {
    if (pkg === null || typeof pkg !== 'object' || pkg.format !== PROVISIONING_FORMAT) {
      throw new TypeError(`transferToEdge requires a package with format "${PROVISIONING_FORMAT}"`);
    }
    if (!Array.isArray(pkg.items)) {
      throw new TypeError('transferToEdge: package items must be an array');
    }
    if (pkg.items.length === 0) {
      // Nothing matched the target: a no-op transfer, explicitly not an error
      // (a device provisioned for knowledge the fleet does not have yet).
      return { transferred: 0, documentIds: [], edgeCollection: edgeClient.collection };
    }

    // Group by source document; edge documents keep cloud document ids so
    // re-provisioning the same doc replaces it instead of duplicating.
    /** @type {Map<string, typeof pkg.items>} */
    const byDocument = new Map();
    for (const item of pkg.items) {
      const list = byDocument.get(item.documentId) ?? [];
      list.push(item);
      byDocument.set(item.documentId, list);
    }

    const vectorSize = pkg.items[0]?.vector.length ?? 0;
    await edgeClient.ensureCollection(vectorSize, [
      { fieldName: 'keywords' },
      { fieldName: 'doc_type' },
      { fieldName: 'equipment_model' },
      { fieldName: 'version' },
      { fieldName: 'applicability' },
      { fieldName: 'jev_status' },
    ]);

    let transferred = 0;
    for (const [documentId, items] of byDocument) {
      await edgeClient.deleteByDocument(documentId); // idempotent replace
      /** @type {{ id: string, vector: number[], payload: Record<string, unknown> }[]} */
      const points = [];
      for (const item of items) {
        // Contract gate: a provisioned chunk must be a valid DocumentChunk.
        const record = {
          id: item.cloudChunkId,
          document_id: item.documentId,
          version: String(item.payload.version ?? '1'),
          content: item.content,
          embedding: item.vector,
          asset_id: String(item.payload.asset_id ?? ''),
          component: String(item.payload.component ?? ''),
          source: item.source,
          ...(item.payload.keywords !== undefined ? { keywords: item.payload.keywords } : {}),
          ...(item.payload.equipment_model !== undefined ? { equipment_model: item.payload.equipment_model } : {}),
          ...(item.payload.doc_type !== undefined ? { doc_type: item.payload.doc_type } : {}),
          ...(item.payload.applicability !== undefined ? { applicability: item.payload.applicability } : {}),
          jev_status: item.jevStatus === '' ? 'not_applicable' : item.jevStatus,
          created_at: String(item.payload.created_at ?? new Date().toISOString()),
          updated_at: String(item.payload.updated_at ?? new Date().toISOString()),
        };
        const check = validateDocumentChunk(record);
        if (!check.valid) {
          throw new Error(`provisioning: transferred chunk failed contract validation: ${check.errors.join('; ')}`);
        }
        points.push({ id: item.cloudChunkId, vector: item.vector, payload: record });
      }
      await edgeClient.upsertPoints(points);
      transferred += points.length;
    }
    return { transferred, documentIds: [...byDocument.keys()], edgeCollection: edgeClient.collection };
  }

  /**
   * The full pipeline: CLOUD → select → prioritize → package → transfer →
   * Qdrant Edge.
   * @param {ProvisioningTarget} target
   * @param {Object} [opts]
   * @param {number} [opts.maxChunks]
   * @returns {Promise<{ transferred: number, documentIds: string[], totalAvailable: number, truncated: boolean, edgeCollection: string }>}
   */
  async function provisionEdgeDevice(target, opts = {}) {
    const pkg = await buildProvisioningPackage(target, opts);
    const result = await transferToEdge(pkg);
    return {
      transferred: result.transferred,
      documentIds: result.documentIds,
      totalAvailable: pkg.totalAvailable,
      truncated: pkg.truncated,
      edgeCollection: result.edgeCollection,
    };
  }

  return {
    cloudCollection: cloudClient.collection,
    edgeCollection: edgeClient.collection,
    selectKnowledge,
    buildProvisioningPackage,
    transferToEdge,
    provisionEdgeDevice,
  };
}
