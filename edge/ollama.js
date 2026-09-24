'use strict';

/**
 * Minimal Ollama client for the offline path.
 *
 * Two operations only: embedding (batch) and generation (non-streaming).
 * No SDKs, no retries-with-backoff magic — edge devices run against a local
 * daemon on loopback; if it is down, that is an operational error to surface.
 *
 * `fetch` is injectable so tests can exercise the full wiring without a
 * running Ollama daemon, and so the offline-only guarantee is auditable:
 * the only network function used here is the injected/standard fetch, and
 * every URL it touches is built from the configured Ollama base URL.
 */

/**
 * @typedef {Object} OllamaClientOptions
 * @property {string} baseUrl Ollama base URL, e.g. http://127.0.0.1:11434.
 * @property {string} embedModel Embedding model name (Ollama tag).
 * @property {string} generateModel Generation model name (Ollama tag).
 * @property {typeof fetch} [fetchImpl] Injectable fetch (defaults to globalThis.fetch).
 */

/** Error thrown for any Ollama communication or response-shape problem. */
export class OllamaError extends Error {
  /**
   * @param {string} message
   * @param {number} [status]
   */
  constructor(message, status) {
    super(message);
    this.name = 'OllamaError';
    this.status = status;
  }
}

/**
 * @param {OllamaClientOptions} options
 */
export function createOllamaClient({ baseUrl, embedModel, generateModel, fetchImpl = globalThis.fetch }) {
  const base = baseUrl.replace(/\/+$/, '');

  /**
   * @param {string} path
   * @param {unknown} body
   * @returns {Promise<any>}
   */
  async function postJson(path, body) {
    /** @type {Response} */
    let res;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new OllamaError(
        `Cannot reach Ollama at ${base}${path}: ${/** @type {Error} */ (err).message}`
      );
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new OllamaError(
        `Ollama ${path} failed (HTTP ${res.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`,
        res.status
      );
    }
    try {
      return await res.json();
    } catch (err) {
      throw new OllamaError(`Ollama ${path} returned invalid JSON: ${/** @type {Error} */ (err).message}`);
    }
  }

  return {
    /** @type {string} */
    baseUrl: base,

    /**
     * Embed one or more texts with the configured embedding model.
     * @param {string | string[]} input
     * @returns {Promise<number[][]>} One embedding vector per input, same order.
     */
    async embed(input) {
      const inputs = Array.isArray(input) ? input : [input];
      if (inputs.length === 0) return [];
      for (const text of inputs) {
        if (typeof text !== 'string' || text.trim() === '') {
          throw new OllamaError('embed() requires non-empty string input(s)');
        }
      }
      const data = await postJson('/api/embed', { model: embedModel, input: inputs });
      const embeddings = /** @type {{ embeddings?: unknown }} */ (data).embeddings;
      if (
        !Array.isArray(embeddings) ||
        embeddings.length !== inputs.length ||
        !embeddings.every(
          (vec) => Array.isArray(vec) && vec.length > 0 && vec.every((n) => typeof n === 'number' && Number.isFinite(n))
        )
      ) {
        throw new OllamaError(
          `Ollama /api/embed returned an unexpected shape for model "${embedModel}" ` +
            `(expected ${inputs.length} non-empty numeric vector(s))`
        );
      }
      return embeddings;
    },

    /**
     * Generate a completion for a prompt (non-streaming).
     * @param {Object} opts
     * @param {string} opts.prompt
     * @param {string} [opts.system]
     * @returns {Promise<string>} The generated text.
     */
    async generate({ prompt, system }) {
      if (typeof prompt !== 'string' || prompt.trim() === '') {
        throw new OllamaError('generate() requires a non-empty prompt');
      }
      const data = await postJson('/api/generate', {
        model: generateModel,
        prompt,
        ...(system !== undefined ? { system } : {}),
        stream: false,
      });
      const response = /** @type {{ response?: unknown }} */ (data).response;
      if (typeof response !== 'string') {
        throw new OllamaError(
          `Ollama /api/generate returned no response text for model "${generateModel}"`
        );
      }
      return response;
    },
  };
}
