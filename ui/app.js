/* AeroEdge — Phase 11 UI logic. Vanilla JS, no framework.
 * Every panel talks to the SAME /api endpoints the e2e demo drives. */

'use strict';

/** @param {string} url @param {RequestInit} [opts] */
async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'content-type': 'application/json' },
    ...opts,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

/** @param {string} status */
function badge(status) {
  const span = document.createElement('span');
  span.className = `badge badge-${status}`;
  span.textContent = status.replaceAll('_', ' ');
  return span;
}

/** @param {string} text @param {number} max */
function clip(text, max = 160) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function showError(err) {
  alert(`AeroEdge: ${err instanceof Error ? err.message : String(err)}`);
}

/* ---------- connectivity (connected/offline indicator) ---------- */

const connectionBox = /** @type {HTMLElement} */ (document.getElementById('connection-box'));
const connectionLabel = /** @type {HTMLElement} */ (document.getElementById('connection-label'));

/** @param {boolean} connected */
function renderConnection(connected) {
  connectionBox.dataset.connected = String(connected);
  connectionLabel.textContent = connected ? 'connected' : 'offline — edge-only mode';
}

async function refreshHealth() {
  try {
    const health = await api('/api/health');
    renderConnection(health.connected === true);
    const modelLine = document.getElementById('model-line');
    if (modelLine) {
      modelLine.textContent =
        `device: ${health.deviceId} · model: ${health.model} · embeddings: ${health.embeddingModel}`;
    }
    renderSession(health.session);
  } catch {
    renderConnection(false);
  }
}

document.getElementById('btn-toggle-connection')?.addEventListener('click', async () => {
  try {
    const current = connectionBox.dataset.connected === 'true';
    await api('/api/connection', { method: 'POST', body: JSON.stringify({ connected: !current }) });
    await refreshHealth();
  } catch (err) {
    showError(err);
  }
});

/* ---------- session / diagnostic context indicator (Phase 3) ---------- */

/** @param {any} session */
function renderSession(session) {
  const box = document.getElementById('session-box');
  if (!box || !session) return;
  box.classList.remove('hidden');
  const id = document.getElementById('session-id');
  const line = document.getElementById('session-context-line');
  if (id) id.textContent = `· ${session.sessionId.slice(0, 12)}`;
  if (line) {
    const bits = [
      session.assetId ? `asset ${session.assetId}` : null,
      session.component ? `subsystem ${session.component}` : null,
      session.issue ? `issue: ${session.issue}` : null,
      `${session.recentQueries.length} recent quer${session.recentQueries.length === 1 ? 'y' : 'ies'}`,
      `${session.observations.length} observation${session.observations.length === 1 ? '' : 's'}`,
    ].filter(Boolean);
    line.textContent = bits.join(' · ');
  }
}

/* ---------- query + grounded answer with evidence (Phases 1–3) ---------- */

document.getElementById('query-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = /** @type {HTMLInputElement} */ (document.getElementById('query-input'));
  const query = input.value.trim();
  if (query === '') return;
  try {
    const out = await api('/api/query', { method: 'POST', body: JSON.stringify({ query }) });
    const box = document.getElementById('answer-box');
    const text = document.getElementById('answer-text');
    const list = document.getElementById('evidence-list');
    if (!box || !text || !list) return;
    box.classList.remove('hidden');
    text.textContent = out.answer;
    list.replaceChildren(
      ...out.citations.map((c) => {
        const li = document.createElement('li');
        li.innerHTML = '';
        const head = document.createElement('div');
        head.className = 'evidence-head';
        const left = document.createElement('span');
        left.textContent = c.source ?? c.documentId;
        const right = document.createElement('span');
        right.textContent = c.version ? `v${c.version}` : c.documentId;
        head.append(left, right);
        li.append(head);
        return li;
      }),
      ...out.evidence.chunks.map((chunk) => {
        const li = document.createElement('li');
        const head = document.createElement('div');
        head.className = 'evidence-head';
        const src = document.createElement('span');
        src.textContent = `${chunk.source ?? chunk.documentId}${chunk.component ? ` · ${chunk.component}` : ''}`;
        const score = document.createElement('span');
        score.textContent = `score ${chunk.score.toFixed(3)}${chunk.keywordScore !== undefined ? ` (kw ${chunk.keywordScore.toFixed(2)})` : ''}`;
        head.append(src, score);
        const preview = document.createElement('p');
        preview.className = 'chunk-preview';
        preview.textContent = clip(chunk.content);
        li.append(head, preview);
        return li;
      })
    );
    await refreshHealth(); // session indicator updates as queries land
  } catch (err) {
    showError(err);
  }
});

