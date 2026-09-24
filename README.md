# AeroEdge

Edge-native AI memory, reasoning, and knowledge-validation platform for maintenance
operations in disconnected environments (aviation, maritime, mining, heavy industry).

RAG answers questions. AeroEdge manages knowledge at the edge.
JEV decides what's allowed to become knowledge.

> **Status: Phase 0 — Project Foundation.** Repo skeleton and shared data contracts only.
> No product logic yet: no retrieval, no Ollama calls, no Qdrant calls, no UI.

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
| `OLLAMA_MODEL` | Local LLM used for Edge Pass JEV evaluation and generation (Ollama model name). |
| `EMBEDDING_MODEL` | Local embedding model served by Ollama (Ollama model name). |
| `QDRANT_EDGE_URL` | HTTP endpoint of the Edge Qdrant instance. |
| `QDRANT_CLOUD_URL` | HTTP endpoint of the Cloud Qdrant instance. |

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
