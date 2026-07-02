// The built-in on-device AI provider: Gemini Nano on Chrome, Phi-4-mini on Edge,
// reached through the browser Prompt API global `globalThis.LanguageModel`
// (Plan §5.4). It satisfies the model-agnostic Provider contract (provider.js)
// and builds every request from the shared prompting helpers (prompting.js).
// Pure feature-detection — never sniff the user agent.

import { AskError } from './provider.js';
import {
  SYSTEM_PROMPT,
  ANSWER_SCHEMA,
  packChunks,
  buildUserPrompt,
  parseAnswer,
} from './prompting.js';

// Feature-detect the Prompt API. Read fresh every time it matters: the global
// can appear (post-download) or vanish (Edge evicts the model under low disk)
// during a session, so nothing about it may be cached.
function hasPromptApi() {
  return typeof globalThis.LanguageModel !== 'undefined';
}

/**
 * Map the browser's availability string to our provider enum. Accepts both the
 * current vocabulary and the legacy Chrome vocabulary, and treats anything
 * unrecognized as 'unavailable'.
 * @returns {'available'|'downloadable'|'downloading'|'unavailable'}
 */
function mapAvailability(raw) {
  switch (raw) {
    case 'available':
    case 'readily': // legacy vocab
      return 'available';
    case 'downloadable':
    case 'after-download': // legacy vocab
      return 'downloadable';
    case 'downloading':
      return 'downloading';
    default: // 'unavailable', legacy 'no', or any unknown string
      return 'unavailable';
  }
}

// True when a caught error is (or was caused by) an abort. Detect both the
// DOMException/AbortError the Prompt API rejects with AND an already-aborted
// signal, so a cancelled ask always surfaces as AskError('aborted').
function isAbort(err, signal) {
  if (signal && signal.aborted) return true;
  return !!err && err.name === 'AbortError';
}

/**
 * @returns {Promise<'available'|'downloadable'|'downloading'|'unavailable'>}
 */
async function availability() {
  // NEVER cache and NEVER throw: no global -> unavailable; any failure probing
  // availability() -> unavailable. Re-probe every call because Edge can evict
  // the on-device model under disk pressure, making a stale 'available' a lie.
  if (!hasPromptApi()) return 'unavailable';
  let raw;
  try {
    raw = await globalThis.LanguageModel.availability();
  } catch {
    return 'unavailable';
  }
  return mapAvailability(raw);
}

/**
 * Trigger/await the on-device model download. MUST be called from a user
 * gesture — the browser only permits the download under user activation, which
 * the panel (T8) guarantees. Forwards download progress (0..1) to onProgress.
 * @param {(fraction: number) => void} [onProgress]
 * @returns {Promise<void>}
 */
async function ensureReady(onProgress) {
  if (!hasPromptApi()) throw new AskError('unavailable');
  const report = typeof onProgress === 'function' ? onProgress : () => {};

  let session;
  try {
    session = await globalThis.LanguageModel.create({
      initialPrompts: [{ role: 'system', content: SYSTEM_PROMPT }],
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          // e.loaded is a 0..1 fraction per the Prompt API.
          report(e.loaded);
        });
      },
    });
  } catch (err) {
    if (err instanceof AskError) throw err;
    throw new AskError('model-error', err && err.message);
  } finally {
    // The session is only a vehicle to trigger/await the download — free it on
    // every exit (success or throw) so it never leaks.
    if (session) session.destroy();
  }
}

/**
 * @param {import('./provider.js').AskRequest} req
 * @returns {Promise<import('./provider.js').AskResult>}
 */
async function answer({ question, chunks, signal }) {
  if (!hasPromptApi()) throw new AskError('unavailable');

  const packed = packChunks(chunks);
  const userPrompt = buildUserPrompt({ question, chunks: packed });

  let session;
  try {
    session = await globalThis.LanguageModel.create({
      initialPrompts: [{ role: 'system', content: SYSTEM_PROMPT }],
      signal,
    });

    // Best-effort input measurement when the session exposes it. T10/M4.5 owns
    // precise budgeting, so this only sanity-checks and never hard-fails in M3.
    if (typeof session.measureInputUsage === 'function') {
      try {
        await session.measureInputUsage(userPrompt);
      } catch {
        /* ignore — measurement is advisory only */
      }
    }

    const raw = await session.prompt(userPrompt, { responseConstraint: ANSWER_SCHEMA, signal });

    // parseAnswer never throws: a malformed model response DEGRADES to raw text
    // with no citations and grounded:false. That soft bad-json state is a normal
    // AskResult, NOT an error, so it flows straight back to the caller.
    const parsed = parseAnswer(raw, packed);
    return { answer: parsed.answer, citations: parsed.citations, grounded: parsed.grounded };
  } catch (err) {
    if (err instanceof AskError) throw err; // already-typed — pass through
    if (isAbort(err, signal)) throw new AskError('aborted');
    // context-overflow detection is deferred (T10); 'model-error' is the
    // acceptable fallback for any other model failure.
    throw new AskError('model-error', err && err.message);
  } finally {
    // destroy-in-finally: free the per-question session on EVERY path — success,
    // degraded parse, or throw — so on-device sessions never leak.
    if (session) session.destroy();
  }
}

/**
 * @returns {import('./provider.js').Provider}
 */
export function createBuiltinProvider() {
  return {
    id: 'builtin',
    label: 'Built-in AI',
    // streaming flips true in M8 when answerStream lands; jsonSchema is the
    // Prompt API's responseConstraint support.
    capabilities() {
      return { streaming: false, jsonSchema: true };
    },
    availability,
    ensureReady,
    answer,
  };
}
