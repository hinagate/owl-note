// Tests for the retrieval-only Ask panel drawer (M2). Two layers:
//  1. Pure panel tests — drive renderAskPanel() directly with fake callbacks and
//     feed it real controller-shaped states, asserting DOM + safety (no innerHTML
//     on note text).
//  2. An app-level integration test — boots the real app over fake-chrome, seeds
//     notes in TWO notebooks, opens the drawer via the toolbar, asks, and clicks a
//     citation whose note lives in the NON-active notebook, asserting the app
//     switches folder and opens it (the cross-folder path T3.5 makes correct).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import { installFakeLanguageModel } from './helpers/fake-language-model.js';
import { contentHash } from '../src/lib/note.js';
import { renderAskPanel } from '../src/app/ask-panel.js';

// --- Layer 1: pure panel -----------------------------------------------------

function mount() {
  document.body.innerHTML = '<aside id="ask-panel" hidden></aside>';
  return document.getElementById('ask-panel');
}

const chunk = (over = {}) => ({
  id: 'n1::0', noteId: 'n1', noteTitle: 'Note One',
  heading: 'Setup > Install', text: 'plain snippet text here', raw: 'raw md', ...over,
});
const snippetsState = (chunks, reason = 'model-unavailable') => ({ kind: 'snippets', question: 'q', chunks, reason });

function makePanel(over = {}) {
  const el = mount();
  const cbs = {
    onAsk: vi.fn(), onCitation: vi.fn(), onClose: vi.fn(),
    onEnableModel: vi.fn(), onDeclineAi: vi.fn(),
    getStats: () => ({ notes: 3, chunks: 9 }), ...over,
  };
  const panel = renderAskPanel(el, cbs);
  return { el, panel, ...cbs };
}

describe('ask-panel — drawer shell', () => {
  it('builds the input + Ask button once and stays hidden by default', () => {
    const { el } = makePanel();
    expect(el.hidden).toBe(true);
    expect(el.querySelector('.ask-input')).not.toBeNull();
    expect(el.querySelector('.ask-submit')).not.toBeNull();
    expect(el.querySelector('.ask-close')).not.toBeNull();
  });

  it('open() unhides + focuses the input; close() and ✕ and Escape hide it', () => {
    const { el, panel, onClose } = makePanel();
    panel.open();
    expect(el.hidden).toBe(false);
    expect(document.activeElement).toBe(el.querySelector('.ask-input'));

    panel.close();
    expect(el.hidden).toBe(true);
    expect(onClose).toHaveBeenCalled();

    // ✕ button
    panel.open();
    el.querySelector('.ask-close').click();
    expect(el.hidden).toBe(true);

    // Escape (scoped: a keydown on the panel)
    panel.open();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(el.hidden).toBe(true);
  });

  it('the Ask button and Enter both fire onAsk with the trimmed question', () => {
    const { el, panel, onAsk } = makePanel();
    panel.open();
    const input = el.querySelector('.ask-input');
    input.value = '  what is a pod  ';
    el.querySelector('.ask-submit').click();
    expect(onAsk).toHaveBeenCalledWith('what is a pod');

    input.value = 'second question';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onAsk).toHaveBeenCalledWith('second question');
    expect(onAsk).toHaveBeenCalledTimes(2);
  });

  it('shows the corpus size in the footer via getStats()', () => {
    const { el, panel } = makePanel({ getStats: () => ({ notes: 214, chunks: 1000 }) });
    panel.open();
    expect(el.querySelector('.ask-footer').textContent).toContain('214');
  });
});

// [T10/M4.5 Part 3] Drawer a11y: the slide-over must be a proper modal dialog for
// keyboard + screen-reader users — dialog semantics, labelled controls, a focus
// trap (Tab can't escape the drawer), and focus returned to the opener on close.
describe('ask-panel — a11y (dialog semantics, labels, focus trap)', () => {
  it('exposes role=dialog, aria-modal, an accessible name, and labelled controls', () => {
    const { el } = makePanel();
    expect(el.getAttribute('role')).toBe('dialog');
    expect(el.getAttribute('aria-modal')).toBe('true');
    expect(el.getAttribute('aria-label')).toBeTruthy();
    // Each interactive control carries an accessible name.
    expect(el.querySelector('.ask-input').getAttribute('aria-label')).toBeTruthy();
    expect(el.querySelector('.ask-close').getAttribute('aria-label')).toBeTruthy();
    expect(el.querySelector('.ask-submit').textContent).toBe('Ask'); // name from visible text
  });

  it('traps Tab focus inside the drawer (last wraps to first, first wraps to last)', () => {
    const { el, panel } = makePanel();
    panel.open();
    const items = [el.querySelector('.ask-close'), el.querySelector('.ask-input'), el.querySelector('.ask-submit')];
    const first = items[0];
    const last = items[items.length - 1];

    // Tab on the LAST focusable wraps to the FIRST.
    last.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(first);

    // Shift+Tab on the FIRST focusable wraps to the LAST.
    first.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(last);
  });

  it('returns focus to the opener (toolbar Ask button) when closed', () => {
    const { el, panel } = makePanel(); // mount() replaces body content with the aside
    const askBtn = document.createElement('button');
    askBtn.textContent = 'Ask';
    document.body.appendChild(askBtn);
    askBtn.focus();

    panel.open(askBtn); // opener passed explicitly, as app.js does
    expect(document.activeElement).toBe(el.querySelector('.ask-input')); // focus moved into drawer

    panel.close();
    expect(document.activeElement).toBe(askBtn); // ...and back to the opener on close
  });

  it('Escape stays SCOPED to the panel (T5) and still closes + returns focus', () => {
    const { el, panel } = makePanel();
    const askBtn = document.createElement('button');
    document.body.appendChild(askBtn);
    askBtn.focus();
    panel.open(askBtn);

    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(el.hidden).toBe(true);
    expect(document.activeElement).toBe(askBtn);
  });
});

