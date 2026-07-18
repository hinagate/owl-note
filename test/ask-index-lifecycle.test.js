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

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await settle(10);
  }
  if (!predicate()) throw new Error('Timed out waiting for live index refresh');
}

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

  it('restore-from-Trash reappears in the index (real onMoved event)', async () => {
    const { ensureTrash, trashNotes, restoreNotes } = await import('../src/lib/trash.js');
    const root = await bm.ensureRoot();
    const { note, bookmarkId } = await seedNote(root, { id: 'rs', title: 'Restorable', body: 'a phoenix rises from ashes' });
    await app.initUI(root);
    await app.rebuildAskIndex();
    const idx = app.getAskIndex();
    expect(idx.query('phoenix').some((h) => h.noteId === 'rs')).toBe(true);
    // Trash: real trash.js path, moves the bookmark into Trash — fires onMoved only.
    const trashId = await ensureTrash(root);
    await trashNotes([{ id: note.id, bookmarkId, folderId: root }], trashId);
    await waitFor(() => idx.query('phoenix').length === 0);
    expect(idx.query('phoenix').length).toBe(0); // gone once trashed
    // Restore: real trash.js path, moves the bookmark back out of Trash — fires onMoved only.
    await restoreNotes([{ id: note.id, bookmarkId, folderId: trashId }], root);
    await waitFor(() => idx.query('phoenix').some((hit) => hit.noteId === 'rs'));
    expect(idx.query('phoenix').some((h) => h.noteId === 'rs')).toBe(true);
    expect(idx.stats().notes).toBe(1);
  });

  it('cross-notebook move updates noteMeta(id).folderId (real onMoved event)', async () => {
    const root = await bm.ensureRoot();
    const notebookB = await bm.createNotebook(root, 'Notebook B');
    const { bookmarkId } = await seedNote(root, { id: 'mv', title: 'Movable', body: 'a wandering caravan crosses the desert' });
    await app.initUI(root);
    await app.rebuildAskIndex();
    const idx = app.getAskIndex();
    expect(idx.noteMeta('mv').folderId).toBe(root);
    // dropNote is the real drag-to-notebook app path; the note is bookmark-backed
    // (not local-only) so it goes through bm.moveNote -> chrome.bookmarks.move -> onMoved.
    await app.dropNote(bookmarkId, notebookB);
    await settle();
    expect(idx.noteMeta('mv').folderId).toBe(notebookB);
  });

  it('coalesces a burst of onMoved events into far fewer rebuilds than events', async () => {
    const root = await bm.ensureRoot();
    await app.initUI(root);
    await settle(); // let the floating boot build settle before counting
    const idx = app.getAskIndex();
    const origBuild = idx.build;
    let builds = 0;
    idx.build = (...a) => { builds += 1; return origBuild(...a); };
    try {
      for (let i = 0; i < 6; i += 1) chrome.bookmarks.onMoved.dispatch('x', { parentId: root }); // synchronous burst
      await settle();
      expect(builds).toBeGreaterThanOrEqual(1);
      expect(builds).toBeLessThanOrEqual(2); // 6 events collapse to one coalesced cycle (a running + a queued pass)
    } finally {
      idx.build = origBuild;
    }
  });

  it('does not re-add a trashed note to the index via the onMoved it fires', async () => {
    const { ensureTrash, trashNotes } = await import('../src/lib/trash.js');
    const root = await bm.ensureRoot();
    const { note, bookmarkId } = await seedNote(root, { id: 'gone', title: 'Gone', body: 'kryptonite is the only weakness' });
    await app.initUI(root);
    await app.rebuildAskIndex();
    const idx = app.getAskIndex();
    expect(idx.query('kryptonite').length).toBeGreaterThan(0);
    const trashId = await ensureTrash(root);
    await trashNotes([{ id: note.id, bookmarkId, folderId: root }], trashId); // fires onMoved, not onRemoved
    await settle();
    expect(idx.query('kryptonite').length).toBe(0);
    expect(idx.noteMeta('gone')).toBeUndefined();
  });
});

