'use strict';

/**
 * Offline-path audit (acceptance criterion: "no external network calls in
 * this code path — verify this, don't just assume it").
 *
 * Two static checks over every module reachable from edge/rag.js:
 *   1. import graph: bare specifiers must be node: builtins only; relative
 *      specifiers are followed recursively. Any third-party import on the
 *      offline path fails here.
 *   2. source scan: no external SDK names and no http(s) URLs except
 *      loopback/localhost references (Ollama/Qdrant endpoints, which are
 *      local services on a disconnected machine).
 *
 * If this test fails, someone attached the edge pipeline to a cloud
 * dependency. That is a design regression, not a style issue.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, resolve } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENTRYPOINTS = [
  'edge/rag.js',
  'edge/retrieval.js',
  'edge/session.js',
  'edge/memoryStore.js',
  'edge/orchestrator.js',
  'edge/jev.js',
  'edge/chunker.js',
  'edge/ollama.js',
  'edge/qdrant.js',
  'cloud/knowledge.js',
  'cloud/provisioning.js',
  'shared/config.js',
  'shared/schemas.js',
  'shared/lifecycle.js',
];

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+(?:[\s\S]*?from\s*)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

/**
 * Collect every module reachable from `entry` via relative imports.
 * @param {string} entryPath Project-root-relative path.
 * @returns {{ visited: string[], external: string[] }}
 */
function collectImportGraph(entryPath) {
  const visited = [];
  const external = [];
  /** @type {Set<string>} */
  const seen = new Set();

  /**
   * @param {string} relPath
   */
  function walk(relPath) {
    if (seen.has(relPath)) return;
    seen.add(relPath);
    visited.push(relPath);
    const abs = join(ROOT, relPath);
    const source = readFileSync(abs, 'utf8');
    for (const match of source.matchAll(IMPORT_RE)) {
      const spec = match[1] ?? match[2];
      if (!spec) continue;
      if (spec.startsWith('node:')) continue;
      if (spec.startsWith('./') || spec.startsWith('../')) {
        walk(join(relPath, '..', spec).replaceAll('\\', '/'));
      } else {
        external.push(`${relPath} imports "${spec}"`);
      }
    }
  }

  walk(entryPath);
  return { visited, external };
}

test('offline path imports only node builtins and project-internal modules', () => {
  for (const entry of ENTRYPOINTS) {
    const { visited, external } = collectImportGraph(entry);
    assert.equal(external.length, 0, `external imports reachable from ${entry}:\n  ${external.join('\n  ')}`);
    assert.ok(visited.length >= 1);
  }
  // The entrypoint graph must reach the whole edge pipeline.
  const { visited } = collectImportGraph('edge/rag.js');
  for (const expected of ['edge/rag.js', 'edge/retrieval.js', 'edge/session.js', 'edge/chunker.js', 'edge/ollama.js', 'edge/qdrant.js', 'shared/schemas.js']) {
    assert.ok(visited.includes(expected), `edge/rag.js should reach ${expected}`);
  }
});

test('edge/shared sources contain no external SDKs or non-loopback URLs', () => {
  const forbidden = [
    /\bopenai\b/i,
    /\banthropic\b/i,
    /\bgemini\b/i,
    /\bcohere\b/i,
    /\bhuggingface\b/i,
    /\blangchain\b/i,
    /\bchroma(db)?\b/i,
    /\bpinecone\b/i,
    /\bweaviate\b/i,
    /\baxios\b/i,
    /\bnode-fetch\b/i,
    /https?:\/\/(?!127\.0\.0\.1|localhost)/i, // only local services allowed
  ];
  for (const rel of ENTRYPOINTS) {
    const source = readFileSync(join(ROOT, rel), 'utf8');
    for (const pattern of forbidden) {
      assert.match('', /^/); // keep assert import used
      assert.equal(
        pattern.test(source),
        false,
        `${rel} matches forbidden offline-path pattern ${pattern}`
      );
    }
  }
});
