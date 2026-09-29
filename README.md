# AeroEdge

Edge-native AI memory, reasoning, and knowledge-validation platform for maintenance
operations in disconnected environments (aviation, maritime, mining, heavy industry).

RAG answers questions. AeroEdge manages knowledge at the edge.
JEV decides what's allowed to become knowledge.

> **Status: Phase 5 — JEV, Edge Pass.** Phase 0 delivered the repo skeleton
> and shared data contracts. Phase 1 added the offline loop: ingest → chunk →
> embed (Ollama) → store (Qdrant Edge) → query → grounded answer. Phase 2 made
> retrieval hybrid (semantic + exact keyword + metadata → fusion → dedup →
> rerank) with source citations. Phase 3 added diagnostic session memory.
> Phase 4 added the memory orchestrator: technician observations stored as
> first-class `Memory` records in a dedicated collection with an explicit,
> stored lifecycle. Phase 5 replaces the stub verdict source with the REAL
> JEV Edge Pass (`edge/jev.js`): a separate Ollama call that evaluates every
> field observation against its evidence and targeted authoritative
> retrieval BEFORE the orchestrator routes it — `accept_local` /
> `needs_more_evidence` / `flag_risk`, each with a REQUIRED non-empty
> rationale (empty ones are coerced to `needs_more_evidence` in code), and
> recording is never blocked. No sync engine, no cloud pass, no conflict
> resolution (Phase 10 by design), no UI (Phase 11).

## Requirements

- Node.js >= 22.0.0 (built-in test runner glob support, `util.parseEnv`)
- No npm dependencies at this phase (Node built-ins only).

## Install & test

```bash
npm install
npm test
```

Individual suites:

```bash
npm run test:unit
npm run test:integration
npm run test:interconnect
```

## Configuration

Copy `.env.example` to `.env` and fill in the values. Required variables:

| Variable | Purpose |
| --- | --- |
| `OLLAMA_MODEL` | Local LLM used for grounded generation (and later, Edge Pass JEV). |
| `EMBEDDING_MODEL` | Local embedding model served by Ollama — ingestion and query embedding MUST use the same one. |
| `QDRANT_EDGE_URL` | HTTP endpoint of the Edge Qdrant instance. |
| `QDRANT_CLOUD_URL` | HTTP endpoint of the Cloud Qdrant instance. |
| `OLLAMA_BASE_URL` | Optional; defaults to `http://127.0.0.1:11434`. |
| `QDRANT_EDGE_COLLECTION` | Optional; defaults to `aeroedge_edge_docs`. |
| `QDRANT_EDGE_MEMORY_COLLECTION` | Optional; defaults to `aeroedge_edge_memories` (technician memories, separate from documents). |

## Running the local pipeline

The pipeline is fully offline: it talks only to your local Ollama and local
Qdrant (verify with `test/unit/offline-only.test.js`, which fails if any
external SDK or non-loopback endpoint appears on this path).

```bash
ollama serve
ollama pull nomic-embed-text
ollama pull llama3.1:8b          # or set OLLAMA_MODEL
docker run -p 6333:6333 qdrant/qdrant

cp .env.example .env
node -e "
  import('./shared/config.js').then(async ({ loadConfig }) => {
    const { createRagPipeline } = await import('./edge/rag.js');
    const pipeline = createRagPipeline({ config: loadConfig({ envFile: '.env' }) });
    const doc = await pipeline.ingestDocument({
      documentId: 'amm-29-snippet',
      text: 'Hydraulic system B operates at 2800-3200 PSI. Overpressure opens the thermal relief valve.',
      assetId: 'aircraft-737-MSN4453',
      component: 'hydraulics',
      source: 'AMM rev 42',
      version: '42',
      docType: 'amm',
      equipmentModel: 'Boeing 737',
      keywords: ['88-42B'],
      applicability: ['fleet-a'],
    });
    console.log('ingested chunks:', doc.chunkCount);
    const out = await pipeline.answerQuestion('What is the normal pressure range of hydraulic system B?');
    console.log('answer:', out.answer);
    console.log('sources:', out.citations);
  });
"
```

### Hybrid retrieval (Phase 2)

`answerQuestion` runs the full pipeline:

```
QUERY → Semantic Search + Keyword Search + Metadata Filtering
      → Result Fusion (reciprocal rank fusion)
      → Deduplication → Ranking/Reranking → Evidence Pack → grounded answer
```

- **Exact keyword search**: identifier-like tokens in the query (error codes,
  part numbers, bulletin IDs such as `ERR-4212`, `ZX-99Q`, `SB-2911-07`) are
  matched literally against chunk content and indexed `keywords` — embeddings
  are never trusted to surface exact strings.
