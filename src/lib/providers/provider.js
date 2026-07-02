// Model-agnostic provider contract for Ask-Your-Notes. This file is mostly the
// DESIGN CONTRACT: the controller depends on this shape, never on a concrete
// model. Concrete providers (builtin Prompt API, OpenAI-compatible HTTP) live in
// later tasks and only have to satisfy these typedefs — that indirection is what
// keeps Ask model-agnostic. Pure module: no DOM, no chrome APIs, no model here.

/**
 * A retrieval chunk as produced by chunker.js / returned by the ask index.
 * @typedef {Object} Chunk
 * @property {string} id         Stable chunk id ("<noteId>::<n>").
 * @property {string} noteId
 * @property {string} noteTitle
 * @property {string} heading    Heading breadcrumb ("Setup > Install"), '' if none.
 * @property {string} text       Cleaned text used for indexing/embedding.
 * @property {string} raw        Original markdown slice, used to build the prompt.
 * @property {number} [score]    Relevance score attached by the index at query time.
 */

/**
 * The one interface every model backend implements. `answerStream` is optional
 * and only used when `capabilities().streaming` is true (M8) — the P1 controller
 * always calls `answer`.
 * @typedef {Object} Provider
 * @property {string} id                          'builtin' | 'openai-compat'
 * @property {string} label
 * @property {() => { streaming: boolean, jsonSchema: boolean }} capabilities
 * @property {() => Promise<'available'|'downloadable'|'downloading'|'unavailable'>} availability
 * @property {(onProgress: (f: number) => void) => Promise<void>} ensureReady
 * @property {(req: AskRequest) => Promise<AskResult>} answer
 * @property {(req: AskRequest & { onToken: (t: string) => void }) => Promise<AskResult>} [answerStream]  // M8
 */

/**
 * @typedef {Object} AskRequest
 * @property {string} question
 * @property {Chunk[]} chunks              Retrieved context to ground the answer.
 * @property {AbortSignal} signal          Aborted when the ask is superseded/cancelled.
 */

/**
 * @typedef {Object} AskResult
 * @property {string} answer
 * @property {string[]} citations          Chunk ids the answer relied on.
 * @property {boolean} grounded            False when the model had nothing to cite.
 */

// The closed set of error codes a provider may surface. Frozen so it can double
// as a runtime allow-list without risk of accidental mutation.
export const ASK_ERROR_CODES = Object.freeze([
  'unavailable',
  'auth',
  'context-overflow',
  'bad-json',
  'network',
  'model-error',
  'aborted',
]);

// Typed error a provider throws so the controller can map failures to a stable
// `code` (see ASK_ERROR_CODES) instead of sniffing message strings.
export class AskError extends Error {
  /**
   * @param {string} code   One of ASK_ERROR_CODES.
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'AskError';
    this.code = code;
  }
}
