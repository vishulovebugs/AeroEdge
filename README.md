# AeroEdge

Edge-native AI memory, reasoning, and knowledge-validation platform for maintenance
operations in disconnected environments (aviation, maritime, mining, heavy industry).

RAG answers questions. AeroEdge manages knowledge at the edge.
JEV decides what's allowed to become knowledge.

> **Status: Phase 11 — Final UI + Demo Integration (project complete).** Phase 0 delivered the repo skeleton
> and shared data contracts. Phase 1 added the offline loop: ingest → chunk →
> embed (Ollama) → store (Qdrant Edge) → query → grounded answer. Phase 2 made
> retrieval hybrid (semantic + exact keyword + metadata → fusion → dedup →
> rerank) with source citations. Phase 3 added diagnostic session memory.
> Phase 4 added the memory orchestrator: technician observations stored as
> first-class `Memory` records in a dedicated collection with an explicit,
> stored lifecycle. Phase 5 replaced the stub verdict source with the REAL
> JEV Edge Pass (`edge/jev.js`): a separate Ollama call that evaluates every
> field observation against its evidence and targeted authoritative
> retrieval BEFORE the orchestrator routes it — `accept_local` /
> `needs_more_evidence` / `flag_risk`, each with a REQUIRED non-empty
> rationale (empty ones are coerced to `needs_more_evidence` in code), and
> recording is never blocked. Phase 6 starts the cloud side: enterprise
> documents ingest into a distinct Qdrant Cloud knowledge store, stamped
> `jev_status: "not_applicable"` — enterprise input arrives pre-trusted, so
> NO JEV pass applies to it. Phase 7 provisions edge devices from that
> store: target-scoped selection (asset/model/subsystem/job terms —
> provisioning "everything" is refused by design), deterministic
> prioritization under a device-sized cap, and an idempotent snapshot/
> delta transfer of EXACT vectors into Qdrant Edge. The edge device gets
> only the knowledge relevant to it, never the whole enterprise database.
> Phase 8 closes the loop edge → cloud: on reconnection, a content-fingerprint
> change detector builds a DELTA of what changed since the last sync point,
> filtered by the Phase 4/5 verdict table (accept_local routed for sync or
> used; flag_risk tagged high-visibility; needs_more_evidence never
> eligible), and the cloud-side ingest persists the memories plus one
> `SyncEvent` per item. Phase 9 reconciles the two sides: every delta item
> is classified against the live cloud copy and the last-synced fingerprint
> into EXACTLY four cases — cloud newer (adopt edge-side via legal
> transitions), edge new (upload; unresolved until Cloud JEV), diverged
> (WITHHELD + an OPEN `Conflict` record — never overwritten in either
> direction), identical (dedupe). No last-write-wins anywhere. Phase 10
> completes JEV: the Cloud Pass evaluates synced knowledge against what
> only the fleet can see — other devices' observations, the enterprise
> master-doc set, prior JEV history — and its gate, in code, lets ONLY
> `validated` items propagate to the fleet. `needs_human_review` queues for
> a human; `rejected` stays local history. Conflict resolution is
> JEV-recommended and human-confirmed: the recommendation attaches to the
> SAME Phase 9 record, and a separate explicit confirmation is the only
> path to `resolved`. Phase 11 completes the product surface: a
> zero-dependency `node:http` API layer (`server/app.js`, all subsystems
> injected so tests drive the SAME endpoints a browser does) and a
> vanilla HTML/CSS/JS technician console (`ui/`): grounded query with
> evidence and sources, session context, field-observation capture with
> the Edge JEV verdict shown immediately, a memory dashboard with sync
> status, the conflict UI with explicit **Apply Cloud Version / Keep Edge
> Version / Review Details** buttons (nothing auto-applies), the
> human-review queue, and a connected/offline indicator.
> `test/e2e/demo-scenario.test.js` runs the full Section-14 demo
> headlessly — connect → provision → disconnect → offline query → session
> follow-up → capture + Edge JEV → routing → reconnect → delta sync →
> Cloud JEV verdict → conflict with JEV recommendation → explicit human
> confirmation → fleet propagation of validated items only — asserting
> the correct stored status transition at every step.

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
npm run test:e2e      # the full demo scenario, headless (no browser)
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
| `QDRANT_CLOUD_COLLECTION` | Optional; defaults to `aeroedge_cloud_docs` (Phase 6 enterprise knowledge store — architecturally separate from all edge stores). |

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

### Cloud Knowledge Layer (Phase 6)

Enterprise documents ingest into a DISTINCT cloud knowledge store
(`QDRANT_CLOUD_URL` / `QDRANT_CLOUD_COLLECTION`, default
`aeroedge_cloud_docs`) — a separate Qdrant instance/collection from
anything on the edge.

