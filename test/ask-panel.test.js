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
  const cbs = { onAsk: vi.fn(), onCitation: vi.fn(), onClose: vi.fn(), getStats: () => ({ notes: 3, chunks: 9 }), ...over };
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

  it('searching clears results and shows a searching status', () => {
    const { el, panel } = makePanel();
    panel.update(snippetsState([chunk()]));
    expect(el.querySelectorAll('.ask-card')).toHaveLength(1);
    panel.update({ kind: 'searching', question: 'q' });
    expect(el.querySelectorAll('.ask-card')).toHaveLength(0);
    expect(el.querySelector('.ask-status').textContent.toLowerCase()).toContain('searching');
  });

  it('zero-hit answered shows the grounded:false message', () => {
    const { el, panel } = makePanel();
    panel.update({ kind: 'answered', question: 'q', answer: 'Nothing in your notes matches that.', citations: [], grounded: false, usedModel: false });
    expect(el.textContent).toContain('Nothing in your notes matches that.');
  });

  it('error shows a friendly message and still renders the preserved chunks', () => {
    const { el, panel } = makePanel();
    panel.update({ kind: 'error', code: 'model-error', message: 'boom', chunks: [chunk({ noteId: 'e', noteTitle: 'Err note' })] });
    expect(el.querySelector('.ask-status').textContent.toLowerCase()).toMatch(/wrong|error|couldn|unavailable/);
    expect(el.querySelectorAll('.ask-card')).toHaveLength(1);
    expect(el.querySelector('.ask-card-title').textContent).toBe('Err note');
  });

  it('does not crash on the M2-unreachable downloading/generating states', () => {
    const { panel } = makePanel();
    expect(() => panel.update({ kind: 'downloading', progress: 0.5 })).not.toThrow();
    expect(() => panel.update({ kind: 'generating', question: 'q', chunks: [] })).not.toThrow();
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