// [Task V4] Semantic (vector) index wiring: an explicit one-time Build, then silent
// automatic sync (boot catch-up / save / delete). The load-bearing guarantee is
// CONSENT — nothing semantic (no worker, no download, no embed) happens before the
// user's Build click. Fake factories stand in for the real vector-index/embed-client
// (no Worker in jsdom) via app.__setSemanticFactoriesForTests, so these assert the
// orchestration without touching a real model.
describe('semantic index lifecycle (V4)', () => {
  let vecCalls, embCalls, factoryCalls, order, embedShouldReject;

  // A deterministic in-memory stand-in for src/lib/vector-index.js. Tracks calls and
  // honors the hash-diff (skip unchanged notes) so a rejecting embed can surface.
  function makeFakeVector() {
    const stored = new Map(); // id -> hash
    let opened = false;
    return {
      async open() { vecCalls.open += 1; opened = true; },
      async upsertMissing(notes, embed) {
        vecCalls.upsertMissing.push(notes);
        order.push('upsertMissing');
        for (const n of notes) {
          if (!(stored.has(n.id) && stored.get(n.id) === n.hash)) {
            await embed(n.chunks.map((c) => c.text)); // may reject (rejecting-embed test)
            stored.set(n.id, n.hash);
          }
        }
      },
      async removeNote(id) { vecCalls.removeNote.push(id); stored.delete(id); },
      stats: () => ({ notes: stored.size, chunks: stored.size, ready: opened }),
      query: () => [],
      async clear() { stored.clear(); },
    };
  }
  // A stand-in for src/lib/embed-client.js.
  function makeFakeEmbed() {
    return {
      async ensureReady(opts) {
        embCalls.ensureReady += 1;
        order.push('ensureReady');
        if (opts && opts.onProgress) opts.onProgress({ status: 'progress', loaded: 5, total: 10 });
      },
      async embedPassages(texts) {
        embCalls.embedPassages += 1;
        if (embedShouldReject) throw new Error('fake embed boom');
        return texts.map(() => new Float32Array([0.1, 0.2, 0.3]));
      },
      async embedQuery() { embCalls.embedQuery += 1; return new Float32Array([0.1, 0.2, 0.3]); },
      stats: () => ({ spawned: true, ready: true }),
      dispose() {},
    };
  }

  beforeEach(() => {
    vecCalls = { open: 0, upsertMissing: [], removeNote: [] };
    embCalls = { ensureReady: 0, embedPassages: 0, embedQuery: 0 };
    factoryCalls = { vector: 0, embed: 0 };
    order = [];
    embedShouldReject = false;
    app.__setSemanticFactoriesForTests({
      createVectorIndex: () => { factoryCalls.vector += 1; return makeFakeVector(); },
      createEmbedClient: () => { factoryCalls.embed += 1; return makeFakeEmbed(); },
    });
  });

  afterEach(() => {
    app.__setSemanticFactoriesForTests(null); // restore the real factories for other suites
  });

  it('no flag → initUI constructs NO vector/worker (factories never called) and asks stay lexical', async () => {
    const root = await bm.ensureRoot();
    await seedNote(root, { id: 'n1', title: 'Photosynthesis', body: 'Plants use chloroplasts to capture sunlight.' });
    await app.initUI(root);
    await app.rebuildAskIndex();
    await settle();
    // THE consent guarantee: neither semantic factory ran before a Build click.
    expect(factoryCalls.vector).toBe(0);
    expect(factoryCalls.embed).toBe(0);
    expect(embCalls.embedQuery).toBe(0); // the query-embed path is unreachable pre-flag
    // Retrieval still works — lexically.
    expect(app.getAskIndex().query('chloroplasts').some((h) => h.noteId === 'n1')).toBe(true);
  });

  it('buildSemanticIndex: factories called once, ensureReady BEFORE upsertMissing, notes shaped {id,hash,chunks:[{id,text}]}, flag persisted, two progress phases', async () => {
    const root = await bm.ensureRoot();
    await seedNote(root, { id: 'n1', title: 'Kubernetes', body: 'A pod is the smallest deployable unit.' });
    await app.initUI(root);
    await app.rebuildAskIndex();

    const progress = [];
    await app.buildSemanticIndex({ onProgress: (p) => progress.push(p) });

    expect(factoryCalls.vector).toBe(1);
    expect(factoryCalls.embed).toBe(1);
    // The model must be loaded (ensureReady) before any note is embedded (upsertMissing).
    expect(order.indexOf('ensureReady')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('ensureReady')).toBeLessThan(order.indexOf('upsertMissing'));
    // Corpus shaped to vector-index's contract.
    const notes = vecCalls.upsertMissing[0];
    expect(notes).toHaveLength(1);
    expect(notes[0].id).toBe('n1');
    expect(typeof notes[0].hash).toBe('string');
    expect(Array.isArray(notes[0].chunks)).toBe(true);
    expect(typeof notes[0].chunks[0].id).toBe('string');
    expect(typeof notes[0].chunks[0].text).toBe('string');
    // Flag persisted only on success.
    expect((await chrome.storage.local.get('ask:semanticBuilt'))['ask:semanticBuilt']).toBe(true);
    // Two distinct phases surfaced.
    expect(progress.some((p) => p.phase === 'download')).toBe(true);
    expect(progress.some((p) => p.phase === 'embed')).toBe(true);
  });

  it('flag set at boot → semantic catch-up runs (upsertMissing) with no user gesture', async () => {
    await chrome.storage.local.set({ 'ask:semanticBuilt': true });
    const root = await bm.ensureRoot();
    await seedNote(root, { id: 'n1', title: 'Sourdough', body: 'Ferment the levain overnight before baking.' });
    await app.initUI(root);
    await app.rebuildAskIndex();
    await app.whenSemanticReady(); // deterministically await the floating boot catch-up

    expect(factoryCalls.vector).toBe(1); // opted-in on a prior run → constructed at boot
    expect(factoryCalls.embed).toBe(1);
    expect(embCalls.ensureReady).toBeGreaterThan(0);
    expect(vecCalls.upsertMissing.length).toBeGreaterThan(0); // caught up, no gesture
  });

  it('save with semantic enabled → upsertMissing([thatNote]) (fire-and-forget)', async () => {
    await chrome.storage.local.set({ 'ask:semanticBuilt': true });
    const root = await bm.ensureRoot();
    await app.initUI(root);
    await app.whenSemanticReady();
    const before = vecCalls.upsertMissing.length;

    document.querySelector('button.new').click();
    typeAndSave({ title: 'Recipe', body: 'The dish uses saffron and cardamom.' });
    await settle();

    const after = vecCalls.upsertMissing.slice(before);
    const single = after.find((notes) => notes.length === 1);
    expect(single).toBeTruthy(); // the one saved note was mirrored to the vector index
    expect(typeof single[0].id).toBe('string');
    expect(Array.isArray(single[0].chunks)).toBe(true);
  });

  it('delete with semantic enabled → vector removeNote(id) alongside the lexical removeNote', async () => {
    await chrome.storage.local.set({ 'ask:semanticBuilt': true });
    const root = await bm.ensureRoot();
    await app.initUI(root);
    await app.whenSemanticReady();

    document.querySelector('button.new').click();
    typeAndSave({ title: 'Deletable', body: 'a unique zebra roams the savanna' });
    await settle();
    window.confirm = () => true;
    document.querySelector('#editor button.delete').click(); // editor delete → trash
    await settle();

    expect(vecCalls.removeNote.length).toBeGreaterThan(0);
  });

  it('a rejecting fake embed leaves asks working (lexical) with no unhandled rejection', async () => {
    embedShouldReject = true;
    await chrome.storage.local.set({ 'ask:semanticBuilt': true });
    const root = await bm.ensureRoot();
    await seedNote(root, { id: 'n1', title: 'Photosynthesis', body: 'Plants use chloroplasts to capture sunlight.' });
    await app.initUI(root);
    await app.rebuildAskIndex();
    await app.whenSemanticReady(); // boot catch-up embed rejects internally; the .catch swallows it

    // Lexical retrieval is unaffected by the semantic failure.
    expect(app.getAskIndex().query('chloroplasts').some((h) => h.noteId === 'n1')).toBe(true);

    // A save also survives a rejecting embed (fire-and-forget + .catch), staying lexical.
    document.querySelector('button.new').click();
    typeAndSave({ title: 'Spices', body: 'a second note about turmeric and paprika' });
    await settle();
    expect(app.getAskIndex().query('turmeric').length).toBeGreaterThan(0);
  });
});