describe('ask-panel — state rendering', () => {
  it('renders one result card per chunk with title, heading and snippet', () => {
    const { el, panel } = makePanel();
    panel.update(snippetsState([
      chunk({ id: 'a::0', noteId: 'a', noteTitle: 'Alpha', heading: 'Intro', text: 'alpha body' }),
      chunk({ id: 'b::0', noteId: 'b', noteTitle: 'Beta', heading: '', text: 'beta body' }),
    ]));
    const cards = el.querySelectorAll('.ask-card');
    expect(cards).toHaveLength(2);
    expect(cards[0].querySelector('.ask-card-title').textContent).toBe('Alpha');
    expect(cards[0].querySelector('.ask-card-crumb').textContent).toBe('Intro');
    expect(cards[0].querySelector('.ask-card-snippet').textContent).toContain('alpha body');
    // No heading → no crumb element on the second card.
    expect(cards[1].querySelector('.ask-card-crumb')).toBeNull();
    expect(el.querySelector('.ask-status').textContent).toContain('2'); // "Found 2 matching excerpts"
  });

  it('a snippet card click calls onCitation with that chunk noteId', () => {
    const { el, panel, onCitation } = makePanel();
    panel.update(snippetsState([chunk({ id: 'z::3', noteId: 'zzz', noteTitle: 'Zed' })]));
    el.querySelector('.ask-card').click();
    expect(onCitation).toHaveBeenCalledWith('zzz');
  });

  it('surfaces the model-unavailable reason as a subtle note', () => {
    const { el, panel } = makePanel();
    panel.update(snippetsState([chunk()], 'model-unavailable'));
    expect(el.querySelector('.ask-note')).not.toBeNull();
    expect(el.querySelector('.ask-note').textContent.toLowerCase()).toContain('unavailable');
  });

  it('NEVER uses innerHTML on chunk text — HTML in a chunk renders as literal text', () => {
    const { el, panel } = makePanel();
    const evil = '<img src=x onerror="window.__pwned=1"> and more';
    panel.update(snippetsState([chunk({
      noteId: 'x', noteTitle: '<b>Bold</b> title', heading: '<i>h</i>', text: evil,
    })]));
    const results = el.querySelector('.ask-results');
    // No real elements were parsed from the note text — everything is a text node.
    expect(results.querySelector('img')).toBeNull();
    expect(results.querySelector('b')).toBeNull();
    expect(results.querySelector('i')).toBeNull();
    expect(el.querySelector('.ask-card-snippet').textContent).toContain('<img');
    expect(el.querySelector('.ask-card-title').textContent).toContain('<b>Bold</b>');
    expect(window.__pwned).toBeUndefined();
  });

  it('no-index shows the empty-corpus message and no cards', () => {
    const { el, panel } = makePanel();
    panel.update({ kind: 'no-index' });
    expect(el.querySelector('.ask-status').textContent.toLowerCase()).toContain('no notes');
    expect(el.querySelectorAll('.ask-card')).toHaveLength(0);
  });

  // [Task E6] Thread contract (was single-shot wipe): a new `searching` no longer
  // wipes the previous exchange — it appends a NEW exchange with a pending
  // indicator and a searching status; the prior exchange's cards stay in the thread.
  it('searching starts a new exchange (prior exchange preserved) and shows a searching status', () => {
    const { el, panel } = makePanel();
    panel.update(snippetsState([chunk()]));
    expect(el.querySelectorAll('.ask-card')).toHaveLength(1);
    panel.update({ kind: 'searching', question: 'q' });
    expect(el.querySelectorAll('.ask-card')).toHaveLength(1); // prior exchange preserved (thread)
    expect(el.querySelector('.ask-thinking')).not.toBeNull();  // new exchange's pending indicator
    expect(el.querySelector('.ask-status').textContent.toLowerCase()).toContain('searching');
  });

  it('zero-hit answered shows the grounded:false message', () => {
    const { el, panel } = makePanel();
    panel.update({ kind: 'answered', question: 'q', answer: 'Nothing in your notes matches that.', citations: [], grounded: false, usedModel: false });
    expect(el.textContent).toContain('Nothing in your notes matches that.');
  });

  it('error maps model-error to its friendly copy and still renders the preserved chunks', () => {
    const { el, panel } = makePanel();
    panel.update({ kind: 'error', code: 'model-error', message: 'raw provider stack trace', chunks: [chunk({ noteId: 'e', noteTitle: 'Err note' })] });
    expect(el.querySelector('.ask-status').textContent).toContain('The AI model ran into a problem');
    expect(el.querySelectorAll('.ask-card')).toHaveLength(1);
    expect(el.querySelector('.ask-card-title').textContent).toBe('Err note');
    // The raw provider message must never leak into the DOM.
    expect(el.textContent).not.toContain('raw provider stack trace');
  });

  it.each([
    ['context-overflow', 'too large to process'],
    ['network', "Couldn't reach the AI service"],
    ['auth', 'rejected the credentials'],
    ['unavailable', "isn't available"],
  ])('error code %s renders its mapped copy and still shows chunk cards', (code, expectedSubstring) => {
    const { el, panel } = makePanel();
    panel.update({ kind: 'error', code, message: 'internal-detail-should-not-leak', chunks: [chunk()] });
    expect(el.querySelector('.ask-status').textContent).toContain(expectedSubstring);
    expect(el.querySelectorAll('.ask-card')).toHaveLength(1);
    expect(el.textContent).not.toContain('internal-detail-should-not-leak');
  });

  it('an unrecognized error code falls back to a generic friendly message', () => {
    const { el, panel } = makePanel();
    panel.update({ kind: 'error', code: 'totally-unknown-code', message: 'nope', chunks: [chunk()] });
    expect(el.querySelector('.ask-status').textContent.toLowerCase()).toContain('something went wrong');
    expect(el.querySelectorAll('.ask-card')).toHaveLength(1);
    expect(el.textContent).not.toContain('nope');
  });

  it('aborted is NOT shown as a scary error — quietly leaves the prior render untouched', () => {
    const { el, panel } = makePanel();
    panel.update(snippetsState([chunk({ noteId: 'p', noteTitle: 'Prior card' })]));
    const statusBefore = el.querySelector('.ask-status').textContent;
    panel.update({ kind: 'error', code: 'aborted', message: 'AbortError', chunks: [] });
    expect(el.querySelector('.ask-status').textContent).toBe(statusBefore);
    expect(el.querySelector('.ask-card-title').textContent).toBe('Prior card');
    expect(el.textContent.toLowerCase()).not.toMatch(/something went wrong|ran into a problem|rejected|couldn.?t reach/);
  });

  it('does not crash on the M2-unreachable downloading/generating states', () => {
    const { panel } = makePanel();
    expect(() => panel.update({ kind: 'downloading', progress: 0.5 })).not.toThrow();
    expect(() => panel.update({ kind: 'generating', question: 'q', chunks: [] })).not.toThrow();
  });
});

