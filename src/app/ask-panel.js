// src/app/ask-panel.js
//
// The "Ask your notes" drawer — a right-side slide-over that runs the Ask
// controller and renders its states. Presentation glue only: all logic lives in
// the lib modules (ask-controller / fusion / ask-index). It never talks to the
// model or chrome APIs directly — the host (app.js) injects the callbacks.
//
// SAFETY: chunk text is untrusted note content, so it is only ever placed via
// textContent / createElement, NEVER innerHTML. There are no model answers in M2
// (the stub provider is always 'unavailable'), so results are plain-text snippets.
// When M3 renders real markdown answers it must route them through
// src/lib/markdown.js (DOMPurify) — see renderAnswered below.

const SNIPPET_MAX = 220;

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
 * @returns {{ update: (state: object) => void, open: () => void, close: () => void, destroy: () => void }}
 */
export function renderAskPanel(container, { onAsk, onCitation, onClose = () => {}, getStats = () => ({ notes: 0 }) }) {
  container.innerHTML = ''; // build the shell ONCE; update() only mutates status/results

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

  // ---- actions -------------------------------------------------------------
  function fire() {
    const q = input.value.trim();
    if (q) onAsk(q);
  }
  submit.addEventListener('click', fire);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); fire(); } });

  // Escape is SCOPED to the panel — the listener lives on the container and is
  // only bound while the drawer is open. The app has no global shortcuts, so we
  // deliberately do not touch document/window here.
  function onKeydown(e) {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  }

  function open() {
    container.hidden = false;
    container.addEventListener('keydown', onKeydown);
    renderFooter();
    input.focus();
  }
  function close() {
    container.hidden = true;
    container.removeEventListener('keydown', onKeydown);
    onClose();
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

  function renderSnippets(state) {
    const n = state.chunks.length;
    setStatus(`Found ${n} matching excerpt${n === 1 ? '' : 's'}`);
    clearResults();
    // In M2 the reason is always 'model-unavailable'; keep it explicit for forward-compat.
    if (state.reason === 'model-unavailable') renderNote('On-device AI unavailable — showing matching excerpts.');
    else if (state.reason === 'model-downloadable') renderNote('On-device AI not enabled — showing matching excerpts.');
    renderCards(state.chunks);
  }

  function renderAnswered(state) {
    // M2 only reaches this via the zero-hits canned reply (grounded:false), which is
    // a plain string — safe as textContent. M3/T8: a real model answer is markdown
    // and MUST be rendered through src/lib/markdown.js (DOMPurify), never innerHTML.
    setStatus('');
    clearResults();
    const msg = document.createElement('div');
    msg.className = 'ask-message';
    msg.textContent = state.answer || '';
    results.appendChild(msg);
    if (Array.isArray(state.citations) && state.citations.length) renderCards(state.citations);
  }

  function renderError(state) {
    setStatus('Something went wrong — showing matching excerpts.');
    clearResults();
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
      // Unreachable in M2 (stub provider never becomes available); handled so a
      // future model backend doesn't crash the drawer.
      case 'downloading': setStatus('Preparing the on-device model…'); break;
      case 'generating': setStatus('Generating an answer…'); break;
      default: break;
    }
  }

  return { update, open, close, destroy };
}
