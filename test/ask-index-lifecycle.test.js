// Integration tests for the ask-index wiring in src/app/app.js — proves the
// lexical index stays in sync with the live corpus across boot, save, delete,
// and external bookmark changes. Uses the same fake-chrome boot harness as
// app-integration.test.js and asserts REAL index state via getAskIndex().
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import { contentHash } from '../src/lib/note.js';

let app, bm, encode;

beforeEach(async () => {
  installFakeChrome();
  document.body.innerHTML =
    '<div id="toolbar"></div><aside id="sidebar"></aside><section id="note-list"></section><main id="editor"></main><div id="toast" hidden></div>';
  app = await import('../src/app/app.js');
  bm = await import('../src/lib/bookmarks.js');
  ({ encode } = await import('../src/lib/codec.js'));
  app.resetUI();
  app.getAskIndex().build([]); // the index is a module-level singleton — clear it between tests
});

afterEach(async () => {
  try { app.resetUI(); } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 50)); // drain in-flight refresh/rebuild against THIS fake-chrome
});

const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

// Write a real note bookmark under `folder`, exactly as a normal save would, so
// loadNotes() decodes it back into the corpus.
async function seedNote(folder, { id, title, body }) {
  const note = { id, title, body, version: 1, hash: contentHash(body) };
  const bookmarkId = await bm.createNote(folder, title, await encode(note));
  return { note, bookmarkId };
}

function typeAndSave({ title, body }) {
  if (title != null) {
    const t = document.querySelector('#editor .note-title');
    t.value = title;
    t.dispatchEvent(new Event('input'));
  }
  const ta = document.querySelector('#editor textarea.note-body');
  ta.value = body;
  ta.dispatchEvent(new Event('input'));
  document.querySelector('#editor button.save').click();
}

describe('ask index lifecycle', () => {
  it('builds the index from the whole corpus on boot', async () => {
    const root = await bm.ensureRoot();
    await seedNote(root, { id: 'n1', title: 'Photosynthesis', body: 'Plants use chloroplasts to capture sunlight.' });
    await seedNote(root, { id: 'n2', title: 'Kubernetes', body: 'A pod is the smallest deployable unit.' });
    await seedNote(root, { id: 'n3', title: 'Sourdough', body: 'Ferment the levain overnight before baking.' });
    await app.initUI(root);
    await app.rebuildAskIndex(); // deterministic: await the exposed rebuild rather than racing the floating boot build
    const idx = app.getAskIndex();
    expect(idx.stats().notes).toBe(3);
    expect(idx.query('chloroplasts').some((h) => h.noteId === 'n1')).toBe(true);
  });

  it('excludes a trashed note from the index', async () => {
    const { ensureTrash, trashNotes } = await import('../src/lib/trash.js');
    const root = await bm.ensureRoot();
    const { note, bookmarkId } = await seedNote(root, { id: 'tr', title: 'Trashed', body: 'kryptonite is the only weakness' });
    await app.initUI(root);
    const trashId = await ensureTrash(root);
    await trashNotes([{ id: note.id, bookmarkId, folderId: root }], trashId);
    await app.rebuildAskIndex();
    const idx = app.getAskIndex();
    expect(idx.query('kryptonite').length).toBe(0);
    expect(idx.noteMeta('tr')).toBeUndefined();
  });

  it('upserts a note on save and replaces stale chunks when its body changes', async () => {
    const root = await bm.ensureRoot();
    await app.initUI(root);
    document.querySelector('button.new').click();
    typeAndSave({ title: 'Recipe', body: 'The dish uses saffron and cardamom.' });
    await settle();
    const idx = app.getAskIndex();
    expect(idx.query('saffron').length).toBeGreaterThan(0);
    // Edit the body and save again: the old term must be gone, the new one present.
    typeAndSave({ body: 'The dish uses turmeric and paprika instead.' });
    await settle();
    expect(idx.query('saffron').length).toBe(0);
    expect(idx.query('turmeric').length).toBeGreaterThan(0);
  });

  it('removes a note from the index when it is trashed via the editor delete', async () => {
    const root = await bm.ensureRoot();
    await app.initUI(root);
    document.querySelector('button.new').click();
    typeAndSave({ title: 'Deletable', body: 'a unique zebra roams the savanna' });
    await settle();
    const idx = app.getAskIndex();
    expect(idx.query('zebra').length).toBeGreaterThan(0);
    const before = idx.stats().notes;
    window.confirm = () => true;
    document.querySelector('#editor button.delete').click(); // trash-via-move: fires onMoved, NOT the live-refresh events — proves removeNote does the work
    await settle();
    expect(idx.query('zebra').length).toBe(0);
    expect(idx.stats().notes).toBe(before - 1);
  });

  it('rebuilds the index when a note is created externally (coalesced live refresh)', async () => {
    const root = await bm.ensureRoot();
    await app.initUI(root);
    const idx = app.getAskIndex();
    expect(idx.stats().notes).toBe(0);
    // An external agent (Save-selection menu, another tab, Drive sync) writes a note
    // bookmark while the app is open; fake-chrome fires onCreated like a real browser.
    await seedNote(root, { id: 'ext', title: 'External', body: 'a meteorite fragment landed in the field' });
    await settle();
    expect(idx.query('meteorite').some((h) => h.noteId === 'ext')).toBe(true);
    expect(idx.stats().notes).toBe(1);
  });

  it('coalesces a burst of external bookmark events into far fewer rebuilds than events', async () => {
    const root = await bm.ensureRoot();
    await app.initUI(root);
    await settle(); // let the floating boot build settle before counting
    const idx = app.getAskIndex();
    const origBuild = idx.build;
    let builds = 0;
    idx.build = (...a) => { builds += 1; return origBuild(...a); };
    try {
      for (let i = 0; i < 6; i += 1) chrome.bookmarks.onChanged.dispatch('x', {}); // synchronous burst
      await settle();
      expect(builds).toBeGreaterThanOrEqual(1);
      expect(builds).toBeLessThanOrEqual(2); // 6 events collapse to one coalesced cycle (a running + a queued pass)
    } finally {
      idx.build = origBuild;
    }
  });

  it('does not block boot on indexing (initial build is a floating promise)', async () => {
    const root = await bm.ensureRoot();
    await seedNote(root, { id: 'b1', title: 'One', body: 'alpha content here' });
    await seedNote(root, { id: 'b2', title: 'Two', body: 'beta content here' });
    await app.initUI(root);
    // initUI resolved WITHOUT awaiting the build — the corpus isn't indexed yet.
    expect(app.getAskIndex().stats().notes).toBe(0);
    // The build was kicked off though, and settles when awaited.
    await app.rebuildAskIndex();
    expect(app.getAskIndex().stats().notes).toBe(2);
  });
});