// --- Layer 1b: M3 answer / states / opt-in card ------------------------------

describe('ask-panel — M3 answer rendering & sanitization', () => {
  it('renders a model answer as SANITIZED markdown (**x** -> <strong>)', () => {
    const { el, panel } = makePanel();
    panel.update({ kind: 'answered', question: 'q', answer: 'Pull a **shot** of espresso.', citations: [], grounded: true, usedModel: true });
    const answer = el.querySelector('.ask-answer');
    expect(answer).not.toBeNull();
    expect(answer.querySelector('strong')).not.toBeNull();
    expect(answer.querySelector('strong').textContent).toBe('shot');
    expect(answer.textContent).toContain('espresso');
  });

  it('sanitizes a <script> payload in the answer — no live script, no execution', () => {
    const { el, panel } = makePanel();
    panel.update({
      kind: 'answered', question: 'q',
      answer: 'Here you go.\n\n<script>window.__pwned = 1</script>',
      citations: [], grounded: true, usedModel: true,
    });
    // DOMPurify (via renderMarkdown) strips the script element entirely.
    expect(el.querySelector('script')).toBeNull();
    expect(window.__pwned).toBeUndefined();
  });

  it('sanitizes an <img onerror> payload in the answer — attribute stripped, no execution', () => {
    const { el, panel } = makePanel();
    panel.update({
      kind: 'answered', question: 'q',
      answer: 'text <img src=x onerror="window.__pwned2 = 1"> more',
      citations: [], grounded: true, usedModel: true,
    });
    expect(el.querySelector('.ask-answer [onerror]')).toBeNull();
    expect(window.__pwned2).toBeUndefined();
  });

  it('renders clickable citation cards from Chunk objects', () => {
    const { el, panel, onCitation } = makePanel();
    panel.update({
      kind: 'answered', question: 'q', answer: 'See notes.',
      citations: [chunk({ noteId: 'src1', noteTitle: 'Source Note', heading: 'A > B' })],
      grounded: true, usedModel: true,
    });
    const card = el.querySelector('.ask-card');
    expect(card).not.toBeNull();
    expect(card.querySelector('.ask-card-title').textContent).toBe('Source Note');
    card.click();
    expect(onCitation).toHaveBeenCalledWith('src1');
  });

  it('grounded:false still shows the answer plus a subdued "not in your notes" affordance', () => {
    const { el, panel } = makePanel();
    panel.update({ kind: 'answered', question: 'q', answer: 'Nothing in your notes matches that.', citations: [], grounded: false, usedModel: false });
    expect(el.textContent).toContain('Nothing in your notes matches that.');
    expect(el.querySelector('.ask-ungrounded')).not.toBeNull();
  });

  it('generating shows a thinking indicator and clears any prior answer', () => {
    const { el, panel } = makePanel();
    panel.update({ kind: 'answered', question: 'q', answer: 'old answer here', citations: [], grounded: true, usedModel: true });
    expect(el.querySelector('.ask-answer')).not.toBeNull();
    panel.update({ kind: 'generating', question: 'q', chunks: [] });
    expect(el.querySelector('.ask-answer')).toBeNull(); // prior answer cleared
    expect(el.querySelector('.ask-thinking')).not.toBeNull();
    expect(el.querySelector('.ask-status').textContent.toLowerCase()).toMatch(/think|generat/);
  });

  it('downloading renders a progress bar reflecting the fraction', () => {
    const { el, panel } = makePanel();
    panel.update({ kind: 'downloading', progress: 0.5 });
    const bar = el.querySelector('.ask-progress-bar');
    expect(bar).not.toBeNull();
    expect(bar.style.width).toBe('50%');
    expect(el.querySelector('.ask-status').textContent).toContain('50');
  });

  // [E6 review fix] enableModel's progress ticks are not signal-gated, so they can
  // arrive after the user moved on. They must never repaint over newer content.
  it('a download tick arriving after a NEWER ask finalized does not clobber it (status still updates)', () => {
    const { el, panel } = makePanel();
    panel.open();
    el.querySelector('.ask-input').value = 'q1';
    el.querySelector('.ask-submit').click();
    panel.update({ kind: 'searching', question: 'q1' });
    panel.update(snippetsState([chunk()], 'model-downloadable'));
    el.querySelector('.ask-optin-enable').click(); // captures the download's exchange

    // User asks something new while the model downloads.
    panel.update({ kind: 'searching', question: 'q2' });
    panel.update({
      kind: 'answered', question: 'q2', answer: 'Second answer', citations: [], chunks: [],
      grounded: true, provider: 'builtin', usedModel: true,
    });

    panel.update({ kind: 'downloading', progress: 0.5 }); // late tick
    expect(el.querySelector('.ask-answer').textContent).toContain('Second answer'); // not wiped
    expect(el.querySelector('.ask-progress-bar')).toBeNull(); // no bar over the new exchange
    expect(el.querySelector('.ask-status').textContent).toContain('50'); // progress still visible
  });

  it('a download tick arriving after New chat does not append an orphan progress exchange', () => {
    const { el, panel } = makePanel();
    panel.open();
    el.querySelector('.ask-input').value = 'q1';
    el.querySelector('.ask-submit').click();
    panel.update({ kind: 'searching', question: 'q1' });
    panel.update(snippetsState([chunk()], 'model-downloadable'));
    el.querySelector('.ask-optin-enable').click();

    el.querySelector('.ask-newchat').click(); // thread cleared mid-download

    panel.update({ kind: 'downloading', progress: 0.75 }); // late tick
    expect(el.querySelectorAll('.ask-exchange')).toHaveLength(0); // no orphan
    expect(el.querySelector('.ask-progress-bar')).toBeNull();
    expect(el.querySelector('.ask-status').textContent).toContain('75');
  });
});