/* ---------- capture + immediate Edge JEV verdict (Phases 4–5) ---------- */

document.getElementById('capture-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const contentEl = /** @type {HTMLTextAreaElement} */ (document.getElementById('capture-content'));
  const sourceEl = /** @type {HTMLInputElement} */ (document.getElementById('capture-source'));
  const content = contentEl.value.trim();
  if (content === '') return;
  try {
    const out = await api('/api/capture', {
      method: 'POST',
      body: JSON.stringify({ content, ...(sourceEl.value.trim() ? { source: sourceEl.value.trim() } : {}) }),
    });
    const box = document.getElementById('verdict-box');
    const badgeEl = document.getElementById('verdict-badge');
    const confEl = document.getElementById('verdict-confidence');
    const ratEl = document.getElementById('verdict-rationale');
    const routeEl = document.getElementById('verdict-route');
    if (!box || !badgeEl || !confEl || !ratEl || !routeEl) return;
    box.classList.remove('hidden', 'accept_local', 'flag_risk');
    box.classList.add(String(out.verdict.verdict));
    badgeEl.className = `badge badge-${out.verdict.verdict}`;
    badgeEl.textContent = `edge JEV: ${out.verdict.verdict.replaceAll('_', ' ')}`;
    confEl.textContent = `confidence ${out.verdict.confidence}`;
    ratEl.textContent = out.verdict.rationale;
    routeEl.textContent = out.applied
      ? `routed: ${out.applied.action.toLowerCase().replaceAll('_', ' ')} (${out.applied.transitions.join(', ') || 'no transitions'})`
      : 'routed: stored without routing';
    contentEl.value = '';
    await refreshMemories();
  } catch (err) {
    showError(err);
  }
});

/* ---------- memory dashboard + sync status (Phases 4, 8) ---------- */

/** @param {any} memory */
function memoryItem(memory) {
  const li = document.createElement('li');
  const head = document.createElement('div');
  head.className = 'memory-head';
  const id = document.createElement('span');
  id.className = 'muted';
  id.textContent = memory.memory_id.slice(0, 14);
  head.append(id, badge(memory.memory_type), badge(memory.lifecycle_status), badge(memory.jev_status));
  const content = document.createElement('p');
  content.className = 'memory-content';
  content.textContent = clip(memory.content);
  li.append(head, content);
  // Synced field observations can get the fleet-aware Cloud Pass here —
  // the verdict is shown immediately and never auto-propagates by itself.
  if (memory.memory_type === 'field_observation' && memory.sync_status === 'synced' && memory.jev_status !== 'validated' && memory.jev_status !== 'rejected') {
    const cloudBtn = document.createElement('button');
    cloudBtn.className = 'btn btn-ghost btn-small';
    cloudBtn.type = 'button';
    cloudBtn.textContent = 'run cloud JEV pass';
    cloudBtn.addEventListener('click', async () => {
      try {
        const out = await api('/api/cloud/jev', { method: 'POST', body: JSON.stringify({ memoryId: memory.memory_id }) });
        const line = document.createElement('p');
        line.className = 'memory-content';
        line.append(
          badge(out.verdict.verdict),
          Object.assign(document.createElement('span'), {
            className: 'muted',
            textContent: ` ${out.verdict.confidence} · ${out.applied.action}${out.applied.queueId ? ' (queued)' : ''} — ${clip(out.verdict.rationale, 180)}`,
          })
        );
        cloudBtn.replaceWith(line);
        await Promise.all([refreshMemories(), refreshReviewQueue()]);
      } catch (err) {
        showError(err);
      }
    });
    li.append(cloudBtn);
  }
  return li;
}

async function refreshMemories() {
  const list = document.getElementById('memories-list');
  if (!list) return;
  try {
    const { memories } = await api('/api/memories?limit=50');
    list.replaceChildren(...memories.map(memoryItem));
  } catch (err) {
    showError(err);
  }
}