```js
import { createCloudKnowledge } from './cloud/knowledge.js';
const cloud = createCloudKnowledge({ config });

const result = await cloud.ingestDocument({
  documentId: 'ent-std-12',
  text: 'Enterprise hydraulic standard: system B operates at 2800-3200 PSI…',
  assetId: 'FLEET-STANDARD',
  component: 'hydraulics',
  source: 'Enterprise engineering standard rev 12',
  docType: 'standard',
});
// result.jevStatus === 'not_applicable' — stamped in code, no JEV pass.

const out = await cloud.search('what torque applies to the inlet B-nut?');
```

- **Trust asymmetry, enforced in code**: enterprise-sourced documents
  arrive through a controlled channel and are pre-trusted — every chunk is
  stamped `jev_status: "not_applicable"`. JEV exists to evaluate knowledge
  whose trustworthiness is UNCERTAIN (field-originated), not controlled
  enterprise input. No caller input can change the stamp; no JEV call runs
  on this path.
- **Structurally parallel to edge ingestion** (chunk → embed → validate →
  upsert), reusing the endpoint-agnostic transports (chunker, Ollama
  client, Qdrant client). The cloud module imports NO edge pipeline code,
  and no edge module imports the cloud layer (both audited by tests).
- **Separation is proven, not assumed**: the interconnect suite runs the
  full Phase 1–5 edge stack with the cloud pipeline active and asserts zero
  cross-writes, edge answers that never cite cloud content, and an Edge
  Pass that never sees enterprise documents as authoritative evidence.
- Scope: ingestion and query ONLY. No edge provisioning, no sync, no
  propagation.

### Edge provisioning (Phase 7)

An edge device gets ONLY the knowledge relevant to it — not the whole
enterprise database. One composed pipeline (cloud/provisioning.js):

```
CLOUD → determine relevant knowledge → filter by asset/model/subsystem/job
      → prioritize important memories → create edge snapshot/delta
      → transfer to device → store in Qdrant Edge
```

```js
import { createProvisioning } from './cloud/provisioning.js';
const prov = createProvisioning({ config });

const result = await prov.provisionEdgeDevice({
  assetId: 'MSN4453',
  component: 'hydraulics',
  jobTerms: ['88-42B'],   // optional exact terms for the job at hand
}, { maxChunks: 500 });    // device-sized budget (default 500)
// result: { transferred, documentIds, totalAvailable, truncated,
//           edgeCollection: 'aeroedge_edge_docs' }
```

- **Scoped selection is a hard filter**: asset, equipment model, subsystem,
  and exact job terms combine as Qdrant must-clauses (job terms OR within
  the leg). Provisioning with no scope is REFUSED — a device never gets
  "everything". Non-pre-trusted cloud content (anything without the Phase 6
  `not_applicable` stamp) is never provisioned.
- **Prioritized, capped, honest**: matching subsets are ranked by cloud
  importance, then job-term relevance, then deterministic tiebreaks —
  capped at `maxChunks` with `truncated: true` reported, never silently
  dumped or silently cut.
- **Snapshot/delta with exact vectors**: the package carries verbatim
  content and the CLOUD embedding (transfer never re-embeds, so edge and
  cloud stay in the same vector space). Edge documents keep cloud document
  ids, so re-provisioning replaces rather than duplicates.
- **Provisioned knowledge stays pre-trusted**: chunks arrive with
  `jev_status: "not_applicable"` — the Edge Pass measures field knowledge
  AGAINST provisioned docs; it never re-evaluates them.
- Proven end to end: the interconnect suite provisions a device from a
  multi-asset cloud store, then runs the full Phase 1–5 stack (grounded
  answers, hybrid retrieval, session memory, capture + Edge JEV flagging)
  on the provisioned data with no hand-seeded edge content.
- Scope: cloud → edge ONLY. No edge→cloud sync, no versioning/conflict
  detection (later phases).

### Sync Engine (Phase 8) — edge → cloud

Local changes reach the cloud on reconnection as a DELTA, never a full
resync:

```
local memories → change detector (vs sync ledger) → eligibility filter
  (Phase 4/5 verdict table) → delta package → cloud ingest
  → per-item SyncEvent → legal lifecycle transitions to `synced`
```

```js
import { createSyncEngine } from './edge/syncEngine.js';
import { createCloudSyncIngest } from './cloud/sync.js';

const syncEngine = createSyncEngine({ memoryStore, deviceId: 'device-01' });
const cloud = createCloudSyncIngest({ config });

// One sync round (wire `ingestDelta` to whatever transport reconnects):
const result = await syncEngine.syncNow((pkg) => cloud.ingestDelta(pkg));
// { synced, rejected, syncedIds, rejectedIds }
```