describe('ask-panel — M3 download opt-in card', () => {
  it('shows the opt-in card for model-downloadable when not declined; [Enable] fires onEnableModel with the last question', () => {
    const { el, panel, onEnableModel } = makePanel();
    // Ask first so the panel remembers lastQuestion for the re-ask.
    panel.open();
    el.querySelector('.ask-input').value = 'how do rockets work';
    el.querySelector('.ask-submit').click();
    panel.update(snippetsState([chunk()], 'model-downloadable'));

    const card = el.querySelector('.ask-optin');
    expect(card).not.toBeNull();
    expect(card.textContent).toContain('built-in AI'); // verbatim copy present
    expect(card.textContent).toContain('never sent to any AI service');

    card.querySelector('.ask-optin-enable').click();
    expect(onEnableModel).toHaveBeenCalledWith('how do rockets work');
  });

  it('dismiss persists (onDeclineAi) + hides the card, and it NEVER reappears on later model-downloadable states', () => {
    const { el, panel, onDeclineAi } = makePanel();
    panel.update(snippetsState([chunk()], 'model-downloadable'));
    expect(el.querySelector('.ask-optin')).not.toBeNull();

    el.querySelector('.ask-optin-dismiss').click();
    expect(onDeclineAi).toHaveBeenCalledTimes(1);
    expect(el.querySelector('.ask-optin')).toBeNull();

    // A subsequent model-downloadable state must NOT bring the card back this session.
    panel.update(snippetsState([chunk()], 'model-downloadable'));
    expect(el.querySelector('.ask-optin')).toBeNull();
  });

  it('does NOT show the opt-in card when the model is merely unavailable', () => {
    const { el, panel } = makePanel();
    panel.update(snippetsState([chunk()], 'model-unavailable'));
    expect(el.querySelector('.ask-optin')).toBeNull();
    expect(el.querySelectorAll('.ask-card').length).toBeGreaterThan(0); // still shows snippets
  });

  it('respects a pre-set aiDeclined pref — no card even on the first model-downloadable state', () => {
    const { el, panel } = makePanel({ aiDeclined: true });
    panel.update(snippetsState([chunk()], 'model-downloadable'));
    expect(el.querySelector('.ask-optin')).toBeNull();
  });
});

