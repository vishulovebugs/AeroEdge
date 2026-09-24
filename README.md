# AeroEdge

Edge-native AI memory, reasoning, and knowledge-validation platform for maintenance
operations in disconnected environments (aviation, maritime, mining, heavy industry).

RAG answers questions. AeroEdge manages knowledge at the edge.
JEV decides what's allowed to become knowledge.

> **Status: Phase 1 — Basic Local RAG.** Phase 0 delivered the repo skeleton and
> shared data contracts. Phase 1 adds the core offline loop: ingest a document →
> chunk → embed locally (Ollama) → store in Qdrant Edge → query → grounded answer.
> No JEV yet, no field-observation memory, no UI.

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

The Phase 1 pipeline is fully offline: it talks only to your local Ollama and
local Qdrant (verify with `test/unit/offline-only.test.js`, which fails if any
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
    });
    console.log('ingested chunks:', doc.chunkCount);
    const out = await pipeline.answerQuestion('What is the normal pressure range of hydraulic system B?');
    console.log('answer:', out.answer);
  });
"
```

`shared/config.js` throws a specific, actionable error naming the first missing
required variable. Optional variables must be passed explicitly, e.g.
`loadConfig({ optional: { FOO: 'bar' } })`.

## Layout

```
edge/      Edge-side runtime (memory capture, local reasoning, Edge Pass JEV) — later phases
cloud/     Cloud-side runtime (fleet sync, Cloud Pass JEV) — later phases
ui/        Technician-facing UI (vanilla CSS) — later phases
shared/    Cross-side contracts: config loading and data schemas (this phase)
test/      node:test suites (unit, integration, interconnect)
```

## Architecture invariants (carry through every phase)

- Plain JavaScript (ESM) + JSDoc; vanilla CSS only; `node:test` only.
- Ollama for local inference/embeddings; Qdrant for vectors, Edge and Cloud instances
  architecturally separate.
- Every writer passes objects through the `validateX()` helpers in `shared/schemas.js`
  before persisting to Qdrant. No module invents its own shape.
- JEV verdicts always carry non-empty `rationale`, `evidence_used`, `model_used`, `confidence`.
