'use strict';

/**
 * Phase 11 — the API layer the UI talks to (and the e2e demo drives).
 *
 * A ZERO-DEPENDENCY `node:http` app factory: every subsystem from Phases
 * 1–10 (RAG pipeline, session, memory orchestrator, sync engine,
 * reconciler, Cloud JEV, fleet gate) is INJECTED, never constructed here
 * from live clients. That one decision is what makes the whole product
 * demonstrable offline: `bin/aeroedge-demo.js` wires real Ollama/Qdrant
 * clients; the e2e suite wires the shared in-memory fakes and drives the
 * SAME HTTP endpoints the browser UI calls — no browser required, no
 * network beyond loopback.
 *
 * Endpoint map (all JSON under /api):
 *   GET  /api/health                       connected/offline + model identity
 *   POST /api/connection { connected }     connect/disconnect the device (demo control)
 *   POST /api/query { query, filters? }    Phase 1–3 grounded answer + citations + evidence
 *   GET  /api/session                      current diagnostic session snapshot
 *   POST /api/session { assetId?, ... }    create/replace the diagnostic session
 *   POST /api/capture { content, ... }     Phase 4–5 captureAndRoute (Edge JEV verdict immediate)
 *   GET  /api/memories?jevStatus=...       Phase 4 memory dashboard (stored statuses only)
 *   GET  /api/sync/changes                 Phase 8 change detector (pending changes)
 *   POST /api/sync/delta                   Phase 8+9 classify → reconcile → cloud ingest
 *   POST /api/cloud/jev { memoryId }       Phase 10 Cloud Pass on a synced memory
 *   GET  /api/review-queue                 Phase 10 needs_human_review queue
 *   GET  /api/conflicts                    Phase 9 open conflicts
 *   GET  /api/conflicts/:id                one conflict record
 *   POST /api/conflicts/:id/recommend      Phase 10 JEV recommendation (never applies anything)
 *   POST /api/conflicts/:id/confirm        the ONLY path to resolved — explicit human action
 *
 * Nothing here invents state transitions: every status change goes through
 * the Phase 0–10 modules (orchestrator routing, lifecycle state machine,
 * the propagation gate). The API composes and reports; it never decides.
 */

import { createServer as createHttpServer } from 'node:http';
import { isSyncEligible } from '../edge/syncEngine.js';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UI_DIR = join(ROOT, 'ui');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** Body size guard: field notes are small; anything past 1 MiB is refused. */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * @typedef {Object} ApiDeps
 * @property {Readonly<Record<string, string>>} config Loaded shared config (model names for /api/health).
 * @property {ReturnType<typeof import('../edge/rag.js').createRagPipeline>} pipeline Phase 1–3 pipeline.
 * @property {ReturnType<typeof import('../edge/orchestrator.js').createMemoryOrchestrator>} orchestrator Phase 4–5 orchestrator.
 * @property {ReturnType<typeof import('../edge/syncEngine.js').createSyncEngine>} [syncEngine] Phase 8 engine.
 * @property {ReturnType<typeof import('../cloud/sync.js').createCloudSyncIngest>} [cloudSync] Phase 8 cloud ingest.
 * @property {ReturnType<typeof import('../edge/reconciliation.js').createReconciler>} [reconciler] Phase 9 reconciler.
 * @property {ReturnType<typeof import('../cloud/jevCloud.js').createCloudJev>} [cloudJev] Phase 10 Cloud Pass.
 * @property {ReturnType<typeof import('../cloud/propagation.js').createFleetGate>} [gate] Phase 10 fleet gate.
 * @property {ReturnType<typeof import('../edge/qdrant.js').createQdrantClient> | null} [cloudMemories] Cloud memory collection client (fetch cloud copies for the Cloud Pass).
 * @property {string} [deviceId] Stable device identity surfaced in /api/health.
 */

/**
 * @param {unknown} res
 * @param {number} status
 * @param {unknown} body
 */
function respondJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/**
 * @param {unknown} req
 * @returns {Promise<Record<string, unknown>>}
 */
async function readJsonBody(req) {
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  for await (const chunk of /** @type {AsyncIterable<Buffer>} */ (req)) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body exceeds 1 MiB');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw === '') return {};
  const parsed = JSON.parse(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('request body must be a JSON object');
  }
  return /** @type {Record<string, unknown>} */ (parsed);
}

