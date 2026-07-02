// src/app/ask-panel.js
//
// The "Ask your notes" drawer — a right-side slide-over that runs the Ask
// controller and renders its states. Presentation glue only: all logic lives in
// the lib modules (ask-controller / fusion / ask-index). It never talks to the
// model or chrome APIs directly — the host (app.js) injects the callbacks.
//
// SAFETY (two distinct rules):
//  1. Chunk text is untrusted NOTE content — only ever placed via textContent /
//     createElement, NEVER innerHTML. That guard is unchanged from M2.
//  2. A model ANSWER (M3) is markdown and IS rendered as HTML, but ONLY through
//     src/lib/markdown.js's renderMarkdown() — which runs DOMPurify — so
//     `answerEl.innerHTML = renderMarkdown(answer)` is the ONE sanctioned
//     innerHTML-with-model-output path (see renderAnswered). Raw model text is
//     never assigned to innerHTML.

import { renderMarkdown } from '../lib/markdown.js';

const SNIPPET_MAX = 220;

// Centralized code -> user-facing copy for the 'error' state (ASK_ERROR_CODES,
// see src/lib/providers/provider.js). Deliberately NEVER surfaces state.message
// (the raw provider/thrown text) — that's internal detail that could leak an
// endpoint or key fragment from a future HTTP-compat provider (M7). 'aborted' is
// handled separately in renderError as a non-error (a cancelled ask, not a
// failure) and has no entry here. Any code without an entry falls back to
// DEFAULT_ERROR_COPY.
const ERROR_COPY = {
  'model-error': 'The AI model ran into a problem. Showing matching notes instead.',
  'context-overflow': 'That question plus its matches were too large to process. Showing matching notes.',
  network: "Couldn't reach the AI service. Showing matching notes.",
  auth: 'The AI service rejected the credentials. Showing matching notes.',
  unavailable: "On-device AI isn't available here. Showing matching notes.",
};
const DEFAULT_ERROR_COPY = 'Something went wrong generating an answer. Showing matching notes.';

// Verbatim opt-in copy (Plan §5.8) — do not paraphrase. The download is one-time,
// on-device, and shared across sites, and notes never leave the device.
const OPT_IN_COPY =
  "Answers are generated on your device by your browser's built-in AI "
  + '(Gemini Nano on Chrome, Phi on Edge). Your notes are never sent to any AI service. '
  + 'The browser will download a model (~2–4 GB, one-time, shared with other sites/extensions).';

// Collapse whitespace and clip to a readable length. Kept plain-text: the result
// is assigned via textContent, so any HTML in the note stays literal.
function snippetOf(text) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > SNIPPET_MAX ? s.slice(0, SNIPPET_MAX) + '…' : s;
}

// [Task E5] Reduce the PRIMARY retrieved chunks to the "Related notes" list: one
// row per note (the FIRST/highest-ranked chunk represents it — retrieval already
// ranked `chunks`, so first-seen is best-ranked), excluding any note already
// shown as a citation so a note is never listed twice. Pure so it's trivial to
// unit-test independent of the DOM.
function relatedChunks(chunks, citations) {
  const cited = new Set((Array.isArray(citations) ? citations : []).map((c) => c.noteId));
  const seen = new Set();
  const out = [];
  for (const c of (Array.isArray(chunks) ? chunks : [])) {
    if (cited.has(c.noteId) || seen.has(c.noteId)) continue;
    seen.add(c.noteId);
    out.push(c);
  }
  return out;
}

/**
 * @param {HTMLElement} container  the <aside id="ask-panel"> element
 * @param {Object} cb
 * @param {(question: string) => void} cb.onAsk        run a query
 * @param {(noteId: string) => void}   cb.onCitation   open a cited note
 * @param {() => void}                 [cb.onClose]     drawer closed
 * @param {() => { notes: number }}    [cb.getStats]    corpus size for the footer
 * @param {(question: string) => void} [cb.onEnableModel]  user opted into the on-device
 *        model download; MUST be invoked synchronously from the [Enable] click (gesture).
 * @param {() => void}                 [cb.onDeclineAi]    user dismissed the opt-in card;
 *        host persists the opt-out so it never returns.
 * @param {boolean}                    [cb.aiDeclined]     the persisted opt-out (from the host);
 *        when true the opt-in card is never shown.
 * @returns {{ update: (state: object) => void, open: () => void, close: () => void, destroy: () => void }}
 */