// [Task E5] "Related notes" — the retrieved PRIMARIES rendered as clickable rows
// under the answer, so an answer always offers a way to jump to its source notes
// even when the model cites nothing. Dedupe-by-note and citation-exclusion are
// the load-bearing rules under test here.
describe('ask-panel — related notes section', () => {
  it('shows one row per non-cited note, deduped to the first (highest-ranked) chunk', () => {
    const { el, panel } = makePanel();
    panel.update({
      kind: 'answered', question: 'q', answer: 'Answer.',
      citations: [chunk({ id: 'a::0', noteId: 'a', noteTitle: 'Note A' })],
      chunks: [
        chunk({ id: 'a::0', noteId: 'a', noteTitle: 'Note A' }), // cited -> excluded
        chunk({ id: 'b::0', noteId: 'b', noteTitle: 'Note B', text: 'first b chunk' }),
        chunk({ id: 'b::1', noteId: 'b', noteTitle: 'Note B', text: 'second b chunk' }), // dup note -> dropped
      ],
      grounded: true, usedModel: true,
    });
    const rows = el.querySelectorAll('.ask-related-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector('.ask-related-title').textContent).toBe('Note B');
    expect(rows[0].querySelector('.ask-related-snippet').textContent).toContain('first b chunk');
    expect(el.querySelector('.ask-related-label')).not.toBeNull();
  });

  it('clicking a related row calls onCitation with that chunk noteId', () => {
    const { el, panel, onCitation } = makePanel();
    panel.update({
      kind: 'answered', question: 'q', answer: 'Answer.',
      citations: [],
      chunks: [chunk({ id: 'b::0', noteId: 'b', noteTitle: 'Note B' })],
      grounded: true, usedModel: true,
    });
    el.querySelector('.ask-related-row').click();
    expect(onCitation).toHaveBeenCalledWith('b');
  });

  it('renders NO section when citations already cover every retrieved note', () => {
    const { el, panel } = makePanel();
    panel.update({
      kind: 'answered', question: 'q', answer: 'Answer.',
      citations: [chunk({ id: 'a::0', noteId: 'a', noteTitle: 'Note A' })],
      chunks: [chunk({ id: 'a::0', noteId: 'a', noteTitle: 'Note A' })],
      grounded: true, usedModel: true,
    });
    expect(el.querySelectorAll('.ask-related-row')).toHaveLength(0);
    expect(el.querySelector('.ask-related-label')).toBeNull();
  });

  it('zero-hit answered (chunks: []) shows no related section', () => {
    const { el, panel } = makePanel();
    panel.update({
      kind: 'answered', question: 'q', answer: 'Nothing in your notes matches that.',
      citations: [], chunks: [], grounded: false, usedModel: false,
    });
    expect(el.querySelectorAll('.ask-related-row')).toHaveLength(0);
    expect(el.querySelector('.ask-related-label')).toBeNull();
  });

  it('NEVER uses innerHTML on related note text — HTML in title/text renders as literal text', () => {
    const { el, panel } = makePanel();
    panel.update({
      kind: 'answered', question: 'q', answer: 'Answer.',
      citations: [],
      chunks: [chunk({
        id: 'x::0', noteId: 'x', noteTitle: '<b>Bold</b> title',
        text: '<img src=x onerror="window.__pwnedRelated=1">',
      })],
      grounded: true, usedModel: true,
    });
    const row = el.querySelector('.ask-related-row');
    expect(row.querySelector('b')).toBeNull();
    expect(row.querySelector('img')).toBeNull();
    expect(row.querySelector('.ask-related-title').textContent).toBe('<b>Bold</b> title');
    expect(row.querySelector('.ask-related-snippet').textContent).toContain('<img');
    expect(window.__pwnedRelated).toBeUndefined();
  });
});

// [Task E6] Chat-thread panel: each ask appends an exchange (question bubble +
// a pending indicator that resolves into the answer), previous exchanges stay
// live in the DOM, the input clears + keeps focus, Enter is IME-safe, and a
// "New chat" button resets the thread.
describe('ask-panel — chat thread (E6)', () => {
  it('keeps prior exchanges visible AND clickable as new asks are appended (newest last)', () => {
    const { el, panel, onCitation } = makePanel();
    panel.open();

    // Ask 1: searching -> generating -> answered (with a citation).
    panel.update({ kind: 'searching', question: 'q1' });
    panel.update({ kind: 'generating', question: 'q1', chunks: [] });
    panel.update({
      kind: 'answered', question: 'q1', answer: 'answer one',
      citations: [chunk({ id: 'c1::0', noteId: 'note1', noteTitle: 'Cited One' })],
      chunks: [chunk({ id: 'c1::0', noteId: 'note1', noteTitle: 'Cited One' })],
      grounded: true, usedModel: true,
    });

    // Ask 2: a fresh exchange — does NOT wipe the first.
    panel.update({ kind: 'searching', question: 'q2' });
    panel.update({ kind: 'generating', question: 'q2', chunks: [] });
    panel.update({
      kind: 'answered', question: 'q2', answer: 'answer two',
      citations: [], chunks: [chunk({ id: 'r2::0', noteId: 'note2', noteTitle: 'Related Two' })],
      grounded: true, usedModel: true,
    });

    // Both answers present, oldest first / newest last.
    const answers = el.querySelectorAll('.ask-answer');
    expect(answers).toHaveLength(2);
    expect(answers[0].textContent).toContain('answer one');
    expect(answers[1].textContent).toContain('answer two');
    expect(el.querySelectorAll('.ask-exchange')).toHaveLength(2);
    // Both question bubbles present, in order.
    expect([...el.querySelectorAll('.ask-q')].map((q) => q.textContent)).toEqual(['q1', 'q2']);

    // The FIRST exchange's citation is still LIVE after the 2nd answer rendered —
    // the closure over noteId survives the append (no rewiring).
    const firstExchange = el.querySelectorAll('.ask-exchange')[0];
    firstExchange.querySelector('.ask-card').click();
    expect(onCitation).toHaveBeenCalledWith('note1');
  });

  it('clears the input and keeps focus after firing an ask', () => {
    const { el, panel, onAsk } = makePanel();
    panel.open();
    const input = el.querySelector('.ask-input');
    input.value = 'what is a pod';
    el.querySelector('.ask-submit').click();
    expect(onAsk).toHaveBeenCalledWith('what is a pod');
    expect(input.value).toBe('');                       // cleared for the next question
    expect(document.activeElement).toBe(input);         // ...focus kept for a follow-up
  });

  it('does NOT submit an Enter fired mid-IME-composition (CJK), but a normal Enter submits', () => {
    const { el, panel, onAsk } = makePanel();
    panel.open();
    const input = el.querySelector('.ask-input');
    input.value = '中文问题';
    // Enter confirming an IME candidate — must NOT fire the ask.
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
    expect(onAsk).not.toHaveBeenCalled();
    // Legacy IME signal (keyCode 229) — also must NOT fire.
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true }));
    expect(onAsk).not.toHaveBeenCalled();
    // A normal Enter (composition finished) DOES submit.
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onAsk).toHaveBeenCalledWith('中文问题');
    expect(onAsk).toHaveBeenCalledTimes(1);
  });

  it('New chat empties the thread + input, keeps focus, and lets a later ask start fresh', () => {
    const { el, panel } = makePanel();
    panel.open();
    panel.update({ kind: 'searching', question: 'first q' });
    panel.update({
      kind: 'answered', question: 'first q', answer: 'first answer',
      citations: [], chunks: [], grounded: true, usedModel: true,
    });
    expect(el.querySelector('.ask-answer')).not.toBeNull();

    const input = el.querySelector('.ask-input');
    input.value = 'typed but not sent';
    el.querySelector('.ask-newchat').click();

    expect(el.querySelector('.ask-answer')).toBeNull();          // thread wiped
    expect(el.querySelectorAll('.ask-exchange')).toHaveLength(0);
    expect(input.value).toBe('');                                // input wiped
    expect(document.activeElement).toBe(input);                  // focus kept

    // A subsequent ask starts a brand-new exchange.
    panel.update({ kind: 'searching', question: 'second q' });
    expect(el.querySelectorAll('.ask-exchange')).toHaveLength(1);
  });

  it('New chat resets lastQuestion so a later enable→re-ask cannot resurrect it', () => {
    const { el, panel, onEnableModel } = makePanel();
    panel.open();
    el.querySelector('.ask-input').value = 'old question';
    el.querySelector('.ask-submit').click();   // remembers lastQuestion = 'old question'
    el.querySelector('.ask-newchat').click();  // ...which New chat must reset to ''

    panel.update(snippetsState([chunk()], 'model-downloadable'));
    el.querySelector('.ask-optin-enable').click();
    expect(onEnableModel).toHaveBeenCalledWith(''); // not 'old question'
  });

  it('a superseding ask removes the prior exchange pending indicator (no orphan Thinking…)', () => {
    const { el, panel } = makePanel();
    panel.open();
    panel.update({ kind: 'searching', question: 'q1' }); // exchange A, pending
    panel.update({ kind: 'searching', question: 'q2' }); // supersedes A before it resolved
    // Only ONE pending indicator (q2's); q1's stale indicator was removed.
    expect(el.querySelectorAll('.ask-thinking')).toHaveLength(1);
    // The asked question bubbles may both remain.
    expect([...el.querySelectorAll('.ask-q')].map((q) => q.textContent)).toEqual(['q1', 'q2']);
  });

  it('an aborted error removes the pending indicator without any scary error copy', () => {
    const { el, panel } = makePanel();
    panel.open();
    panel.update({ kind: 'searching', question: 'q1' });
    expect(el.querySelector('.ask-thinking')).not.toBeNull();
    panel.update({ kind: 'error', code: 'aborted', message: 'AbortError', chunks: [] });
    expect(el.querySelector('.ask-thinking')).toBeNull();   // pending indicator gone
    expect(el.textContent.toLowerCase()).not.toMatch(/something went wrong|ran into a problem|rejected|couldn.?t reach/);
  });
});