async function refreshPendingChanges() {
  const box = document.getElementById('sync-box');
  const list = document.getElementById('sync-pending-list');
  const outcome = document.getElementById('sync-outcome');
  if (!box || !list || !outcome) return;
  try {
    const { pending, scanned } = await api('/api/sync/changes');
    box.classList.remove('hidden');
    outcome.classList.add('hidden');
    list.replaceChildren(
      ...(pending.length === 0
        ? [Object.assign(document.createElement('li'), { textContent: 'no pending changes — everything is synced' })]
        : pending.map((m) => {
            const li = document.createElement('li');
            const head = document.createElement('div');
            head.className = 'memory-head';
            const id = document.createElement('span');
            id.className = 'muted';
            id.textContent = m.memoryId.slice(0, 14);
            head.append(id, badge(m.jevStatus), badge(m.lifecycleStatus));
            const content = document.createElement('p');
            content.className = 'memory-content';
            content.textContent = clip(m.content);
            const elig = document.createElement('span');
            elig.className = 'muted';
            elig.textContent = m.syncEligible ? 'sync-eligible' : 'not sync-eligible (verdict gate)';
            li.append(head, content, elig);
            return li;
          }))
    );
    void scanned;
  } catch (err) {
    showError(err);
  }
}

async function syncDelta() {
  const outcome = document.getElementById('sync-outcome');
  if (!outcome) return;
  try {
    const out = await api('/api/sync/delta', { method: 'POST' });
    outcome.classList.remove('hidden');
    const c = out.classification?.counts ?? {};
    const o = out.outcome ?? {};
    outcome.textContent =
      `delta: ${out.items.length} item(s) from ${out.deviceId}\n` +
      `classified: ${c.EDGE_NEW ?? 0} edge-new, ${c.CLOUD_NEWER ?? 0} cloud-newer, ${c.DIVERGED ?? 0} diverged, ${c.IDENTICAL ?? 0} identical\n` +
      `outcome: ${o.uploaded ?? 0} uploaded, ${o.adopted ?? 0} adopted, ${o.conflicts ?? 0} conflict(s) opened, ${o.deduped ?? 0} deduped`;
    await Promise.all([refreshMemories(), refreshConflicts()]);
  } catch (err) {
    showError(err);
  }
}

/* ---------- conflicts (Phases 9–10) — explicit human actions only ---------- */

/** @param {any} conflict */
function conflictItem(conflict) {
  const li = document.createElement('li');
  const head = document.createElement('div');
  head.className = 'memory-head';
  const id = document.createElement('span');
  id.className = 'muted';
  id.textContent = String(conflict.memory_id).slice(0, 14);
  head.append(id, badge(conflict.status));
  const versions = document.createElement('div');
  versions.className = 'conflict-versions';
  const edge = document.createElement('div');
  edge.innerHTML = '';
  edge.append(Object.assign(document.createElement('strong'), { textContent: `edge ${conflict.edge_version}` }));
  const cloud = document.createElement('div');
  cloud.append(Object.assign(document.createElement('strong'), { textContent: `cloud ${conflict.cloud_version}` }));
  versions.append(edge, cloud);
  const details = document.createElement('button');
  details.className = 'btn btn-ghost btn-small';
  details.type = 'button';
  details.textContent = 'Review Details';
  details.addEventListener('click', () => openConflictDialog(conflict));
  li.append(head, versions, details);
  return li;
}

async function refreshConflicts() {
  const list = document.getElementById('conflicts-list');
  if (!list) return;
  try {
    const { conflicts } = await api('/api/conflicts');
    list.replaceChildren(
      ...(conflicts.length === 0
        ? [Object.assign(document.createElement('li'), { textContent: 'no open conflicts' })]
        : conflicts.map(conflictItem))
    );
  } catch (err) {
    showError(err);
  }
}

const dialog = /** @type {HTMLDialogElement} */ (document.getElementById('conflict-dialog'));

