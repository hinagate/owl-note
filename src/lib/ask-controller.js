// Orchestration state machine for Ask-Your-Notes. Given a question it runs the
// retrieve → (maybe) generate pipeline and emits a discriminated-union state on
// every transition via `onState`. Pure module: NO DOM, NO chrome APIs, NO real
// model. Everything it talks to — the index, fusion, the provider registry — is
// INJECTED, which is what lets the whole pipeline be tested against fakes and
// lets the model backend stay swappable (see providers/provider.js).

import { AskError } from './providers/provider.js';

// Canned reply when retrieval finds nothing — we never spend a model call on it.
const NO_MATCH_ANSWER = 'Nothing in your notes matches that.';

// [Task E7] De-duplicate chunks by id, keeping FIRST occurrence. Used to collapse a
// pinned chunk that also ranked as a primary so the model never sees it twice; first
// wins so the pinned copy (prepended) keeps its leading position.
function dedupeById(chunks) {
  const seen = new Set();
  const out = [];
  for (const c of chunks) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out;
}

// State constructors kept inline as plain objects; `.kind` is the discriminant.
// Anticipated-but-unimplemented: a `streaming{...}` state (M8) will slot in
// alongside `generating` — the union is intentionally open to it, but P1 must
// NOT build it.

/**
 * @param {Object} deps
 * @param {{ stats: () => { notes: number }, chunksOf: (noteId: string) => import('./providers/provider.js').Chunk[] }} deps.index
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

  async function ask(question, { pinnedNoteId, pinAll } = {}) {
    // Supersede any in-flight ask first, then take a fresh signal for this one.
    if (inFlight) inFlight.abort();
    const controller = new AbortController();
    inFlight = controller;
    const { signal } = controller;

    // The canned no-match, emitted from more than one branch below — factored out so
    // every path stays byte-identical to the pre-E7 zero-hit reply.
    const emitNoMatch = () => emit({
      kind: 'answered',
      question,
      answer: NO_MATCH_ANSWER,
      citations: [],
      chunks: [], // [Task E5] nothing was retrieved — no related notes to offer
      grounded: false,
      provider: activeProviderId(),
      usedModel: false,
    });

    // Corpus-empty is distinct from zero-hits: an unbuilt/empty index has nothing
    // to search, so we short-circuit to no-index and never touch fusion/provider.
    if (index.stats().notes === 0) {
      emit({ kind: 'no-index' });
      return;
    }

    emit({ kind: 'searching', question });

    // [Task E9] "Summarize this note" (pinAll) vs the E7 chip ask — two deliberate
    // differences, WHY on each:
    //  1. All chunks, no retrieval. pinAll pins `chunksOf(pinnedNoteId)` UNSLICED (a
    //     summary needs the WHOLE note; packChunks' 5000-token/10-chunk cap is the
    //     budget guard, not a 2-slice) and leaves `chunks` (primaries) = [] WITHOUT
    //     calling fusion.query — the literal words "summarize this note" would
    //     lexically match unrelated notes and pollute both the model context and the
    //     Related-notes list. Skipping that await is safe: the supersede gates on the
    //     remaining awaits (availability/expand/answer) below still hold.
    let chunks;
    let pinned;
    if (pinAll) {
      pinned = pinnedNoteId ? index.chunksOf(pinnedNoteId) : [];
      chunks = [];
    } else {
      chunks = await fusion.query(question, 8);
      if (signal.aborted) return; // superseded during retrieval
      // [Task E7] Pin the currently-open note into the model context: its first 2
      // doc-order chunks. chunksOf is SYNCHRONOUS, so this adds no new await before the
      // supersede gates below. Cheap guarantee — if the note is query-relevant its
      // chunks are already in `chunks` and dedupeById collapses the overlap.
      pinned = pinnedNoteId ? index.chunksOf(pinnedNoteId).slice(0, 2) : [];
    }
    lastChunks = chunks;

    // Zero HITS with NO pin: canned no-match, ungrounded, model never touched
    // (provider is not even queried — byte-identical to pre-E7). WITH a pin we fall
    // through to the availability check: a pinned note lets "summarize this note"
    // reach the model despite zero lexical hits, but ONLY when the model is available.
    if (chunks.length === 0 && pinned.length === 0) {
      emitNoMatch();
      return;
    }

    const provider = registry.getActiveProvider();
    try {
      const availability = await provider.availability();
      if (signal.aborted) return; // superseded while checking availability

      if (availability === 'available') {
        // [Task E3] Enrich what the MODEL sees with neighbor chunks (answers often
        // straddle a chunk boundary). This split is deliberate: `context` (primaries
        // + neighbors) is what the model reads and what citations resolve against,
        // while generating{chunks}/snippets/error and lastChunks keep the PRIMARY
        // chunks — expansion must not add near-duplicate note cards to the snippets.
        // [Task E7] Pinned chunks lead the set (dedupeById drops a pin that also
        // ranked as a primary), so packChunks (10/5000) can never trim away the
        // pinned note — the whole point of pinning is a guaranteed presence.
        const context = await fusion.expand(dedupeById([...pinned, ...chunks]));
        if (signal.aborted) return; // superseded during expansion (new await point)
        emit({ kind: 'generating', question, chunks });
        // capabilities().streaming would route to answerStream here — that's M8;
        // P1 always uses the non-streaming answer().
        const result = await provider.answer({ question, chunks: context, signal });
        if (signal.aborted) return; // superseded while the model was answering
        emit({
          kind: 'answered',
          question,
          answer: result.answer,
          // Resolve against `context` (the set actually sent) so a cited NEIGHBOR
          // maps back to a real Chunk, not just the primaries.
          citations: resolveCitations(result.citations, context),
          // [Task E5] the PRIMARY retrieved chunks (not `context`, which also
          // holds neighbor-expanded chunks the model saw but retrieval didn't
          // rank) — the panel's "Related notes" list mirrors retrieval, same as
          // generating{chunks}/snippets/error already do.
          chunks,
          grounded: result.grounded,
          provider: provider.id,
          usedModel: true,
        });
        return;
      }

      // [Task E7] Model not runnable AND zero lexical hits: the pin is a
      // model-context concept, so with no model there's nothing useful to show —
      // fall back to the canned no-match, exactly as the no-pin zero-hit path does.
      // (This only reaches here because a pin let us skip the earlier shortcut.)
      // [Task E9] pinAll is EXEMPT: a "summarize" on a model-less machine should
      // surface the availability ladder below (the opt-in card IS the right response
      // to "summarize" here), not a dead-end no-match — so it falls through to the
      // snippets{chunks:[]} emit and its reason reflects the availability.
      if (chunks.length === 0 && !pinAll) {
        emitNoMatch();
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
