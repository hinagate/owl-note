// Orchestration state machine for Ask-Your-Notes. Given a question it runs the
// retrieve → (maybe) generate pipeline and emits a discriminated-union state on
// every transition via `onState`. Pure module: NO DOM, NO chrome APIs, NO real
// model. Everything it talks to — the index, fusion, the provider registry — is
// INJECTED, which is what lets the whole pipeline be tested against fakes and
// lets the model backend stay swappable (see providers/provider.js).

import { AskError } from './providers/provider.js';

// Canned reply when retrieval finds nothing — we never spend a model call on it.
const NO_MATCH_ANSWER = 'Nothing in your notes matches that.';

// State constructors kept inline as plain objects; `.kind` is the discriminant.
// Anticipated-but-unimplemented: a `streaming{...}` state (M8) will slot in
// alongside `generating` — the union is intentionally open to it, but P1 must
// NOT build it.

/**
 * @param {Object} deps
 * @param {{ stats: () => { notes: number } }} deps.index
 * @param {{ query: (q: string, k?: number) => Promise<import('./providers/provider.js').Chunk[]> }} deps.fusion
 * @param {{ getActiveProvider: () => import('./providers/provider.js').Provider|null }} deps.registry
 * @param {(state: object) => void} deps.onState
 */
export function createAskController({ index, fusion, registry, onState }) {
  let state = { kind: 'idle' };

  // Signal of the currently in-flight ask. A newer ask aborts the prior one; the
  // prior ask then gates every post-await emission on this signal so it can never
  // land a stale terminal state (answered/error/snippets) over the newer ask.
  let inFlight = null;

  // Chunks from the most recent retrieval, kept so enableModel's error state can
  // still carry them (errors preserve chunks so the panel keeps rendering
  // snippets even when the model fails).
  let lastChunks = [];

  function emit(next) {
    state = next;
    onState(next);
  }

  // Map a thrown value to a stable code. AskError carries its own; an AbortError
  // (from signal cancellation) is 'aborted'; anything else is a generic model bug.
  function codeOf(err) {
    if (err instanceof AskError) return err.code;
    if (err && err.name === 'AbortError') return 'aborted';
    return 'model-error';
  }

  // Turn the provider's citation ids back into Chunk objects. Result is a subset
  // of the chunks we actually sent; any id the model returns that we didn't send
  // is silently dropped (models occasionally hallucinate ids).
  function resolveCitations(ids, sentChunks) {
    if (!Array.isArray(ids) || ids.length === 0) return [];
    const byId = new Map(sentChunks.map((c) => [c.id, c]));
    const out = [];
    for (const id of ids) {
      const chunk = byId.get(id);
      if (chunk) out.push(chunk);
    }
    return out;
  }

  function activeProviderId() {
    const provider = registry.getActiveProvider();
    return provider ? provider.id : null;
  }

  async function ask(question) {
    // Supersede any in-flight ask first, then take a fresh signal for this one.
    if (inFlight) inFlight.abort();
    const controller = new AbortController();
    inFlight = controller;
    const { signal } = controller;

    // Corpus-empty is distinct from zero-hits: an unbuilt/empty index has nothing
    // to search, so we short-circuit to no-index and never touch fusion/provider.
    if (index.stats().notes === 0) {
      emit({ kind: 'no-index' });
      return;
    }

    emit({ kind: 'searching', question });

    const chunks = await fusion.query(question, 8);
    if (signal.aborted) return; // superseded during retrieval
    lastChunks = chunks;

    // Zero HITS on a non-empty index: answer without the model, ungrounded.
    if (chunks.length === 0) {
      emit({
        kind: 'answered',
        question,
        answer: NO_MATCH_ANSWER,
        citations: [],
        grounded: false,
        provider: activeProviderId(),
        usedModel: false,
      });
      return;
    }

    const provider = registry.getActiveProvider();
    try {
      const availability = await provider.availability();
      if (signal.aborted) return; // superseded while checking availability

      if (availability === 'available') {
        emit({ kind: 'generating', question, chunks });
        // capabilities().streaming would route to answerStream here — that's M8;
        // P1 always uses the non-streaming answer().
        const result = await provider.answer({ question, chunks, signal });
        if (signal.aborted) return; // superseded while the model was answering
        emit({
          kind: 'answered',
          question,
          answer: result.answer,
          citations: resolveCitations(result.citations, chunks),
          grounded: result.grounded,
          provider: provider.id,
          usedModel: true,
        });
        return;
      }

      // Not runnable now: fall back to retrieval-only snippets. 'downloadable' and
      // 'downloading' share a reason — the panel's opt-in/progress card handles
      // both via enableModel; 'unavailable' means retrieval-only, no model at all.
      const reason = availability === 'unavailable' ? 'model-unavailable' : 'model-downloadable';
      emit({ kind: 'snippets', question, chunks, reason });
    } catch (err) {
      // A superseded ask must not surface a late error over the newer one; its
      // signal is already aborted, so swallow the (already consumed) rejection.
      if (signal.aborted) return;
      emit({ kind: 'error', code: codeOf(err), message: err.message, chunks });
    }
  }

  // Explicit, user-gesture-only model download. This is the ONLY place a download
  // is triggered — availability() elsewhere never auto-downloads. Drives
  // downloading{progress} from ensureReady's callback; on success the panel
  // typically re-runs ask(). Surfaces error{...} (keeping the last chunks) if
  // ensureReady throws.
  async function enableModel() {
    const provider = registry.getActiveProvider();
    try {
      await provider.ensureReady((progress) => emit({ kind: 'downloading', progress }));
    } catch (err) {
      emit({ kind: 'error', code: codeOf(err), message: err.message, chunks: lastChunks });
    }
  }

  return {
    ask,
    enableModel,
    getState: () => state,
  };
}