/** @param {any} conflict */
function openConflictDialog(conflict) {
  const details = document.getElementById('conflict-details');
  const recLine = document.getElementById('conflict-recommendation');
  if (!details || !recLine) return;
  details.replaceChildren();
  const versions = document.createElement('div');
  versions.className = 'conflict-versions';
  const edge = document.createElement('div');
  edge.append(Object.assign(document.createElement('strong'), { textContent: `Edge version (${conflict.edge_version})` }));
  edge.append(Object.assign(document.createElement('p'), { textContent: clip(String(conflict.edge_content ?? conflict.content ?? '(edge content unavailable)'), 400) }));
  const cloud = document.createElement('div');
  cloud.append(Object.assign(document.createElement('strong'), { textContent: `Cloud version (${conflict.cloud_version})` }));
  cloud.append(Object.assign(document.createElement('p'), { textContent: clip(String(conflict.cloud_content ?? conflict.content ?? '(cloud content unavailable)'), 400) }));
  versions.append(edge, cloud);
  details.append(versions);
  const rec = conflict.jev_recommendation;
  const hasRealRec =
    rec && typeof rec === 'object' &&
    typeof rec.verdict === 'string' && rec.verdict.trim() !== '' &&
    !/Phase 9 version reconciliation/.test(String(rec.rationale ?? ''));
  recLine.textContent = hasRealRec
    ? `JEV recommends: ${rec.verdict.replaceAll('_', ' ')} — ${rec.rationale}`
    : 'No JEV recommendation yet — compute it below, then decide. Nothing is applied automatically.';
  const apply = /** @type {HTMLButtonElement} */ (document.getElementById('btn-apply-cloud'));
  const keep = /** @type {HTMLButtonElement} */ (document.getElementById('btn-keep-edge'));
  const compute = /** @type {HTMLButtonElement} */ (document.getElementById('btn-compute-rec'));
  apply.disabled = !hasRealRec;
  keep.disabled = !hasRealRec;
  compute.disabled = hasRealRec;
  compute.onclick = async () => {
    try {
      const { conflict: updated } = await api(`/api/conflicts/${encodeURIComponent(String(conflict.conflict_id))}/recommend`, { method: 'POST', body: '{}' });
      const rec2 = updated.jev_recommendation;
      recLine.textContent = `JEV recommends: ${String(rec2.verdict).replaceAll('_', ' ')} — ${String(rec2.rationale)}`;
      apply.disabled = false;
      keep.disabled = false;
      compute.disabled = true;
    } catch (err) {
      showError(err);
    }
  };
  apply.onclick = () => confirmResolution(conflict, 'cloud');
  keep.onclick = () => confirmResolution(conflict, 'edge');
  dialog.showModal();
}

/** @param {any} conflict @param {'edge'|'cloud'} winner */
async function confirmResolution(conflict, winner) {
  const resolvedBy = window.prompt('Confirm as (your name):', 'fleet-engineer');
  if (resolvedBy === null) return; // cancelled — nothing applied
  try {
    await api(`/api/conflicts/${encodeURIComponent(String(conflict.conflict_id))}/confirm`, {
      method: 'POST',
      body: JSON.stringify({
        resolvedBy,
        winner,
        resolution: winner === 'cloud'
          ? 'Human confirmed: adopt the cloud version (fleet-correct).'
          : 'Human confirmed: keep the edge version (field reality).',
      }),
    });
    dialog.close();
    await refreshConflicts();
  } catch (err) {
    showError(err);
  }
}

document.getElementById('btn-close-dialog')?.addEventListener('click', () => dialog.close());

/* ---------- human review queue (Phase 10) ---------- */

async function refreshReviewQueue() {
  const list = document.getElementById('review-list');
  if (!list) return;
  try {
    const { queue } = await api('/api/review-queue');
    list.replaceChildren(
      ...(queue.length === 0
        ? [Object.assign(document.createElement('li'), { textContent: 'queue is empty' })]
        : queue.map((entry) => {
            const li = document.createElement('li');
            const head = document.createElement('div');
            head.className = 'memory-head';
            const id = document.createElement('span');
            id.className = 'muted';
            id.textContent = String(entry.memory_id ?? '').slice(0, 14);
            head.append(id, badge('needs_human_review'));
            const content = document.createElement('p');
            content.className = 'memory-content';
            content.textContent = clip(String(entry.memory_snapshot?.content ?? ''), 200);
            const rationale = document.createElement('p');
            rationale.className = 'muted';
            rationale.textContent = clip(String(entry.verdict?.rationale ?? ''), 220);
            li.append(head, content, rationale);
            return li;
          }))
    );
  } catch (err) {
    showError(err);
  }
}

/* ---------- wire static buttons + boot ---------- */

document.getElementById('btn-refresh-memories')?.addEventListener('click', refreshMemories);
document.getElementById('btn-sync-changes')?.addEventListener('click', refreshPendingChanges);
document.getElementById('btn-sync-delta')?.addEventListener('click', syncDelta);
document.getElementById('btn-refresh-conflicts')?.addEventListener('click', refreshConflicts);
document.getElementById('btn-refresh-review')?.addEventListener('click', refreshReviewQueue);

refreshHealth();
refreshMemories();
refreshConflicts();
refreshReviewQueue();
setInterval(refreshHealth, 8000);
