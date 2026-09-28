# AeroEdge

Edge-native AI memory, reasoning, and knowledge-validation platform for maintenance
operations in disconnected environments (aviation, maritime, mining, heavy industry).

RAG answers questions. AeroEdge manages knowledge at the edge.
JEV decides what's allowed to become knowledge.

> **Status: Phase 3 — Contextual / Session Memory.** Phase 0 delivered the repo
> skeleton and shared data contracts. Phase 1 added the core offline loop:
> ingest → chunk → embed locally (Ollama) → store in Qdrant Edge → query →
> grounded answer. Phase 2 upgraded retrieval to a hybrid pipeline — semantic +
> exact keyword + metadata filtering → fusion → dedup → rerank — with source
> citations on every answer. Phase 3 adds diagnostic session memory: elliptical
> follow-ups ("what about the sensor?") resolve against the session's current
> asset/subsystem, and prompts receive a compact, bounded session summary —
> never the raw conversation. No JEV yet, no field-observation recording, no
> memory lifecycle, no UI, no cloud sync.

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
  subsystem, issue, recent queries, recent evidence, actions already taken —
  all bounded (`MAX_RECENT_QUERIES`, `MAX_RECENT_EVIDENCE`). Not persisted to
  Qdrant; working state for one diagnostic conversation.
- Controlled context injection: `buildSessionSummary(state)` produces a
  bounded summary (`SUMMARY_MAX_CHARS`); beyond `HISTORY_THRESHOLD_CHARS`
  older turns collapse into a "+N earlier queries omitted" marker.
- Without `{ session }`, `answerQuestion` behaves exactly as in Phase 2.
- Results from session-aware calls additionally carry `sessionQuery`,
  `usedSessionContext`, and `sessionId`.

`shared/config.js` throws a specific, actionable error naming the first missing
required variable. Optional variables must be passed explicitly, e.g.
`loadConfig({ optional: { FOO: 'bar' } })`.

## Layout

```
edge/      Edge-side runtime: rag.js (pipeline), retrieval.js (hybrid search),
           session.js (diagnostic session memory), chunker.js, ollama.js +
           qdrant.js clients; memory capture and Edge Pass JEV arrive in
           later phases
cloud/     Cloud-side runtime (fleet sync, Cloud Pass JEV) — later phases
ui/        Technician-facing UI (vanilla CSS) — later phases
shared/    Cross-side contracts: config loading and data schemas
           (including the optional Phase 2 retrieval metadata:
           equipment_model, doc_type, applicability, keywords)
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
