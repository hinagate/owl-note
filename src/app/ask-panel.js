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
  header.append(heading, closeBtn);

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
    if (q) { lastQuestion = q; onAsk(q); }
  }
  submit.addEventListener('click', fire);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); fire(); } });

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
  function clearResults() { results.textContent = ''; }
  function renderFooter() {
    const n = (getStats() || {}).notes || 0;
    footer.textContent = `Searching ${n} note${n === 1 ? '' : 's'}`;
  }

  // Build one clickable card per retrieved chunk. Everything set via textContent.
  function renderCards(chunks) {
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
      results.appendChild(card);
    }
  }

  function renderNote(text) {
    const note = document.createElement('div');
    note.className = 'ask-note';
    note.textContent = text;
    results.appendChild(note);
  }

  // A titled list of citation cards (Chunk objects). Reuses renderCards, so each is
  // clickable → onCitation(noteId), same as a retrieval snippet.
  function renderCitations(chunks) {
    const label = document.createElement('div');
    label.className = 'ask-sources-label';
    label.textContent = chunks.length === 1 ? 'Source' : 'Sources';
    results.appendChild(label);
    renderCards(chunks);
  }

  // The one-time on-device model download prompt. Shown only for the
  // 'model-downloadable' snippets reason AND only when the user hasn't opted out.
  function renderOptInCard() {
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
      // USER-GESTURE (critical): onEnableModel() must be the FIRST thing this handler
      // does — it reaches controller.enableModel()->provider.ensureReady()->
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
    results.appendChild(card);
  }

  function renderSnippets(state) {
    const n = state.chunks.length;
    setStatus(`Found ${n} matching excerpt${n === 1 ? '' : 's'}`);
    clearResults();
    if (state.reason === 'model-unavailable') {
      renderNote('On-device AI unavailable — showing matching excerpts.');
    } else if (state.reason === 'model-downloadable') {
      renderNote('On-device AI not enabled — showing matching excerpts.');
      if (!declined) renderOptInCard(); // offer the one-time download (unless opted out)
    }
    renderCards(state.chunks);
  }

  function renderAnswered(state) {
    setStatus('');
    clearResults();
    const msg = document.createElement('div');
    msg.className = 'ask-message ask-answer';
    // SANCTIONED innerHTML: renderMarkdown() runs the model answer through DOMPurify
    // (src/lib/markdown.js), so any smuggled <script>/onerror is stripped before it
    // reaches the DOM. This is the ONLY place model output is assigned to innerHTML —
    // never assign the raw answer string.
    msg.innerHTML = renderMarkdown(state.answer || '');
    results.appendChild(msg);
    // grounded:false — the model (or the zero-hit canned path) had nothing to cite.
    // Still show the answer, but flag it subtly so the user knows it isn't from a note.
    if (state.grounded === false) {
      const hint = document.createElement('div');
      hint.className = 'ask-ungrounded';
      hint.textContent = "This answer isn't grounded in your notes.";
      results.appendChild(hint);
    }
    if (Array.isArray(state.citations) && state.citations.length) renderCitations(state.citations);
  }

  function renderGenerating() {
    // Clear any prior answer/snippets — the model is producing a fresh reply.
    setStatus('Thinking…');
    clearResults();
    const el = document.createElement('div');
    el.className = 'ask-thinking';
    el.textContent = 'Thinking…';
    results.appendChild(el);
  }

  function renderDownloading(state) {
    const pct = Math.max(0, Math.min(100, Math.round((Number(state.progress) || 0) * 100)));
    setStatus(`Downloading model… ${pct}%`);
    clearResults();
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
    results.appendChild(track);
  }

  function renderError(state) {
    // A cancelled ask (superseded by a newer one, or a future explicit user
    // cancel) is NOT a failure — no red/scary copy. Quietly leave whatever was
    // already on screen (e.g. the prior snippets or answer) untouched.
    if (state.code === 'aborted') return;

    setStatus(ERROR_COPY[state.code] || DEFAULT_ERROR_COPY);
    clearResults();
    // Retrieval survives a model error — always still show the preserved chunks.
    if (Array.isArray(state.chunks) && state.chunks.length) renderCards(state.chunks);
  }

  function update(state) {
    switch (state.kind) {
      case 'idle': setStatus(''); clearResults(); break;
      case 'no-index': setStatus('No notes to search yet.'); clearResults(); break;
      case 'searching': setStatus('Searching…'); clearResults(); break;
      case 'snippets': renderSnippets(state); break;
      case 'answered': renderAnswered(state); break;
      case 'error': renderError(state); break;
      // M3 live states: the on-device model is downloading or generating.
      case 'downloading': renderDownloading(state); break;
      case 'generating': renderGenerating(state); break;
      default: break;
    }
  }

  return { update, open, close, destroy };
}