// [Task E7] Current-note context chip: a dismissible pill under the input showing
// the open note's title, which pins that note into the model context. getCurrentNote
// feeds it; fire() passes { pinnedNoteId } while the chip is active. Dismissal is
// per-note (resets on note change / reopen). Title is untrusted → textContent.
describe('ask-panel — current-note chip (E7)', () => {
  it('renders the current note title as a chip under the input (textContent, XSS-safe)', () => {
    const evil = '<img src=x onerror="window.__chipPwned=1"> Meeting notes';
    const { el, panel } = makePanel({ getCurrentNote: () => ({ id: 'n1', title: evil }) });
    panel.open();
    const chip = el.querySelector('.ask-chip');
    expect(chip).not.toBeNull();
    // No element parsed from the untrusted title — it is a literal text node.
    expect(chip.querySelector('img')).toBeNull();
    expect(el.querySelector('.ask-chip-title').textContent).toContain('<img');
    expect(window.__chipPwned).toBeUndefined();
  });

  it('shows no chip when getCurrentNote returns null', () => {
    const { el, panel } = makePanel({ getCurrentNote: () => null });
    panel.open();
    expect(el.querySelector('.ask-chip')).toBeNull();
  });

  it('shows no chip when getCurrentNote is not provided (default → null)', () => {
    const { el, panel } = makePanel(); // no getCurrentNote in the callbacks
    panel.open();
    expect(el.querySelector('.ask-chip')).toBeNull();
  });

  it('fire() passes { pinnedNoteId } while the chip is active', () => {
    const { el, panel, onAsk } = makePanel({ getCurrentNote: () => ({ id: 'n7', title: 'Current' }) });
    panel.open();
    el.querySelector('.ask-input').value = 'summarize this note';
    el.querySelector('.ask-submit').click();
    expect(onAsk).toHaveBeenCalledWith('summarize this note', { pinnedNoteId: 'n7' });
  });

  it('dismissing the chip hides it and a later fire() passes NO pinnedNoteId', () => {
    const { el, panel, onAsk } = makePanel({ getCurrentNote: () => ({ id: 'n7', title: 'Current' }) });
    panel.open();
    expect(el.querySelector('.ask-chip')).not.toBeNull();

    el.querySelector('.ask-chip-dismiss').click();
    expect(el.querySelector('.ask-chip')).toBeNull(); // hidden

    el.querySelector('.ask-input').value = 'q';
    el.querySelector('.ask-submit').click();
    // Single-arg call (no opts) — the chip is dismissed, so nothing is pinned.
    expect(onAsk).toHaveBeenCalledWith('q');
  });

  it('a note-id change resets an earlier dismissal (chip reappears for the new note)', () => {
    let cur = { id: 'A', title: 'Note A' };
    const { el, panel, onAsk } = makePanel({ getCurrentNote: () => cur });
    panel.open();
    el.querySelector('.ask-chip-dismiss').click(); // dismiss note A
    expect(el.querySelector('.ask-chip')).toBeNull();

    cur = { id: 'B', title: 'Note B' };
    el.querySelector('.ask-input').value = 'q'; // fire() refreshes the chip afterward
    el.querySelector('.ask-submit').click();

    // That fire had no active chip (A was dismissed) → single-arg call.
    expect(onAsk).toHaveBeenCalledWith('q');
    // ...but the chip now reappears for the NEW note B (dismissal reset on id change).
    expect(el.querySelector('.ask-chip-title').textContent).toBe('Note B');
  });

  it('reopening the drawer re-offers a chip that was dismissed for the same note', () => {
    const { el, panel } = makePanel({ getCurrentNote: () => ({ id: 'n7', title: 'Current' }) });
    panel.open();
    el.querySelector('.ask-chip-dismiss').click();
    expect(el.querySelector('.ask-chip')).toBeNull();
    panel.close();
    panel.open();
    expect(el.querySelector('.ask-chip')).not.toBeNull(); // reopen re-offers it
  });

  it('the chip dismiss button is in the DOM only while the chip is visible (clean focus trap)', () => {
    const { el, panel } = makePanel({ getCurrentNote: () => ({ id: 'n1', title: 'Cur' }) });
    panel.open();
    expect(el.querySelector('.ask-chip-dismiss')).not.toBeNull();
    el.querySelector('.ask-chip-dismiss').click();
    expect(el.querySelector('.ask-chip-dismiss')).toBeNull(); // no invisible focusable left behind
  });
});