- **Metadata filtering**: pass `filters` (assetId, equipmentModel, component,
  docType, docVersion, applicableTo) as hard constraints on both legs —
  `answerQuestion(q, { filters: { equipmentModel: 'SkyRay MK-IV' } })`.
- **Source citations**: every answer returns `citations`
  (`{ documentId, source, version?, chunkIds }[]`) plus the full
  `evidence` pack (query, applied filters, exact terms, chunks with
  semantic/keyword sub-scores). The prompt lists available sources so the
  model cites excerpt numbers against real documents.
- **Direct retrieval**: `pipeline.retrieveEvidence(q, opts)` returns the
  evidence pack without generating an answer — the seam JEV (Edge Pass) will
  evaluate evidence at, separately from the generator.

Ingestion accepts optional retrieval metadata (`version`, `docType`,
`equipmentModel`, `keywords`, `applicability`); omitting them keeps Phase 1
records byte-compatible. Qdrant payload indexes for these fields are created
on first ingest of a fresh collection.

### Session memory (Phase 3)

```js
import { createSession } from './edge/session.js';
const session = createSession();

// Turn 1: a fully specified query establishes the working context.
await pipeline.answerQuestion(
  'Running diagnostics on aircraft MSN4453: what is the normal pressure range of hydraulic system B?',
  { session }
);

// Turn 2: an elliptical follow-up resolves via the session — the query is
// expanded with the session's asset/subsystem, hard-identifier filters are
// suggested (with an automatic unfiltered retry if they over-restrict), and
// the prompt carries a compact session summary instead of the raw log.
await pipeline.answerQuestion('what about the pressure sensor?', { session });
```

- Session state (`edge/session.js`): current asset, equipment model,
  subsystem, issue, recent queries, recent evidence, actions already taken,
  and observations recorded through the memory orchestrator — all bounded
  (`MAX_RECENT_QUERIES`, `MAX_RECENT_EVIDENCE`, `MAX_SESSION_OBSERVATIONS`).
  Not persisted to Qdrant; working state for one diagnostic conversation.
- Controlled context injection: `buildSessionSummary(state)` produces a
  bounded summary (`SUMMARY_MAX_CHARS`); beyond `HISTORY_THRESHOLD_CHARS`
  older turns collapse into a "+N earlier queries omitted" marker.
- Without `{ session }`, `answerQuestion` behaves exactly as in Phase 2.
- Results from session-aware calls additionally carry `sessionQuery`,
  `usedSessionContext`, and `sessionId`.

### JEV Edge Pass (Phase 5)

RAG answers questions. AeroEdge manages knowledge at the edge. JEV decides
what's allowed to become knowledge. The Edge Pass is the first of JEV's two
checkpoints: a fast, local evaluation that runs the moment knowledge is
recorded — before the orchestrator routes it. (The fleet-aware Cloud Pass is
a later phase; nothing edge-side is fleet truth.)

```js
// The capture path: record FIRST, evaluate SECOND, route THIRD.
const result = await orchestrator.captureAndRoute({
  content: 'Tightened the B-nut to 80 N·m and the seep stopped.',
  assetId: 'MSN4453',
  source: 'technician-jane',
  evidence: lastEvidencePack, // optional evidence from creation
});
// result.verdict → { stage: 'edge', verdict, rationale, confidence,
//                    risk_flags, evidence_used, model_used, evaluated_at }
// result.decision / result.applied → the verdict-driven route + stored transitions
```

- **Separate call, separate role**: the Edge Pass is its own Ollama call
  (`edge/jev.js buildJEVPrompt`), never the answer generator certifying
  itself. The judge prompt drives four checks in order: internal
  consistency → contradiction against authoritative knowledge (safety-
  critical weighted heaviest) → evidence sufficiency → provisional risk.
- **Targeted contradiction retrieval**: reuses Phase 2 hybrid retrieval
  against the authoritative document collection, scoped to the candidate's
  asset (and subsystem when known). Authoritative docs are high-confidence
  by construction — Type A material is the baseline truth field knowledge
  is measured against.
- **Rationale is the contract**: a model response with a missing/empty
  rationale is COERCED to `needs_more_evidence` by code (confidence 0,
  honest code-written rationale) — never passed through. Unparseable
  output, out-of-contract verdicts, and evaluator crashes coerce the same
  way. The orchestrator re-checks the same rule at capture time.