- **Change detection is content-based**: a SHA-256 fingerprint of content
  + revision lineage per memory, compared against a sync ledger. Lifecycle
  bookkeeping (new → local → used) is NEVER a false positive; a technician
  revision is. Second rounds transfer nothing (true delta).
- **Eligibility is the Phase 4/5 verdict table, re-read**: `accept_local`
  rides when the Orchestrator routed it (`sync_pending` by importance, or
  `used` — proven locally useful); `flag_risk` IS sync-eligible and is
  tagged `highVisibility` in the delta (a human must see it — never
  auto-propagatable downstream); `needs_more_evidence` is NEVER eligible
  (verdict veto, defense in depth, even against lifecycle drift);
  unrouted/withdrawn/unevaluated memories never ride; session notes and
  manuals never sync.
- **Cloud side**: `createCloudSyncIngest` stores memories in
  `QDRANT_CLOUD_MEMORY_COLLECTION` (default `aeroedge_cloud_memories`) —
  edge-JEV'd technician knowledge, fleet context but NOT fleet truth until
  the Cloud Pass validates it — and persists one contract-validated
  `SyncEvent` per item in `QDRANT_CLOUD_SYNC_COLLECTION` (the audit
  trail). Malformed items are rejected per-item, never crashing the batch;
  `expire` deletes the cloud copy.
- **Edge acks are legal transitions only**: applied items advance through
  `shared/lifecycle.js` to `synced` (sync_pending → synced; local/used
  compose the legal chain). Rejected items stay untouched and ride the
  next delta.
- Scope: edge → cloud transport and eligibility ONLY. No conflict
  detection/version comparison (Phase 9), no Cloud Pass (Phase 10), no
  propagation of flagged knowledge.

### Versioning + conflicts (Phase 9)