// [Task E9] One-click "Summarize this note" quick action. A "Summarize" button in
// the chip row (so it shares the chip's visibility lifecycle) fires a normal ask
// exchange for the WHOLE note: onAsk('Summarize this note.', { pinnedNoteId, pinAll:true }).
// The opts are remembered (lastAskOpts) so an enable→re-ask re-runs it AS a summarize.
describe('ask-panel — summarize quick action (E9)', () => {
  it('renders a Summarize button with the chip and fires onAsk(SUMMARIZE, {pinnedNoteId, pinAll:true}) as a normal exchange', () => {
    const { el, panel, onAsk } = makePanel({ getCurrentNote: () => ({ id: 'n9', title: 'My Note' }) });
    panel.open();
    const btn = el.querySelector('.ask-summarize');
    expect(btn).not.toBeNull();
    expect(btn.getAttribute('aria-label')).toBe('Summarize this note');

    btn.click();
    expect(onAsk).toHaveBeenCalledWith('Summarize this note.', { pinnedNoteId: 'n9', pinAll: true });

    // Rides on the normal exchange flow — the searching state the controller would
    // emit renders a question bubble carrying the summarize text.
    panel.update({ kind: 'searching', question: 'Summarize this note.' });
    expect(el.querySelector('.ask-q').textContent).toBe('Summarize this note.');
  });

  it('shows no Summarize button when there is no current note', () => {
    const { el, panel } = makePanel({ getCurrentNote: () => null });
    panel.open();
    expect(el.querySelector('.ask-summarize')).toBeNull();
  });

  it('removes the Summarize button when the chip is dismissed (shares the chip lifecycle)', () => {
    const { el, panel } = makePanel({ getCurrentNote: () => ({ id: 'n1', title: 'Cur' }) });
    panel.open();
    expect(el.querySelector('.ask-summarize')).not.toBeNull();
    el.querySelector('.ask-chip-dismiss').click();
    expect(el.querySelector('.ask-chip')).toBeNull();
    expect(el.querySelector('.ask-summarize')).toBeNull(); // gone with the chip (no orphan focusable)
  });

  it('enable→re-ask preserves summarize opts: [Enable] after a summarize calls onEnableModel(SUMMARIZE, {pinnedNoteId, pinAll:true})', () => {
    const { el, panel, onEnableModel } = makePanel({ getCurrentNote: () => ({ id: 'n5', title: 'Note Five' }) });
    panel.open();
    el.querySelector('.ask-summarize').click(); // remembers lastQuestion + lastAskOpts
    // pinAll on a downloadable model → snippets{chunks:[], model-downloadable} → opt-in card.
    panel.update(snippetsState([], 'model-downloadable'));
    expect(el.querySelector('.ask-optin')).not.toBeNull();

    el.querySelector('.ask-optin-enable').click();
    expect(onEnableModel).toHaveBeenCalledWith('Summarize this note.', { pinnedNoteId: 'n5', pinAll: true });
  });

  it('New chat resets the remembered summarize opts (a later enable→re-ask cannot resurrect them)', () => {
    const { el, panel, onEnableModel } = makePanel({ getCurrentNote: () => ({ id: 'n5', title: 'Note Five' }) });
    panel.open();
    el.querySelector('.ask-summarize').click();
    el.querySelector('.ask-newchat').click(); // clears lastQuestion AND lastAskOpts

    panel.update(snippetsState([], 'model-downloadable'));
    el.querySelector('.ask-optin-enable').click();
    // lastQuestion reset to '' and lastAskOpts to undefined → a single-arg enable, no opts.
    expect(onEnableModel).toHaveBeenCalledWith('');
  });
});

// --- Layer 2: app integration over fake-chrome -------------------------------

let app, bm, encode;

async function seedNote(folder, { id, title, body }) {
  const note = { id, title, body, version: 1, hash: contentHash(body) };
  const bookmarkId = await bm.createNote(folder, title, await encode(note));
  return { note, bookmarkId };
}

const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));

describe('ask-panel — cross-notebook citation open (app integration)', () => {
  beforeEach(async () => {
    installFakeChrome();
    document.body.innerHTML =
      '<div id="toolbar"></div><aside id="sidebar"></aside><section id="note-list"></section>'
      + '<main id="editor"></main><aside id="ask-panel" hidden></aside><div id="toast" hidden></div>';
    app = await import('../src/app/app.js');
    bm = await import('../src/lib/bookmarks.js');
    ({ encode } = await import('../src/lib/codec.js'));
    app.resetUI();
    app.getAskIndex().build([]); // clear the module-level singleton between tests
  });

  afterEach(async () => {
    try { app.resetUI(); } catch { /* ignore */ }
    await settle();
  });

  it('opens a citation whose note lives in a non-active notebook, switching folder', async () => {
    const root = await bm.ensureRoot();
    const nbB = await bm.createNotebook(root, 'Notebook B');
    await seedNote(root, { id: 'a1', title: 'Rockets', body: 'A rocket engine burns liquid oxygen and kerosene.' });
    await seedNote(nbB, { id: 'b1', title: 'Volcano', body: 'A volcano erupts when magma reaches the surface.' });
    await app.initUI(root);
    await app.rebuildAskIndex(); // deterministic corpus (don't race the floating boot build)

    // Drawer opens from the toolbar Ask button.
    const askBtn = [...document.querySelectorAll('#toolbar button')].find((b) => b.textContent === 'Ask');
    expect(askBtn).toBeTruthy();
    askBtn.click();
    expect(document.getElementById('ask-panel').hidden).toBe(false);

    // Ask a question that matches only the note in Notebook B.
    document.querySelector('#ask-panel .ask-input').value = 'magma';
    document.querySelector('#ask-panel .ask-submit').click();
    await settle();

    const cards = document.querySelectorAll('#ask-panel .ask-card');
    expect(cards.length).toBeGreaterThan(0);
    const target = [...cards].find((c) => c.textContent.includes('Volcano'));
    expect(target).toBeTruthy();

    // Click the citation — its note is in Notebook B, not the active (root) folder.
    target.click();
    await settle();

    // The app switched the active folder to Notebook B AND opened the note.
    expect(document.querySelector('#editor .note-title').value).toBe('Volcano');
    expect(document.querySelector('#sidebar .item.folder.active .nb-label')?.textContent).toBe('Notebook B');
  });

  it('renders retrieval-only snippet cards (stub provider is unavailable)', async () => {
    const root = await bm.ensureRoot();
    await seedNote(root, { id: 'c1', title: 'Coffee', body: 'Tamp the grounds evenly before pulling a shot of espresso.' });
    await app.initUI(root);
    await app.rebuildAskIndex();

    [...document.querySelectorAll('#toolbar button')].find((b) => b.textContent === 'Ask').click();
    document.querySelector('#ask-panel .ask-input').value = 'espresso';
    document.querySelector('#ask-panel .ask-submit').click();
    await settle();

    expect(document.querySelectorAll('#ask-panel .ask-card').length).toBeGreaterThan(0);
    // Degraded to retrieval-only: the model-unavailable note is shown, no answer.
    expect(document.querySelector('#ask-panel .ask-note')).not.toBeNull();
  });
});

