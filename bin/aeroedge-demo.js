#!/usr/bin/env node
'use strict';

/**
 * AeroEdge demo launcher — the REAL wiring of the Phase 11 API server.
 *
 * The e2e suite proves the product end to end with injected fakes; this
 * launcher proves the same surface against live services:
 *
 *   ollama serve                       # local inference + embeddings
 *   docker run -p 6333:6333 qdrant/qdrant   # Edge instance
 *   docker run -p 6334:6334 qdrant/qdrant   # Cloud instance (separate!)
 *   cp .env.example .env               # fill in URLs/models, then:
 *   node bin/aeroedge-demo.js          # UI on http://127.0.0.1:8788
 *
 * No demo data is patched by hand: provision the device from the cloud
 * store, capture observations, sync, evaluate, resolve conflicts — all
 * through the UI on the same endpoints the tests drive.
 */

import { loadConfig } from '../shared/config.js';
import { createOllamaClient } from '../edge/ollama.js';
import { createQdrantClient } from '../edge/qdrant.js';
import { createRagPipeline } from '../edge/rag.js';
import { createMemoryStore } from '../edge/memoryStore.js';
import { createMemoryOrchestrator } from '../edge/orchestrator.js';
import { createSyncEngine } from '../edge/syncEngine.js';
import { createReconciler } from '../edge/reconciliation.js';
import { createCloudKnowledge } from '../cloud/knowledge.js';
import { createProvisioning } from '../cloud/provisioning.js';
import { createCloudSyncIngest } from '../cloud/sync.js';
import { createCloudJev } from '../cloud/jevCloud.js';
import { createFleetGate } from '../cloud/propagation.js';
import { startApiServer } from '../server/app.js';

const config = loadConfig({ envFile: '.env' });

// Shared transports — one Ollama client, separate Qdrant clients per side.
const ollama = createOllamaClient({
  baseUrl: config.OLLAMA_BASE_URL,
  embedModel: config.EMBEDDING_MODEL,
  generateModel: config.OLLAMA_MODEL,
});
const edgeDocsQdrant = createQdrantClient({
  baseUrl: config.QDRANT_EDGE_URL,
  collection: config.QDRANT_EDGE_COLLECTION,
});
const edgeMemoriesStore = createMemoryStore({ config });
const cloudDocsQdrant = createQdrantClient({
  baseUrl: config.QDRANT_CLOUD_URL,
  collection: config.QDRANT_CLOUD_COLLECTION,
});
const cloudMemoriesQdrant = createQdrantClient({
  baseUrl: config.QDRANT_CLOUD_URL,
  collection: config.QDRANT_CLOUD_MEMORY_COLLECTION,
});
const cloudSyncEventsQdrant = createQdrantClient({
  baseUrl: config.QDRANT_CLOUD_URL,
  collection: config.QDRANT_CLOUD_SYNC_COLLECTION,
});
const cloudConflictsQdrant = createQdrantClient({
  baseUrl: config.QDRANT_CLOUD_URL,
  collection: config.QDRANT_CLOUD_CONFLICT_COLLECTION,
});
const cloudReviewQdrant = createQdrantClient({
  baseUrl: config.QDRANT_CLOUD_URL,
  collection: config.QDRANT_CLOUD_REVIEW_COLLECTION,
});
const cloudVerdictsQdrant = createQdrantClient({
  baseUrl: config.QDRANT_CLOUD_URL,
  collection: 'aeroedge_cloud_verdicts',
});

const pipeline = createRagPipeline({ config, ollama, qdrant: edgeDocsQdrant });
const orchestrator = createMemoryOrchestrator({
  config,
  memoryStore: edgeMemoriesStore,
  ollama,
  qdrant: edgeDocsQdrant, // the Edge Pass measures against provisioned docs
});
const syncEngine = createSyncEngine({ memoryStore: edgeMemoriesStore, deviceId: 'demo-device-01' });
const cloudSync = createCloudSyncIngest({ config, cloudMemories: cloudMemoriesQdrant, cloudSyncEvents: cloudSyncEventsQdrant });
const reconciler = createReconciler({
  memoryStore: edgeMemoriesStore,
  ledger: syncEngine.ledger,
  cloudMemories: cloudMemoriesQdrant,
  cloudConflicts: cloudConflictsQdrant,
});
const cloudJev = createCloudJev({
  config,
  ollama,
  cloudMemories: cloudMemoriesQdrant,
  cloudDocs: cloudDocsQdrant,
  cloudVerdicts: cloudVerdictsQdrant,
});
const gate = createFleetGate({
  cloudMemories: cloudMemoriesQdrant,
  cloudReview: cloudReviewQdrant,
  cloudConflicts: cloudConflictsQdrant,
  edgeMemoryStore: edgeMemoriesStore,
});

// Cloud-side operations used once at boot: seed the enterprise knowledge
// store (Phase 6, pre-trusted) and provision THIS device from it (Phase 7,
// scoped transfer of exact vectors). Both are idempotent, so restarting the
// demo never duplicates data — and the demo needs no manual data patching.
const cloudKnowledge = createCloudKnowledge({ config, ollama, qdrant: cloudDocsQdrant });
const provisioning = createProvisioning({ config, cloudQdrant: cloudDocsQdrant, edgeQdrant: edgeDocsQdrant });

if (process.env.AEROEDGE_DEMO_BOOTSTRAP !== '0') {
  await cloudKnowledge.ingestDocument({
    documentId: 'ent-std-hydraulics-b',
    text:
      'Enterprise hydraulic standard, system B: normal operating pressure is 2800-3200 PSI. ' +
      'The inlet B-nut of the pressure line is torqued to 45 N-m per fleet bulletin 88-42B. ' +
      'Overpressure above 3400 PSI opens the thermal relief valve; never operate with the relief valve seized.',
    assetId: 'FLEET-STANDARD',
    component: 'hydraulics',
    source: 'Enterprise engineering standard rev 12',
    docType: 'standard',
    equipmentModel: 'Boeing 737',
  });
  const provisioned = await provisioning.provisionEdgeDevice(
    { assetId: 'FLEET-STANDARD', component: 'hydraulics' },
    { maxChunks: 200 }
  );
  console.log(`bootstrap: enterprise store seeded; ${provisioned.transferred} chunk(s) provisioned to the edge device`);
}

const server = await startApiServer({
  port: Number(process.env.PORT ?? 8788),
  deps: {
    config,
    pipeline,
    orchestrator,
    syncEngine,
    cloudSync,
    reconciler,
    cloudJev,
    gate,
    cloudMemories: cloudMemoriesQdrant,
    deviceId: 'demo-device-01',
  },
});

console.log(`AeroEdge console: ${server.url}`);
console.log('  the device starts offline — toggle "connected" in the header when the demo reaches the reconnect step.');