/** HTTP status for a thrown error: caller mistakes → 400, missing → 404, the rest → 500. */
function statusForError(err) {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof TypeError) return 400;
  if (/not found/i.test(message)) return 404;
  return 500;
}

/**
 * Create the AeroEdge API app. All subsystems are injected — this factory
 * performs zero I/O and never constructs live Ollama/Qdrant clients.
 * @param {ApiDeps} deps
 * @returns {{ handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>, state: { connected: boolean } }}
 */
export function createApp(deps) {
  for (const [name, value] of Object.entries({ config: deps.config, pipeline: deps.pipeline, orchestrator: deps.orchestrator })) {
    if (value === null || typeof value !== 'object') {
      throw new TypeError(`createApp requires a wired "${name}" (build one from shared/config.js / edge modules)`);
    }
  }

  const config = deps.config;
  /** Demo state: the device's connection mode and the last evidence pack
   * (the UI's "record what you just saw" flow reuses it). NOT a substitute
   * for any stored status — memory standing lives on the Memory records. */
  const state = {
    connected: false,
    /** @type {Record<string, unknown>|null} */
    lastEvidence: null,
    /** @type {Record<string, unknown>|null} */
    currentSession: null,
    /** memoryId → the latest Cloud Pass verdict record (backing data for
     * conflict recommendations; never auto-applied to anything). */
    lastCloudVerdicts: new Map(),
  };

  /** @returns {Record<string, unknown>} Current session snapshot (bounded, UI-safe). */
  function sessionSnapshot() {
    const s = state.currentSession;
    if (s === null) return null;
    return {
      sessionId: s.sessionId,
      assetId: s.assetId,
      equipmentModel: s.equipmentModel,
      component: s.component,
      issue: s.issue,
      recentQueries: [...s.recentQueries],
      observations: Array.isArray(s.observations) ? [...s.observations] : [],
      startedAt: s.startedAt,
      lastActiveAt: s.lastActiveAt,
    };
  }

  /** @param {string} message The dependency-missing error text. */
  function missingDepsError(message) {
    return new Error(message);
  }

  /**
   * Fetch a memory's cloud copy by domain id (Cloud Pass input).
   * @param {string} memoryId
   */
  async function getCloudMemory(memoryId) {
    if (deps.cloudMemories === undefined) {
      throw missingDepsError('cloud memory store is not wired on this server');
    }
    const hits = await deps.cloudMemories.scrollWithFilter(
      { must: [{ key: 'memory_id', match: { value: memoryId } }] },
      { limit: 1 }
    );
    return hits.length > 0 ? /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (hits[0].payload)) : null;
  }

  /**
   * Serve a static UI file. Path traversal is refused; only files inside
   * ui/ are ever read.
   * @param {string} pathname
   * @param {import('node:http').ServerResponse} res
   */
  async function serveStatic(pathname, res) {
    const decoded = decodeURIComponent(pathname);
    // Traversal attempts are refused outright (a bare 404 would hide the
    // attempt; resolve()+startsWith below is the second belt).
    if (decoded.includes('..')) {
      respondJson(res, 403, { error: 'forbidden' });
      return;
    }
    const clean = normalize(decoded).replaceAll('\\', '/');
    const target = resolve(join(UI_DIR, clean === '/' || clean === '' ? 'index.html' : clean.slice(1)));
    if (target !== UI_DIR && !target.startsWith(UI_DIR + sep)) {
      respondJson(res, 403, { error: 'forbidden' });
      return;
    }
    try {
      const data = await readFile(target);
      res.writeHead(200, {
        'content-type': MIME_TYPES[extname(target)] ?? 'application/octet-stream',
        'content-length': data.length,
        'cache-control': 'no-store',
      });
      res.end(data);
    } catch {
      respondJson(res, 404, { error: `no such UI file: ${pathname}` });
    }
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {URL} url
   */
  async function handleApi(req, res, url) {
    const route = `${req.method} ${url.pathname}`;

    if (route === 'GET /api/health') {
      return respondJson(res, 200, {
        ok: true,
        connected: state.connected,
        deviceId: deps.deviceId ?? 'edge-device-local',
        model: config.OLLAMA_MODEL ?? 'unknown',
        embeddingModel: config.EMBEDDING_MODEL ?? 'unknown',
        session: sessionSnapshot(),
      });
    }

    if (route === 'POST /api/connection') {
      const body = await readJsonBody(req);
      state.connected = body.connected === true;
      return respondJson(res, 200, { connected: state.connected });
    }

    if (route === 'POST /api/query') {
      const body = await readJsonBody(req);
      const query = typeof body.query === 'string' ? body.query.trim() : '';
      if (query === '') throw new TypeError('"query" must be a non-empty string');
      const out = await deps.pipeline.answerQuestion(query, {
        ...(typeof body.limit === 'number' ? { limit: body.limit } : {}),
        ...(body.filters !== undefined && body.filters !== null ? { filters: /** @type {any} */ (body.filters) } : {}),
        ...(state.currentSession !== null ? { session: state.currentSession } : {}),
      });
      state.lastEvidence = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (out.evidence));
      return respondJson(res, 200, {
        answer: out.answer,
        citations: out.citations,
        evidence: {
          chunks: out.chunks,
          exactTerms: out.evidence.exactTerms,
          appliedFilters: out.evidence.appliedFilters,
        },
        ...(out.sessionId !== undefined
          ? { sessionId: out.sessionId, usedSessionContext: out.usedSessionContext, sessionQuery: out.sessionQuery }
          : {}),
      });
    }

    if (route === 'GET /api/session') {
      return respondJson(res, 200, { session: sessionSnapshot() });
    }

    if (route === 'POST /api/session') {
      const body = await readJsonBody(req);
      const { createSession } = await import('../edge/session.js');
      const session = createSession({
        ...(typeof body.assetId === 'string' && body.assetId.trim() !== '' ? { assetId: body.assetId } : {}),
        ...(typeof body.equipmentModel === 'string' && body.equipmentModel.trim() !== '' ? { equipmentModel: body.equipmentModel } : {}),
        ...(typeof body.component === 'string' && body.component.trim() !== '' ? { component: body.component } : {}),
        ...(typeof body.issue === 'string' && body.issue.trim() !== '' ? { issue: body.issue } : {}),
      });
      state.currentSession = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (session));
      deps.orchestrator.attachSession(session);
      return respondJson(res, 200, { session: sessionSnapshot() });
    }

    if (route === 'POST /api/capture') {
      const body = await readJsonBody(req);
      const content = typeof body.content === 'string' ? body.content.trim() : '';
      if (content === '') throw new TypeError('"content" must be a non-empty string');
      const assetId = typeof body.assetId === 'string' && body.assetId.trim() !== ''
        ? body.assetId
        : (state.currentSession?.assetId ?? 'unassigned');
      const result = await deps.orchestrator.captureAndRoute({
        content,
        assetId,
        source: typeof body.source === 'string' && body.source.trim() !== '' ? body.source : 'technician-ui',
        ...(typeof body.importance === 'number' ? { importance: body.importance } : {}),
        ...(typeof body.confidence === 'number' ? { confidence: body.confidence } : {}),
        ...(body.evidence !== undefined ? { evidence: body.evidence } : state.lastEvidence !== null ? { evidence: state.lastEvidence } : {}),
      });
      return respondJson(res, 200, {
        memory: result.memory,
        verdict: result.verdict,
        decision: { action: result.decision.action, verdict: result.decision.verdict },
        applied: result.applied === null ? null : { action: result.applied.action, transitions: result.applied.transitions, memory: result.applied.memory },
      });
    }

    if (route === 'GET /api/memories') {
      const memories = await deps.orchestrator.store.listMemories({
        ...(url.searchParams.get('memoryType') ? { memoryType: url.searchParams.get('memoryType') } : {}),
        ...(url.searchParams.get('lifecycleStatus') ? { lifecycleStatus: url.searchParams.get('lifecycleStatus') } : {}),
        ...(url.searchParams.get('jevStatus') ? { jevStatus: url.searchParams.get('jevStatus') } : {}),
        ...(url.searchParams.get('assetId') ? { assetId: url.searchParams.get('assetId') } : {}),
        ...(url.searchParams.get('limit') ? { limit: Number(url.searchParams.get('limit')) } : {}),
      });
      return respondJson(res, 200, { memories });
    }

    if (route === 'GET /api/sync/changes') {
      if (deps.syncEngine === undefined) throw missingDepsError('sync engine is not wired on this server');
      const { changed, scanned } = await deps.syncEngine.detectChanges();
      return respondJson(res, 200, {
        scanned,
        // Eligibility is the REAL Phase 8 predicate, re-read live — the UI
        // never guesses sync standing from displayed fields.
        pending: changed.map((m) => ({
          memoryId: m.memory_id,
          content: m.content,
          lifecycleStatus: m.lifecycle_status,
          jevStatus: m.jev_status,
          syncEligible: isSyncEligible(m),
        })),
      });
    }

    if (route === 'POST /api/sync/delta') {
      if (deps.syncEngine === undefined || deps.reconciler === undefined || deps.cloudSync === undefined) {
        throw missingDepsError('sync engine + reconciler + cloud ingest are required for delta sync');
      }
      const pkg = await deps.syncEngine.buildDelta();
      const classification = await deps.reconciler.classifyDelta(pkg);
      const outcome = await deps.reconciler.reconcileDelta(pkg, (upload) => deps.cloudSync.ingestDelta(upload));
      return respondJson(res, 200, {
        deviceId: pkg.deviceId,
        items: pkg.items.map((i) => ({
          memoryId: i.memoryId,
          operation: i.operation,
          jevVerdict: i.edgeJevVerdict,
          highVisibility: i.highVisibility,
          content: i.memory?.content ?? '',
        })),
        classification: {
          counts: classification.counts,
          cases: classification.items.map((c) => ({ memoryId: c.item.memoryId, kase: c.kase, reason: c.reason })),
        },
        outcome,
      });
    }

    if (route === 'POST /api/cloud/jev') {
      if (deps.cloudJev === undefined || deps.gate === undefined) {
        throw missingDepsError('Cloud JEV + fleet gate are not wired on this server');
      }
      const body = await readJsonBody(req);
      const memoryId = typeof body.memoryId === 'string' ? body.memoryId.trim() : '';
      if (memoryId === '') throw new TypeError('"memoryId" must be a non-empty string');
      const memory = await getCloudMemory(memoryId);
      if (memory === null) throw new Error(`memory "${memoryId}" not found in the cloud memory store`);
      const result = await deps.cloudJev.evaluateMemory(/** @type {any} */ (memory));
      const record = deps.cloudJev.verdictRecord(result, memoryId);
      await deps.cloudJev.persistVerdict(record);
      state.lastCloudVerdicts.set(memoryId, record);
      const applied = await deps.gate.applyCloudVerdict(record, /** @type {any} */ (memory));
      return respondJson(res, 200, { verdict: record, applied });
    }

    if (route === 'GET /api/review-queue') {
      if (deps.gate === undefined) throw missingDepsError('fleet gate is not wired on this server');
      const queue = await deps.gate.listReviewQueue({
        ...(url.searchParams.get('limit') ? { limit: Number(url.searchParams.get('limit')) } : {}),
      });
      return respondJson(res, 200, { queue });
    }

    if (route === 'GET /api/conflicts') {
      if (deps.reconciler === undefined) throw missingDepsError('reconciler is not wired on this server');
      const conflicts = await deps.reconciler.listOpenConflicts({
        ...(url.searchParams.get('memoryId') ? { memoryId: url.searchParams.get('memoryId') } : {}),
      });
      return respondJson(res, 200, { conflicts });
    }

    const conflictMatch = url.pathname.match(/^\/api\/conflicts\/([^/]+)(?:\/(recommend|confirm))?$/);
    if (conflictMatch !== null) {
      if (deps.gate === undefined) throw missingDepsError('fleet gate is not wired on this server');
      const conflictId = decodeURIComponent(conflictMatch[1]);
      const action = conflictMatch[2];

      if (action === 'recommend' || action === 'confirm') {
        return handleConflictAction(req, res, conflictId, action);
      }

      // Bare record fetch (the UI's "Review Details" flow).
      if (req.method === 'GET') {
        const conflict = await deps.gate.getConflict(conflictId);
        if (conflict === null) throw new Error(`conflict "${conflictId}" not found`);
        return respondJson(res, 200, { conflict });
      }
      return respondJson(res, 405, { error: 'method not allowed' });
    }

    return respondJson(res, 404, { error: `no such API route: ${route}` });
  }

  /**
   * POST /api/conflicts/:id/recommend — attach the Cloud JEV recommendation
   * to the SAME Phase 9 record; nothing is applied.
   * POST /api/conflicts/:id/confirm — THE explicit human confirmation, the
   * only path to resolved.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {string} conflictId
   * @param {'recommend'|'confirm'} action
   */
  async function handleConflictAction(req, res, conflictId, action) {
    if (action === 'recommend') {
      // A recommendation is ALWAYS JEV-backed: reuse this memory's cached
      // Cloud Pass verdict when the UI already ran one; otherwise ask Cloud
      // JEV now. No invented advice, and status stays open.
      const conflict = await deps.gate.getConflict(conflictId);
      if (conflict === null) throw new Error(`conflict "${conflictId}" not found`);
      const rec = conflict.jev_recommendation;
      const hasRealRecommendation =
        rec !== null && typeof rec === 'object' &&
        typeof rec.verdict === 'string' && rec.verdict.trim() !== '' &&
        !/Phase 9 version reconciliation/.test(String(rec.rationale ?? ''));
      if (hasRealRecommendation) return respondJson(res, 200, { conflict });
      const memoryIdForConflict = String(conflict.memory_id);
      let backed = state.lastCloudVerdicts.get(memoryIdForConflict);
      if (backed === undefined) {
        if (deps.cloudJev === undefined) {
          throw missingDepsError('Cloud JEV is required to compute a conflict recommendation');
        }
        const memory = await getCloudMemory(memoryIdForConflict);
        if (memory === null) throw new Error(`memory "${memoryIdForConflict}" not found in the cloud memory store`);
        const result = await deps.cloudJev.evaluateMemory(/** @type {any} */ (memory));
        backed = deps.cloudJev.verdictRecord(result, memoryIdForConflict);
        await deps.cloudJev.persistVerdict(backed);
        state.lastCloudVerdicts.set(memoryIdForConflict, backed);
      }
      const updated = await deps.gate.recommendConflictResolution(
        conflictId,
        { verdict: String(backed.verdict), rationale: String(backed.rationale) },
        /** @type {any} */ (backed)
      );
      return respondJson(res, 200, { conflict: updated });
    }

    // action === 'confirm': THE explicit human confirmation — the only path
    // to resolved. JEV never calls this.
    const body = await readJsonBody(req);
    const updated = await deps.gate.confirmConflictResolution(conflictId, {
      resolvedBy: typeof body.resolvedBy === 'string' ? body.resolvedBy : '',
      winner: /** @type {'edge'|'cloud'} */ (body.winner),
      resolution: typeof body.resolution === 'string' ? body.resolution : '',
    });
    return respondJson(res, 200, { conflict: updated });
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url);
        return;
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        await serveStatic(url.pathname, res);
        return;
      }
      respondJson(res, 405, { error: 'method not allowed' });
    } catch (err) {
      const status = statusForError(err);
      respondJson(res, status, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { handler, state };
}

/**
 * Start the API server (used by the demo launcher and the e2e suite).
 * @param {Object} [opts]
 * @param {ApiDeps} [opts.deps] Injected subsystems (same object createApp takes).
 * @param {number} [opts.port] Defaults to an ephemeral port.
 * @param {string} [opts.host] Defaults to loopback only.
 * @returns {Promise<{ port: number, url: string, close: () => Promise<void>, state: { connected: boolean } }>}
 */
export async function startApiServer({ deps, port = 0, host = '127.0.0.1' } = {}) {
  const { handler, state } = createApp(deps);
  const server = createHttpServer(handler);
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, host, () => resolveListen(undefined));
  });
  const address = server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;
  return {
    port: boundPort,
    url: `http://127.0.0.1:${boundPort}`,
    close: () =>
      new Promise((resolveClose) => {
        server.close(() => resolveClose(undefined));
      }),
    state,
  };
}