- **Verdict-driven routing** (Phase 4's table, now fully populated):

  | Edge JEV verdict | Orchestrator behavior |
  |---|---|
  | `accept_local` | KEEP_LOCAL, or SYNC when importance ≥ 0.7 |
  | `needs_more_evidence` | KEEP_LOCAL only; technician prompted for more detail; NOT sync-eligible at any importance |
  | `flag_risk` | KEEP_LOCAL, high-visibility (`jev_status: 'flag_risk'` STORED — queryable via `listMemories({ jevStatus: 'flag_risk' })`); sync-eligible so a human sees it, never auto-propagatable |

- **Hard rule, enforced in code**: JEV never blocks recording.
  `captureAndRoute` stores the memory before evaluation begins; any
  evaluator failure only coerces the verdict, never prevents the record.
- **Verdict + rationale surface immediately** in the capture response
  (the stored verdict record is contract-validated against
  `validateJEVVerdict`); full UI arrives in Phase 11.
- The Phase 4 stub (`stubVerdictSource`) remains exported, opt-in only for
  tests/debug; the real Edge Pass is the default verdict source.

### Memory orchestrator (Phase 4)

Technician knowledge is a first-class `Memory` record (shared/schemas.js),
stored in a dedicated Edge collection (`QDRANT_EDGE_MEMORY_COLLECTION`,
default `aeroedge_edge_memories`) that is architecturally separate from the
authoritative document collection.

```js
import { createMemoryOrchestrator } from './edge/orchestrator.js';
import { createMemoryStore } from './edge/memoryStore.js';
import { createSession } from './edge/session.js';

const session = createSession();
const orchestrator = createMemoryOrchestrator({
  config, memoryStore: createMemoryStore({ config }), session,
});

// Offline capture, immediately, with an explicit STORED lifecycle:
const obs = await orchestrator.captureObservation({
  content: 'B-nut seeped at 38 N·m; re-torque to 45 N·m cleared it.',
  assetId: 'MSN4453',
  source: 'technician-jane',
});
// obs.memory_type === 'field_observation', lifecycle_status 'new',
// jev_status 'pending' — useful locally, authoritative for nothing.

// Routing (verdict source is a parameter — the real Edge JEV Pass is the
// default since Phase 5; pass stubVerdictSource to route unevaluated;
// signature never changes):
const decision = await orchestrator.routeWithVerdict(obs);
const applied = await orchestrator.applyRoute(decision); // transitions stored
```

- **Memory types**: `manual` (Type A, authoritative reference; lifecycle
  `local`, jev `not_applicable`), `session_note` (Type B working memory,
  never synced), `field_observation` (Type C, never auto-authoritative).
- **Explicit lifecycle** (`shared/lifecycle.js`): new → local → used →
  sync_pending → synced, new/local → expired, and the JEV-aware conflict
  branches — all stored on the record, never inferred at read time. Illegal
  transitions throw.
- **Routing table**: KEEP_LOCAL / SYNC (importance ≥ 0.7) / EXPIRE / UPDATE
  (explicit revision → new version with `revision_of` lineage, never a silent
  overwrite) / FLAG_CONFLICT (defined; refused loudly until the later-phase
  machinery exists).
- `noteMemoryUsed(id)` marks that a memory informed a grounded answer
  (`used`) — usage is not validation.
- Observations captured mid-session update the Phase 3 session's
  "technician observations so far" state and reach the prompt context.

`shared/config.js` throws a specific, actionable error naming the first missing
required variable. Optional variables must be passed explicitly, e.g.
`loadConfig({ optional: { FOO: 'bar' } })`.

## Layout

```
edge/      Edge-side runtime: rag.js (pipeline), retrieval.js (hybrid search),
           session.js (diagnostic session memory), memoryStore.js +
           orchestrator.js (memory lifecycle), jev.js (Edge Pass judge),
           chunker.js, ollama.js + qdrant.js clients
cloud/     Cloud-side runtime (fleet sync, Cloud Pass JEV) — later phases
ui/        Technician-facing UI (vanilla CSS) — later phases
shared/    Cross-side contracts: config loading, data schemas, and the
           lifecycle state machine (shared/lifecycle.js)
test/      node:test suites (unit, integration, interconnect) + shared fakes
           in test/helpers
```

## Architecture invariants (carry through every phase)

- Plain JavaScript (ESM) + JSDoc; vanilla CSS only; `node:test` only.
- Ollama for local inference/embeddings; Qdrant for vectors, Edge and Cloud instances
  architecturally separate.
- Every writer passes objects through the `validateX()` helpers in `shared/schemas.js`
  before persisting to Qdrant. No module invents its own shape.
- JEV verdicts always carry non-empty `rationale`, `evidence_used`, `model_used`, `confidence`.
  An evaluation without a stated reason is not an evaluation — edge/jev.js
  and the orchestrator both coerce rationale-less results to
  `needs_more_evidence`. JEV never blocks recording; only what happens
  AFTER recording depends on the verdict.
- Memory lifecycle status is explicit and stored; every transition goes
  through `shared/lifecycle.js` — nothing infers a memory's standing at read
  time. Technician memories never live in the authoritative document
collection, and nothing this side of JEV validation is fleet-wide truth.
