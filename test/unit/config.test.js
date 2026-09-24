'use strict';

/**
 * Unit tests for shared/config.js:
 * required keys are read from env / .env files with correct precedence, and
 * missing or empty required variables fail with a clear, specific error.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REQUIRED_KEYS,
  ConfigError,
  parseEnvFile,
  loadConfig,
} from '../../shared/config.js';

const FULL_ENV = Object.freeze({
  OLLAMA_MODEL: 'llama3.1:8b',
  EMBEDDING_MODEL: 'nomic-embed-text',
  QDRANT_EDGE_URL: 'http://localhost:6333',
  QDRANT_CLOUD_URL: 'http://localhost:6334',
});

test('REQUIRED_KEYS matches the .env.example contract', () => {
  assert.deepEqual(
    [...REQUIRED_KEYS],
    ['OLLAMA_MODEL', 'EMBEDDING_MODEL', 'QDRANT_EDGE_URL', 'QDRANT_CLOUD_URL']
  );
});

test('loads all required vars from a complete env', () => {
  const config = loadConfig({ env: FULL_ENV });
  assert.equal(config.OLLAMA_MODEL, 'llama3.1:8b');
  assert.equal(config.EMBEDDING_MODEL, 'nomic-embed-text');
  assert.equal(config.QDRANT_EDGE_URL, 'http://localhost:6333');
  assert.equal(config.QDRANT_CLOUD_URL, 'http://localhost:6334');
});

test('loads values from a .env file when env does not provide them', () => {
  const env = {
    ...FULL_ENV,
    QDRANT_EDGE_URL: undefined,
    QDRANT_CLOUD_URL: undefined,
  };
  const config = loadConfig({
    envFile: '.env.example',
    env: /** @type {Record<string, string|undefined>} */ (env),
  });
  // .env.example ships these defaults.
  assert.equal(config.QDRANT_EDGE_URL, 'http://localhost:6333');
  assert.equal(config.QDRANT_CLOUD_URL, 'http://localhost:6334');
});

test('real env overrides .env file values; optional overrides both', () => {
  const config = loadConfig({
    envFile: '.env.example',
    env: { ...FULL_ENV, EMBEDDING_MODEL: 'bge-m3' },
    optional: { OLLAMA_MODEL: 'qwen2.5:14b' },
  });
  assert.equal(config.OLLAMA_MODEL, 'qwen2.5:14b'); // optional wins
  assert.equal(config.EMBEDDING_MODEL, 'bge-m3'); // env beats file
  assert.equal(config.QDRANT_EDGE_URL, 'http://localhost:6333'); // file fills gap
});

test('throws a specific error naming the missing variable', () => {
  const { OLLAMA_MODEL, ...partial } = FULL_ENV;
  assert.throws(
    () => loadConfig({ env: partial }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /OLLAMA_MODEL/);
      assert.match(err.message, /Missing required environment variable/);
      return true;
    }
  );
});

test('throws naming every missing variable at once', () => {
  assert.throws(
    () => loadConfig({ env: { OLLAMA_MODEL: 'llama3.1:8b' } }),
    (err) => {
      assert.match(err.message, /EMBEDDING_MODEL/);
      assert.match(err.message, /QDRANT_EDGE_URL/);
      assert.match(err.message, /QDRANT_CLOUD_URL/);
      return true;
    }
  );
});

test('throws a specific error for a whitespace-only value', () => {
  assert.throws(
    () => loadConfig({ env: { ...FULL_ENV, EMBEDDING_MODEL: '   ' } }),
    (err) => {
      assert.match(err.message, /EMBEDDING_MODEL/);
      assert.match(err.message, /empty/i);
      return true;
    }
  );
});

test('requireAll: false omits missing keys instead of throwing', () => {
  const { QDRANT_CLOUD_URL, ...partial } = FULL_ENV;
  const config = loadConfig({ env: partial, requireAll: false });
  assert.equal(config.QDRANT_EDGE_URL, 'http://localhost:6333');
  assert.equal(config.QDRANT_CLOUD_URL, undefined);
});

test('parseEnvFile throws a clear error for a nonexistent file', () => {
  assert.throws(() => parseEnvFile('no/such/file.env'), (err) => {
    assert.ok(err instanceof ConfigError);
    assert.match(err.message, /not found/);
    assert.match(err.message, /no\/such\/file\.env/);
    return true;
  });
});

test('returned config is frozen', () => {
  const config = loadConfig({ env: FULL_ENV });
  assert.ok(Object.isFrozen(config));
});

test('trims surrounding whitespace from values', () => {
  const config = loadConfig({
    env: { ...FULL_ENV, OLLAMA_MODEL: '  llama3.1:8b  ' },
  });
  assert.equal(config.OLLAMA_MODEL, 'llama3.1:8b');
});