// --- Layer 3: built-in provider end-to-end (real registry + fake LanguageModel)
// Installs the T7 fake Prompt API global so the REAL registry/builtin provider
// produces answers, downloads, and the opt-in card through the whole app wiring.
// The fake is UNINSTALLED in afterEach — a leaked global would corrupt other suites.

describe('ask-panel — built-in provider answer (app integration)', () => {
  let lm = null;

  const openAndAsk = async (q) => {
    [...document.querySelectorAll('#toolbar button')].find((b) => b.textContent === 'Ask').click();
    document.querySelector('#ask-panel .ask-input').value = q;
    document.querySelector('#ask-panel .ask-submit').click();
    await settle();
  };

  beforeEach(async () => {
    installFakeChrome();
    document.body.innerHTML =
      '<div id="toolbar"></div><aside id="sidebar"></aside><section id="note-list"></section>'
      + '<main id="editor"></main><aside id="ask-panel" hidden></aside><div id="toast" hidden></div>';
    app = await import('../src/app/app.js');
    bm = await import('../src/lib/bookmarks.js');
    ({ encode } = await import('../src/lib/codec.js'));
    app.resetUI();
    app.getAskIndex().build([]);
  });

  afterEach(async () => {
    if (lm) { lm.uninstall(); lm = null; } // uninstall so the fake global never leaks into other suites
    try { app.resetUI(); } catch { /* ignore */ }
    await settle();
  });

  it('with an available model, an ask renders the markdown answer + a clickable citation that opens the note', async () => {
    // Cite the first chunk id the prompt actually contains, so the citation resolves.
    lm = installFakeLanguageModel({
      availability: 'available',
      promptResult: (input) => {
        const m = input.match(/<<<NOTE c:([^>\s]+)/);
        const id = m ? m[1] : '';
        return JSON.stringify({ answer: 'Pull a **shot** of espresso.', citations: id ? [id] : [], grounded: true });
      },
    });
    const root = await bm.ensureRoot();
    await seedNote(root, { id: 'c1', title: 'Coffee', body: 'Tamp the grounds evenly before pulling a shot of espresso.' });
    await app.initUI(root);
    await app.rebuildAskIndex();

    await openAndAsk('espresso');

    const answer = document.querySelector('#ask-panel .ask-answer');
    expect(answer).not.toBeNull();
    expect(answer.querySelector('strong')).not.toBeNull(); // **shot** -> <strong> (markdown applied)
    expect(answer.textContent).toContain('espresso');

    const cards = document.querySelectorAll('#ask-panel .ask-card');
    expect(cards.length).toBeGreaterThan(0);
    cards[0].click(); // citation click opens the cited note
    await settle();
    expect(document.querySelector('#editor .note-title').value).toBe('Coffee');
  });

  it('a downloadable model shows the opt-in card; [Enable] triggers the model download (gesture-safe)', async () => {
    lm = installFakeLanguageModel({ availability: 'downloadable', downloadProgress: [0.5, 1] });
    const root = await bm.ensureRoot();
    await seedNote(root, { id: 'r1', title: 'Rockets', body: 'A rocket engine burns liquid oxygen and kerosene.' });
    await app.initUI(root);
    await app.rebuildAskIndex();

    await openAndAsk('rocket');

    const card = document.querySelector('#ask-panel .ask-optin');
    expect(card).not.toBeNull();
    // USER-GESTURE: the click must reach LanguageModel.create() synchronously.
    card.querySelector('.ask-optin-enable').click();
    await settle();
    expect(lm.createCalls.length).toBeGreaterThan(0); // the download was triggered from the gesture
  });

  it('dismissing the opt-in card persists ask:aiDeclined and it never reappears', async () => {
    lm = installFakeLanguageModel({ availability: 'downloadable' });
    const root = await bm.ensureRoot();
    await seedNote(root, { id: 'r1', title: 'Rockets', body: 'A rocket engine burns liquid oxygen and kerosene.' });
    await app.initUI(root);
    await app.rebuildAskIndex();

    await openAndAsk('rocket');
    expect(document.querySelector('#ask-panel .ask-optin')).not.toBeNull();

    document.querySelector('#ask-panel .ask-optin-dismiss').click();
    await settle();
    expect((await chrome.storage.local.get('ask:aiDeclined'))['ask:aiDeclined']).toBe(true);

    // Re-ask the same downloadable state — the card must stay gone.
    document.querySelector('#ask-panel .ask-submit').click();
    await settle();
    expect(document.querySelector('#ask-panel .ask-optin')).toBeNull();
  });
});
