'use strict';

/**
 * AeroEdge shared configuration loader.
 *
 * Single source of truth for environment-derived settings on both sides
 * (edge and cloud). Later phases import `loadConfig()` instead of reading
 * `process.env` ad hoc, so a misconfigured environment fails loudly and
 * specifically at startup rather than mysteriously mid-operation.
 *
 * Node >= 20.12 provides `util.parseEnv` for .env files, so no dependencies.
 */

import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

/** Variables every AeroEdge process (edge or cloud) requires. */
export const REQUIRED_KEYS = Object.freeze([
  'OLLAMA_MODEL',
  'EMBEDDING_MODEL',
  'QDRANT_EDGE_URL',
  'QDRANT_CLOUD_URL',
]);

/**
 * Keys with sensible defaults (added in Phase 1). They are NOT required:
 * when absent from env/file/optional, these values are filled in so callers
 * can rely on them always being present in the returned config.
 */
export const OPTIONAL_DEFAULTS = Object.freeze({
  OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
  QDRANT_EDGE_COLLECTION: 'aeroedge_edge_docs',
  // Phase 4: technician memories live in their OWN Edge collection —
  // architecturally separate from authoritative document chunks so field
  // knowledge can never silently blend into reference truth.
  QDRANT_EDGE_MEMORY_COLLECTION: 'aeroedge_edge_memories',
  // Phase 6: the Cloud knowledge store is a SEPARATE Qdrant instance
  // (QDRANT_CLOUD_URL) AND a separate collection from anything on the edge.
  // Enterprise documents arrive pre-trusted: ingestion stamps
  // jev_status 'not_applicable' — no JEV pass on controlled enterprise input.
  QDRANT_CLOUD_COLLECTION: 'aeroedge_cloud_docs',
  // Phase 8: cloud-side stores for synced technician knowledge and the sync
  // audit trail. Separate from enterprise documents (different trust path:
  // synced field memories arrive edge-JEV'd, fleet-truth only after the
  // Phase 10 Cloud Pass) and from the edge instance entirely.
  QDRANT_CLOUD_MEMORY_COLLECTION: 'aeroedge_cloud_memories',
  QDRANT_CLOUD_SYNC_COLLECTION: 'aeroedge_cloud_sync_events',
  // Phase 9: open Conflict records (detected version divergence between an
  // edge and the cloud). Detection only — resolution is JEV-recommended and
  // human-confirmed in Phase 10.
  QDRANT_CLOUD_CONFLICT_COLLECTION: 'aeroedge_cloud_conflicts',
  // Phase 10: the human-review queue for Cloud Pass needs_human_review
  // verdicts — never auto-propagated; a human decides.
  QDRANT_CLOUD_REVIEW_COLLECTION: 'aeroedge_cloud_review_queue',
});

/** Error thrown for any configuration problem (missing file, missing or empty variable). */
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Parse a .env-format file (comments, blank lines, quoted values).
 * Throws ConfigError with an actionable message if the file cannot be read.
 * @param {string} filePath
 * @returns {Record<string, string>}
 */
export function parseEnvFile(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
      throw new ConfigError(
        `Environment file not found: "${filePath}". ` +
          'Create it from .env.example (cp .env.example .env) or pass a valid envFile path.'
      );
    }
    throw new ConfigError(`Could not read environment file "${filePath}": ${err.message}`);
  }
  return parseEnv(raw);
}

/**
 * Load configuration.
 *
 * Precedence (highest wins): `optional` overrides `env` overrides file values.
 * Real process environment should override .env-file values, so callers pass
 * `env: process.env` (the default) together with `envFile`.
 *
 * @param {Object} [options]
 * @param {string} [options.envFile] Path to a .env file to parse first.
 * @param {Record<string, string|undefined>} [options.env] Environment variables; defaults to process.env.
 * @param {boolean} [options.requireAll=true] When false, missing required keys are omitted instead of throwing.
 * @param {Record<string, string>} [options.optional] Extra keys to carry through (also a test escape hatch).
 * @returns {Readonly<Record<string, string>>} Frozen config object.
 * @throws {ConfigError} If a required variable is missing or empty (when requireAll).
 */
export function loadConfig({
  envFile,
  env = process.env,
  requireAll = true,
  optional = {},
} = {}) {
  const fileValues = envFile ? parseEnvFile(envFile) : {};
  // Treat undefined/null env entries as "not provided" so they don't clobber
  // values from the .env file (e.g. `{ ...process.env, KEY: undefined }`).
  const envValues = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value !== null) envValues[key] = value;
  }
  const merged = { ...fileValues, ...envValues, ...optional };
  // Fill defaults AFTER validation so a var that is provided but empty is
  // still an error, while a var that is simply absent gets its default.
  const effective = { ...OPTIONAL_DEFAULTS, ...merged };

  // Validate required keys (must be present) AND defaulted keys (must not
  // be present-but-empty); absent defaulted keys get their default below.
  const checkKeys = [...REQUIRED_KEYS, ...Object.keys(OPTIONAL_DEFAULTS)];
  const missing = [];
  const empty = [];
  for (const key of checkKeys) {
    const value = merged[key];
    if (value === undefined || value === null) {
      if (REQUIRED_KEYS.includes(key)) missing.push(key);
    } else if (String(value).trim() === '') {
      empty.push(key);
    }
  }

  if (requireAll && missing.length > 0) {
    throw new ConfigError(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
        `All of [${REQUIRED_KEYS.join(', ')}] must be set. ` +
        `Provide them via the environment or a .env file${envFile ? ` ("${envFile}")` : ''}; see .env.example.`
    );
  }
  if (requireAll && empty.length > 0) {
    throw new ConfigError(
      `Environment variable(s) set to an empty value: ${empty.join(', ')}. ` +
        'They must have real values; see .env.example.'
    );
  }

  /** @type {Record<string, string>} */
  const config = {};
  for (const key of Object.keys(OPTIONAL_DEFAULTS)) {
    config[key] = String(effective[key]).trim();
  }
  for (const key of REQUIRED_KEYS) {
    if (merged[key] !== undefined && merged[key] !== null) {
      config[key] = String(merged[key]).trim();
    }
  }
  for (const [key, value] of Object.entries(optional)) {
    config[key] = String(value);
  }
  return Object.freeze(config);
}