A version conflict is DETECTED, never silently overwritten. The
three-way comparator (`shared/versioning.js`) classifies each delta item
against the live cloud copy and the last-synced fingerprint (the common
ancestor from Phase 8's ledger) into exactly four cases:

| Case | Meaning | Handling |
|---|---|---|
| `CLOUD_NEWER` | cloud changed since the ancestor, edge didn't | edge ADOPTS the cloud copy via legal lifecycle transitions; ledger acked; never uploaded back |
| `EDGE_NEW` | edge changed (or is new), cloud didn't | uploads as Phase 8 would — NOT promoted: Cloud JEV (Phase 10) decides promotion |
| `DIVERGED` | both changed since the ancestor | WITHHELD from upload + an OPEN `Conflict` record (`aeroedge_cloud_conflicts`, Phase 0 contract: `edge_version`, `cloud_version`, `jev_recommendation` placeholder, status `open`) — neither side overwritten, no ack (keeps re-classifying until resolved) |
| `IDENTICAL` | same fingerprint both sides | deduplicated, acked |

```js
import { createReconciler } from './edge/reconciliation.js';
const reconciler = createReconciler({ memoryStore, ledger, cloudMemories, cloudConflicts });

// Compose with Phase 8: classify before ingest, route by case.
const pkg = await syncEngine.buildDelta();
const outcome = await reconciler.reconcileDelta(pkg, (upload) => cloud.ingestDelta(upload));
// { uploaded, adopted, conflicts, deduped, conflictIds }
const open = await reconciler.listOpenConflicts();
```

- **No last-write-wins anywhere**: "both changed" is only detectable
  against the common ancestor — without the Phase 8 ledger, every
  difference would look like a conflict and last-write-wins would be the
  only policy left.
- **Ancestor-less divergence classifies honestly**: both sides differing
  with no recorded ancestor is `DIVERGED` (detection-first), not a guess.
- The offline-edit-to-a-synced-memory scenario re-syncs as an `update`
  and flows straight into divergence detection.
- Scope: detection only. Resolution (JEV-recommended, human-confirmed) is
  Phase 10; the conflict record's `jev_recommendation` states honestly
  that no recommendation exists yet.

### JEV Cloud Pass + fleet propagation (Phase 10)

The fleet-aware half of JEV. `cloud/jevCloud.js` evaluates a synced
observation against what ONLY the fleet can see — a different Ollama call,
a different judge role (JEV-Cloud), and different context than the Edge
Pass:

- **Corroborating/contradicting observations from OTHER devices** (the
  cloud memory collection, vector-matched, candidate excluded),
- the **enterprise master-document set** (Phase 6 cloud docs — more than
  any one device holds),
- **prior JEV history** for the asset.

A Cloud Pass without this fleet context cannot even be built — the module
refuses. Checks, in order: corroboration across devices → master-doc
consistency (safety contradictions reject) → safety impact if acted on
and wrong → supersedes / refines / duplicates. Output: `stage: "cloud"`,
verdict `validated | needs_human_review | rejected`, non-empty rationale
(empty coerces to needs_human_review — it can never pass as validated).

**The propagation gate, in code** (`cloud/propagation.js`):
`canPropagate`/`routeVerdict` are the only path to the fleet — only
`validated` passes. `needs_human_review` queues in
`QDRANT_CLOUD_REVIEW_COLLECTION` (never auto-propagated, no illegal
memory transition forced); `rejected` stays local history on the origin
device and is never propagated.

```js
const result = await cloudJev.evaluateMemory(memory); // fleet-context pass
const record = cloudJev.verdictRecord(result, memory.memory_id);
await cloudJev.persistVerdict(record);           // JEV history grows
const applied = await gate.applyCloudVerdict(record, memory);
// applied.action: 'propagate' | 'review' | 'hold_local'
```

**Conflict resolution (JEV-assisted, human-confirmed):** Cloud JEV
attaches its `jev_recommendation` to the SAME Phase 9 Conflict record
(same conflict_id, no fields dropped, status stays open — nothing is
auto-applied). `confirmConflictResolution` is the separate explicit
human action and the only path to `resolved`; it refuses conflicts
without a real recommendation.

Acceptance scenario (live, `test/integration/cloud-jev.test.js`): two
devices independently upload similar observations; the second upload
triggers joint evaluation → `validated` citing corroboration; a third
unrelated low-evidence observation routes to `needs_human_review` instead
of propagating.

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

### Demo console (Phase 11)

The product surface: one server, one UI, no manual data patching.

```bash
ollama serve && docker run -p 6333:6333 qdrant/qdrant && docker run -p 6334:6334 qdrant/qdrant
cp .env.example .env          # fill in the two Qdrant URLs + models
npm run demo                  # UI on http://127.0.0.1:8788 (loopback only)
```

`npm run demo` (bin/aeroedge-demo.js) wires the REAL clients, seeds the
enterprise store once (idempotent), provisions this device, and starts
the device OFFLINE — toggle **connected** in the header when the demo
reaches the reconnect step. Everything else runs from the console:

- **Ask** — grounded answer with evidence chunks, source citations, and
  the session context line (Phases 1–3).
- **Record observation** — stored immediately, Edge JEV verdict +
  rationale + route shown in the same breath (Phases 4–5); recording is
  never blocked by evaluation.
- **Memory dashboard** — every memory with its STORED lifecycle/jev
  badges; pending-changes view uses the real Phase 8 eligibility
  predicate; **sync delta to cloud** runs classify → reconcile → ingest
  and reports the four version cases (Phases 8–9).
- **Cloud JEV pass** — runnable per synced memory; the fleet-context
  verdict lands in the review queue or propagates, exactly per the gate
  (Phase 10).
- **Conflicts** — Review Details shows both versions plus the JEV
  recommendation; **Apply Cloud Version** and **Keep Edge Version** are
  explicit human actions — the only paths to `resolved` (Phases 9–10).

The same endpoints the console calls are driven headlessly by
`npm run test:e2e` — the demo scenario with fakes, zero services needed.
Architecture note: the API layer composes Phases 1–10 and reports their
stored state; it never decides transitions itself.

## Layout

```
edge/      Edge-side runtime: rag.js (pipeline), retrieval.js (hybrid search),
           session.js (diagnostic session memory), memoryStore.js +
           orchestrator.js (memory lifecycle), jev.js (Edge Pass judge),
           syncEngine.js (delta sync → cloud), reconciliation.js (version
           cases, conflict detection), chunker.js, ollama.js + qdrant.js
           clients
cloud/     Cloud-side runtime: knowledge.js (enterprise ingestion → Qdrant
           Cloud, pre-trusted, no JEV pass), provisioning.js (scoped,
           prioritized edge provisioning → Qdrant Edge), sync.js (delta
           ingest + SyncEvent audit trail), jevCloud.js (fleet-context
           Cloud Pass judge), propagation.js (the gate: only validated
           propagates; review queue; conflict recommend + human confirm)
server/    Phase 11 API layer (app.js): a zero-dependency node:http app
           factory with INJECTED subsystems — the UI's REST surface and
           the endpoint the e2e demo drives (fakes in tests, real clients
           in bin/)
bin/       aeroedge-demo.js: the live demo launcher (real Ollama/Qdrant
           wiring, boot-time enterprise seed + device provisioning)
ui/        Technician-facing console: vanilla HTML/CSS/JS (query with
           evidence, session context, capture + Edge JEV verdict, memory
           dashboard, conflicts, review queue, connectivity indicator)
shared/    Cross-side contracts: config loading, data schemas, the
           lifecycle state machine (shared/lifecycle.js), and the pure
           three-way version classifier (shared/versioning.js)
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