export function renderAskPanel(container, {
  onAsk, onCitation, onClose = () => {}, getStats = () => ({ notes: 0 }),
  onEnableModel = () => {}, onDeclineAi = () => {}, aiDeclined = false,
}) {
  container.innerHTML = ''; // build the shell ONCE; update() only mutates status/results

  // [T10/M4.5 Part 3] Dialog semantics so AT announces the drawer as a modal with a
  // name, and (with the focus trap below) treats the page behind it as inert.
  container.setAttribute('role', 'dialog');
  container.setAttribute('aria-modal', 'true');
  container.setAttribute('aria-label', 'Ask your notes');

  const header = document.createElement('div');
  header.className = 'ask-header';
  const heading = document.createElement('h2');
  heading.className = 'ask-title';
  heading.textContent = 'Ask your notes';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'ask-close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', () => close());
  // [Task E6] "New chat" clears the whole thread for a clean slate. Grouped with
  // the close button in an actions wrapper. DOM order is close-then-newchat so the
  // focus trap keeps its close-first / submit-last ordering; CSS `order` renders
  // New chat to the LEFT of ✕ visually.
  const newChatBtn = document.createElement('button');
  newChatBtn.type = 'button';
  newChatBtn.className = 'ask-newchat';
  newChatBtn.setAttribute('aria-label', 'New chat');
  newChatBtn.title = 'New chat';
  newChatBtn.textContent = '↺';
  newChatBtn.addEventListener('click', () => newChat());
  const actions = document.createElement('div');
  actions.className = 'ask-actions';
  actions.append(closeBtn, newChatBtn);
  header.append(heading, actions);

  const form = document.createElement('div');
  form.className = 'ask-form';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'ask-input';
  input.placeholder = 'Ask a question about your notes…';
  // Accessible name for the input (a placeholder is not a reliable label for AT).
  input.setAttribute('aria-label', 'Ask a question about your notes');
  const submit = document.createElement('button');
  submit.type = 'button';
  submit.className = 'ask-submit';
  submit.textContent = 'Ask';
  form.append(input, submit);

  const status = document.createElement('div');
  status.className = 'ask-status';
  status.setAttribute('aria-live', 'polite');

  // [Task E6] The scrolling THREAD container. Each ask appends one .ask-exchange;
  // finalized exchanges stay in the DOM (never re-rendered) so earlier Q&A — and
  // its citation/related buttons — remain visible and clickable.
  const results = document.createElement('div');
  results.className = 'ask-results';

  const footer = document.createElement('div');
  footer.className = 'ask-footer';

  container.append(header, form, status, results, footer);

  // The most recent asked query — remembered so the enable→re-ask flow can re-run it
  // after the model download completes.
  let lastQuestion = '';
  // Session mirror of the persisted opt-out. Starts from the host's stored value and
  // flips true the moment the user dismisses, so the card can't reappear this session.
  let declined = !!aiDeclined;

  // ---- actions -------------------------------------------------------------
  function fire() {
    const q = input.value.trim();
    if (!q) return;
    lastQuestion = q; // remembered for the enable→re-ask flow (survives the clear below)
    onAsk(q);
    // [Task E6] Chat-style input: clear the box and keep focus so the user can type
    // the next question immediately (the asked text now lives in the thread bubble).
    input.value = '';
    input.focus();
  }
  submit.addEventListener('click', fire);
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    // [Task E6] IME guard (fixes asking in Chinese/Japanese/Korean): while an IME
    // composition is active, Enter CONFIRMS the highlighted candidate — it must not
    // submit the ask. `isComposing` is the standard signal; keyCode 229 is the
    // legacy one some IMEs still send. Bail before treating Enter as submit.
    if (e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    fire();
  });

  // The element to restore focus to when the drawer closes (the toolbar Ask button
  // that opened it). Captured at open() time; cleared on close().
  let returnFocusEl = null;

  // All currently-focusable controls inside the drawer, in DOM order. Recomputed on
  // each Tab so result cards / the opt-in card join the trap as they render.
  function focusables() {
    const sel = 'a[href], button:not([disabled]), input:not([disabled]), '
      + 'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    return [...container.querySelectorAll(sel)].filter((el) => !el.hidden);
  }

  // Escape is SCOPED to the panel — the listener lives on the container and is only
  // bound while the drawer is open. The app has no global shortcuts, so we deliberately
  // do not touch document/window here. The same handler runs the focus trap: while a
  // modal (aria-modal=true) is open, Tab must not move focus to the inert page behind
  // it, so we wrap last->first and first->last instead of letting it escape.
  function onKeydown(e) {
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    if (e.key !== 'Tab') return;
    const items = focusables();
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !container.contains(active)) { e.preventDefault(); last.focus(); }
    } else if (active === last || !container.contains(active)) {
      e.preventDefault();
      first.focus();
    }
  }

  function open(opener) {
    container.hidden = false;
    container.addEventListener('keydown', onKeydown);
    renderFooter();
    // Remember where focus came from so close() can return it there. Prefer an
    // explicit opener (app.js passes the toolbar Ask button); otherwise fall back to
    // whatever held focus at open time. Captured BEFORE input.focus() moves it.
    const candidate = (opener && typeof opener.focus === 'function') ? opener : document.activeElement;
    returnFocusEl = (candidate && candidate !== document.body && typeof candidate.focus === 'function')
      ? candidate : null;
    input.focus();
  }
  function close() {
    container.hidden = true;
    container.removeEventListener('keydown', onKeydown);
    const toRestore = returnFocusEl;
    returnFocusEl = null;
    onClose();
    // Return focus to the opener so keyboard users aren't dumped at document start.
    // Guarded: the button may have been removed/re-rendered since open().
    if (toRestore && document.contains(toRestore)) toRestore.focus();
  }
  function destroy() {
    container.removeEventListener('keydown', onKeydown);
  }

  // ---- rendering -----------------------------------------------------------
  function setStatus(text) { status.textContent = text; }
  function renderFooter() {
    const n = (getStats() || {}).notes || 0;
    footer.textContent = `Searching ${n} note${n === 1 ? '' : 's'}`;
  }

  // ---- thread model --------------------------------------------------------
  // [Task E6] The results area is a scrolling THREAD of exchanges (a real chat
  // window, not the old single-shot wipe). Each ask = one .ask-exchange: a
  // question bubble + a mutable body that starts as a pending indicator and
  // resolves into the answer/snippets/error. Only the CURRENT exchange's body is
  // ever mutated — finalized exchanges are left untouched, so their citation and
  // related-note buttons stay live (closures over noteId keep working) as newer
  // asks are appended below.
  //
  // currentExchange = { el, body, indicatorEl }. `indicatorEl` is the transient
  // pending indicator (Searching…/Thinking…/progress bar) while the ask is in
  // flight; it is nulled the moment a terminal state resolves the body. Tracking
  // it lets a superseding ask (or an 'aborted' error) remove a stale one so no
  // orphan "Thinking…" is left hanging.
  let currentExchange = null;

  // [E6 review fix] The exchange the user clicked [Enable] in. enableModel's
  // downloading{progress} emissions are deliberately NOT signal-gated (a model
  // download outlives any single ask), so ticks keep arriving while the user asks
  // new questions or clears the thread. Painting the bar is therefore allowed ONLY
  // while this captured exchange is still the current one — a newer ask (new
  // currentExchange) or New chat (null) makes ticks fall back to the status line,
  // never wiping finalized content or appending an orphan progress exchange.
  // Deliberately NOT reset in clearThread(): the stale non-null pointer is what
  // keeps suppressing paints after New chat (a fresh [Enable] click re-captures).
  let downloadExchange = null;

  function clearThread() { results.textContent = ''; currentExchange = null; }

  // Keep the newest content in view after every update. Plain assignment — no
  // smooth-scroll dependency (Plan §E6). A no-op in jsdom (no layout), harmless.
  function scrollToNewest() { results.scrollTop = results.scrollHeight; }

  // Append a fresh exchange (question bubble + empty body) and make it current.
  // The question is the USER's own text → textContent, never innerHTML.
  function startExchange(question) {
    const ex = document.createElement('div');
    ex.className = 'ask-exchange';
    if (question) {
      const q = document.createElement('div');
      q.className = 'ask-q';
      q.textContent = question;
      ex.appendChild(q);
    }
    const body = document.createElement('div');
    body.className = 'ask-exchange-body';
    ex.appendChild(body);
    results.appendChild(ex);
    currentExchange = { el: ex, body, indicatorEl: null };
    return currentExchange;
  }

  // Terminal/live states normally follow `searching` (which created the exchange).
  // This covers direct/unit calls where such a state arrives with no exchange yet
  // — create a bodyless one (no question bubble) so there's a body to render into.
  function ensureExchange() { return currentExchange || startExchange(''); }

  // Drop a stale pending indicator from the current exchange (superseded ask or an
  // 'aborted' error). Leaves the question bubble — the ask WAS made — but removes
  // the hanging "Searching…/Thinking…".
  function dropStaleIndicator() {
    if (currentExchange && currentExchange.indicatorEl) {
      currentExchange.indicatorEl.remove();
      currentExchange.indicatorEl = null;
    }
  }

  // Put a transient pending indicator as the SOLE body content (replacing any
  // earlier indicator) and track it as the current pending element.
  function setPending(node) {
    const ex = ensureExchange();
    ex.body.textContent = '';
    ex.body.appendChild(node);
    ex.indicatorEl = node;
  }

  // Resolve the current exchange: swap the pending indicator for finalized content
  // rendered by `render(body)`. Clears the pending flag — the exchange is now done.
  function resolve(render) {
    const ex = ensureExchange();
    ex.body.textContent = '';
    render(ex.body);
    ex.indicatorEl = null;
  }

  function thinkingIndicator(text) {
    const el = document.createElement('div');
    el.className = 'ask-thinking';
    el.textContent = text;
    return el;
  }

  // Build one clickable card per retrieved chunk, into `target`. Everything set via
  // textContent (untrusted note content — never innerHTML).
  function renderCards(target, chunks) {
    for (const c of chunks) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'ask-card';

      const title = document.createElement('div');
      title.className = 'ask-card-title';
      title.textContent = c.noteTitle || 'Untitled';
      card.appendChild(title);

      if (c.heading) {
        const crumb = document.createElement('div');
        crumb.className = 'ask-card-crumb';
        crumb.textContent = c.heading;
        card.appendChild(crumb);
      }

      const snip = document.createElement('div');
      snip.className = 'ask-card-snippet';
      snip.textContent = snippetOf(c.text);
      card.appendChild(snip);

      card.addEventListener('click', () => onCitation(c.noteId));
      target.appendChild(card);
    }
  }

  function renderNote(target, text) {
    const note = document.createElement('div');
    note.className = 'ask-note';
    note.textContent = text;
    target.appendChild(note);
  }

  // A titled list of citation cards (Chunk objects). Reuses renderCards, so each is
  // clickable → onCitation(noteId), same as a retrieval snippet.
  function renderCitations(target, chunks) {
    const label = document.createElement('div');
    label.className = 'ask-sources-label';
    label.textContent = chunks.length === 1 ? 'Source' : 'Sources';
    target.appendChild(label);
    renderCards(target, chunks);
  }

  // [Task E5] Compact, suggestion-row-style list of the retrieved notes NOT
  // already shown as citations — modeled on toolbar.js's `.suggest-item` rows
  // (title strong, snippet muted) rather than the bigger `.ask-card`, since this
  // is a lighter-weight "you might also look at" affordance. SAFETY: chunk title
  // and text are untrusted note content — textContent only, same as renderCards.
  function renderRelated(target, chunks) {
    if (!chunks.length) return; // no empty header — nothing to relate
    const label = document.createElement('div');
    label.className = 'ask-related-label';
    label.textContent = 'Related notes';
    target.appendChild(label);

    for (const c of chunks) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'ask-related-row';

      const title = document.createElement('div');
      title.className = 'ask-related-title';
      title.textContent = c.noteTitle || 'Untitled';
      row.appendChild(title);

      const snip = document.createElement('div');
      snip.className = 'ask-related-snippet';
      snip.textContent = snippetOf(c.text);
      row.appendChild(snip);

      // Same cross-folder open path as a citation/snippet card click — no new
      // navigation path is introduced here.
      row.addEventListener('click', () => onCitation(c.noteId));
      target.appendChild(row);
    }
  }

  // The one-time on-device model download prompt. Shown only for the
  // 'model-downloadable' snippets reason AND only when the user hasn't opted out.
  function renderOptInCard(target) {
    const card = document.createElement('div');
    card.className = 'ask-optin';

    const text = document.createElement('p');
    text.className = 'ask-optin-text';
    text.textContent = OPT_IN_COPY;
    card.appendChild(text);

    const actions = document.createElement('div');
    actions.className = 'ask-optin-actions';

    const enable = document.createElement('button');
    enable.type = 'button';
    enable.className = 'ask-optin-enable';
    enable.textContent = 'Enable';
    enable.addEventListener('click', () => {
      // Remember which exchange hosts this download so progress ticks can't paint
      // over a NEWER exchange later (see downloadExchange). A plain synchronous
      // assignment — the gesture rule below is untouched.
      downloadExchange = currentExchange;
      // USER-GESTURE (critical): onEnableModel() must be the FIRST await-reaching thing
      // this handler does — it reaches controller.enableModel()->provider.ensureReady()->
      // LanguageModel.create(), which needs this click's user activation to permit the
      // model download. Any await before it would spend the gesture and Chrome would
      // refuse the download. So we call it synchronously with the remembered question.
      onEnableModel(lastQuestion);
    });

    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'ask-optin-dismiss';
    dismiss.textContent = 'Not now';
    dismiss.addEventListener('click', () => {
      declined = true;   // suppress for the rest of this session immediately…
      onDeclineAi();     // …and let the host persist it so it never returns later.
      card.remove();
    });

    actions.append(enable, dismiss);
    card.appendChild(actions);
    target.appendChild(card);
  }

  // Terminal states below resolve the CURRENT exchange's pending indicator into
  // content — same visuals as before, just scoped into the exchange body instead
  // of wiping a global results area.
  function renderSnippets(state) {
    const n = state.chunks.length;
    setStatus(`Found ${n} matching excerpt${n === 1 ? '' : 's'}`);
    resolve((target) => {
      if (state.reason === 'model-unavailable') {
        renderNote(target, 'On-device AI unavailable — showing matching excerpts.');
      } else if (state.reason === 'model-downloadable') {
        renderNote(target, 'On-device AI not enabled — showing matching excerpts.');
        if (!declined) renderOptInCard(target); // offer the one-time download (unless opted out)
      }
      renderCards(target, state.chunks);
    });
  }

  function renderAnswered(state) {
    setStatus('');
    resolve((target) => {
      const msg = document.createElement('div');
      msg.className = 'ask-message ask-answer';
      // SANCTIONED innerHTML: renderMarkdown() runs the model answer through DOMPurify
      // (src/lib/markdown.js), so any smuggled <script>/onerror is stripped before it
      // reaches the DOM. This is the ONLY place model output is assigned to innerHTML —
      // never assign the raw answer string.
      msg.innerHTML = renderMarkdown(state.answer || '');
      target.appendChild(msg);
      // grounded:false — the model (or the zero-hit canned path) had nothing to cite.
      // Still show the answer, but flag it subtly so the user knows it isn't from a note.
      if (state.grounded === false) {
        const hint = document.createElement('div');
        hint.className = 'ask-ungrounded';
        hint.textContent = "This answer isn't grounded in your notes.";
        target.appendChild(hint);
      }
      if (Array.isArray(state.citations) && state.citations.length) renderCitations(target, state.citations);
      // [Task E5] Always offer a way to jump to the source notes, even when the
      // model (or the zero-hit canned path) cited nothing — renders nothing if
      // every retrieved note is already a citation, or nothing was retrieved.
      renderRelated(target, relatedChunks(state.chunks, state.citations));
    });
  }

  function renderDownloading(state) {
    const pct = Math.max(0, Math.min(100, Math.round((Number(state.progress) || 0) * 100)));
    setStatus(`Downloading model… ${pct}%`);
    // Paint into the thread only while the exchange that hosted the [Enable]
    // click is still current (see downloadExchange). `!downloadExchange` keeps the
    // direct-feed path (unit tests / any future non-card trigger) painting as
    // before. When suppressed, the setStatus above still reports progress.
    if (downloadExchange && currentExchange !== downloadExchange) return;
    const track = document.createElement('div');
    track.className = 'ask-progress';
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    track.setAttribute('aria-valuenow', String(pct));
    const bar = document.createElement('div');
    bar.className = 'ask-progress-bar';
    bar.style.width = `${pct}%`;
    track.appendChild(bar);
    // The progress bar IS the pending indicator for this exchange.
    setPending(track);
  }

  function renderError(state) {
    // A cancelled ask (superseded by a newer one, or a future explicit user cancel)
    // is NOT a failure — no red/scary copy. Just drop the hanging pending indicator
    // so the exchange doesn't sit on "Searching…/Thinking…" forever.
    if (state.code === 'aborted') { dropStaleIndicator(); return; }

    setStatus(ERROR_COPY[state.code] || DEFAULT_ERROR_COPY);
    resolve((target) => {
      // Retrieval survives a model error — always still show the preserved chunks.
      if (Array.isArray(state.chunks) && state.chunks.length) renderCards(target, state.chunks);
    });
  }

  // [Task E6] New chat: wipe the thread + input, reset lastQuestion (so an
  // enable→re-ask can't resurrect a cleared question), and keep focus for typing.
  // Does NOT call the controller — the next ask() supersedes anything in flight and
  // stale emissions are already signal-gated — and does NOT touch the aiDeclined pref.
  function newChat() {
    clearThread();
    input.value = '';
    lastQuestion = '';
    setStatus('');
    input.focus();
  }

  function update(state) {
    switch (state.kind) {
      // Thread-level notices — no exchange, just the status line. (idle is never
      // emitted at runtime; no-index means an empty corpus, so there's no history
      // to preserve anyway.)
      case 'idle': setStatus(''); break;
      case 'no-index': setStatus('No notes to search yet.'); break;

      // A new ask STARTS a new exchange. If the previous exchange never resolved
      // (superseded mid-flight), drop its stale pending indicator first — the
      // controller guarantees that superseded ask emits nothing further, so the
      // indicator would otherwise hang as an orphan.
      case 'searching':
        setStatus('Searching…');
        dropStaleIndicator();
        startExchange(state.question || '');
        setPending(thinkingIndicator('Searching…'));
        break;

      // M3 live states route into the CURRENT exchange's pending slot.
      case 'generating': setStatus('Thinking…'); setPending(thinkingIndicator('Thinking…')); break;
      case 'downloading': renderDownloading(state); break;

      // Terminal states resolve the current exchange's pending indicator.
      case 'snippets': renderSnippets(state); break;
      case 'answered': renderAnswered(state); break;
      case 'error': renderError(state); break;
      default: break;
    }
    scrollToNewest();
  }

  return { update, open, close, destroy };
}
