import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import { _resetCache } from '../src/lib/note-key.js';

beforeEach(async () => {
  installFakeChrome();
  _resetCache();
  document.body.innerHTML =
    '<div id="toolbar"></div><aside id="sidebar"></aside><section id="note-list"></section><main id="editor"></main><div id="toast" hidden></div>';
  const app = await import('../src/app/app.js');
  app.resetUI();
});

afterEach(async () => {
  try { const app = await import('../src/app/app.js'); app.resetUI(); } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 50));
});

async function waitFor(fn, ms = 5000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('waitFor: condition not met in time');
}

const type = (selector, value) => {
  const el = document.querySelector(`#editor ${selector}`);
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return el;
};

describe('switching notes while the last one is still saving', () => {
  it('never writes the new note over the one it replaced', async () => {
    const app = await import('../src/app/app.js');
    const bm = await import('../src/lib/bookmarks.js');
    const { encode } = await import('../src/lib/codec.js');
    const root = await bm.ensureRoot();
    await bm.createNote(root, 'Groceries', await encode({ id: 'g1', title: 'Groceries', body: 'milk', created: 1000 }));
    await app.initUI(root);
    await waitFor(() => document.querySelector('#editor .note-title')?.value === 'Groceries');

    // Edit the open note, then click "New note": the click blurs the editor, whose save
    // is still running when the new note's editor appears.
    type('textarea.note-body', 'milk\neggs').dispatchEvent(new Event('blur'));
    document.querySelector('button.new').click();
    const fresh = document.querySelector('#editor textarea.note-body');
    await waitFor(async () => (await app.loadNotes(root)).some((n) => n.body === 'milk\neggs'));
    expect(document.querySelector('#editor textarea.note-body')).toBe(fresh); // not rebuilt under the reader

    // Write the new note and save it.
    type('.note-title', 'Meeting');
    type('textarea.note-body', 'agenda');
    document.querySelector('#editor button.save').click();
    await waitFor(async () => (await app.loadNotes(root)).some((n) => n.title === 'Meeting'));

    const notes = await app.loadNotes(root);
    expect(notes).toHaveLength(2);
    expect(notes.find((n) => n.id === 'g1')).toMatchObject({ title: 'Groceries', body: 'milk\neggs' });
    expect(notes.find((n) => n.id !== 'g1')).toMatchObject({ title: 'Meeting', body: 'agenda' });
  });

  const card = (title) => [...document.querySelectorAll('#note-list .card')].find((c) => c.textContent.includes(title));

  it('reopening a note whose save is still running shows what that save stored', async () => {
    const app = await import('../src/app/app.js');
    const bm = await import('../src/lib/bookmarks.js');
    const { encode } = await import('../src/lib/codec.js');
    const root = await bm.ensureRoot();
    await bm.createNote(root, 'Books', await encode({ id: 'b1', title: 'Books', body: 'dune', created: 1000 }));
    await bm.createNote(root, 'Groceries', await encode({ id: 'g1', title: 'Groceries', body: 'milk', created: 2000 }));
    await app.initUI(root);
    await waitFor(() => document.querySelector('#editor .note-title')?.value === 'Groceries');

    // Edit, leave for Books, and come straight back while the edit is still saving.
    const before = type('textarea.note-body', 'milk and eggs');
    before.dispatchEvent(new Event('blur'));
    card('Books').click();
    card('Groceries').click();
    let reopened;
    await waitFor(() => {
      reopened = document.querySelector('#editor textarea.note-body');
      return reopened !== before && document.querySelector('#editor .note-title')?.value === 'Groceries';
    });
    expect(reopened.value).toBe('milk and eggs');

    // Typing on from there keeps the edit.
    type('textarea.note-body', 'milk and eggs and bread');
    document.querySelector('#editor button.save').click();
    await waitFor(async () => (await app.loadNotes(root)).some((n) => n.body === 'milk and eggs and bread'));
    const notes = await app.loadNotes(root);
    expect(notes).toHaveLength(2);
    expect(notes.find((n) => n.id === 'b1').body).toBe('dune');
  });

  it('does not rebuild the note list under a press, so the click it ends in still lands', async () => {
    const app = await import('../src/app/app.js');
    const bm = await import('../src/lib/bookmarks.js');
    const { encode } = await import('../src/lib/codec.js');
    const root = await bm.ensureRoot();
    await bm.createNote(root, 'Books', await encode({ id: 'b1', title: 'Books', body: 'dune', created: 1000 }));
    await bm.createNote(root, 'Groceries', await encode({ id: 'g1', title: 'Groceries', body: 'milk', created: 2000 }));
    await app.initUI(root);
    await waitFor(() => document.querySelector('#editor .note-title')?.value === 'Groceries');

    // The press on a card moves focus out of the editor, which starts a blur-save.
    const target = card('Books');
    type('textarea.note-body', 'milk and eggs');
    target.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    document.querySelector('#editor textarea.note-body').dispatchEvent(new Event('blur'));
    await waitFor(async () => (await app.loadNotes(root)).some((n) => n.body === 'milk and eggs'));
    await new Promise((r) => setTimeout(r, 100));
    expect(target.isConnected).toBe(true); // the list was not rebuilt while the button was down

    target.dispatchEvent(new Event('pointerup', { bubbles: true }));
    target.click();
    await waitFor(() => document.querySelector('#editor .note-title')?.value === 'Books');
  });

  it('keeps editing the note on screen after its own save, without opening a second copy', async () => {
    const app = await import('../src/app/app.js');
    const bm = await import('../src/lib/bookmarks.js');
    const root = await bm.ensureRoot();
    await app.initUI(root);
    document.querySelector('button.new').click();
    type('.note-title', 'Draft');
    type('textarea.note-body', 'one');
    document.querySelector('#editor button.save').click();
    await waitFor(async () => (await app.loadNotes(root)).some((n) => n.body === 'one'));
    type('textarea.note-body', 'one two');
    document.querySelector('#editor button.save').click();
    await waitFor(async () => (await app.loadNotes(root)).some((n) => n.body === 'one two'));
    expect(await app.loadNotes(root)).toHaveLength(1);
  });
});

// Incompressible, so the note is over the 8 KB bookmark cap even after deflate.
function bigBody(seed = 12345) {
  let b = '';
  let x = seed;
  for (let i = 0; i < 9000; i += 1) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; b += String.fromCharCode(33 + (Math.abs(x) % 94)); }
  return b;
}

describe('saving the open note into the right place', () => {
  const editorTitle = () => document.querySelector('#editor .note-title')?.value;
  const row = (name) => [...document.querySelectorAll('#sidebar .item')].find((r) => r.textContent.includes(name));
  const dropOn = (target, handle) => {
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    drop.dataTransfer = { getData: (kind) => (kind === 'text/plain' ? handle : '') };
    target.dispatchEvent(drop);
  };

  it('re-rendering a new note while its first save runs does not create it twice', async () => {
    const app = await import('../src/app/app.js');
    const bm = await import('../src/lib/bookmarks.js');
    const root = await bm.ensureRoot();
    await chrome.storage.local.set({ 'owl:phonetics': true });
    await app.initUI(root);
    document.querySelector('button.new').click();
    type('.note-title', 'Draft');
    type('textarea.note-body', 'one').dispatchEvent(new Event('blur')); // first save: creates the note
    await app.togglePhonetics(); // the same note is drawn again while that save runs
    await waitFor(async () => (await app.loadNotes(root)).some((n) => n.body === 'one'));
    type('textarea.note-body', 'one two');
    document.querySelector('#editor button.save').click();
    await waitFor(async () => (await app.loadNotes(root)).some((n) => n.body === 'one two'));
    expect((await app.loadNotes(root)).filter((n) => n.title === 'Draft')).toHaveLength(1);
  });

  it('keeps a note in its own notebook when it outgrows bookmarks while another notebook is viewed', async () => {
    const app = await import('../src/app/app.js');
    const bm = await import('../src/lib/bookmarks.js');
    const mirror = await import('../src/lib/mirror.js');
    const { encode } = await import('../src/lib/codec.js');
    const root = await bm.ensureRoot();
    const work = await bm.createNotebook(root, 'Work');
    await bm.createNote(work, 'Plan', await encode({ id: 'p1', title: 'Plan', body: 'short', created: 3000 }));
    await app.initUI(root); // opens in All notes
    await waitFor(() => editorTitle() === 'Plan');
    type('textarea.note-body', bigBody());
    document.querySelector('#editor button.save').click();
    await waitFor(() => mirror.isLocalOnly('p1'));
    expect((await mirror.localOnlyBackups(work)).map((n) => n.id)).toContain('p1');
  });

  it('does not undo dragging the open device-local note to another notebook on its next save', async () => {
    const app = await import('../src/app/app.js');
    const bm = await import('../src/lib/bookmarks.js');
    const mirror = await import('../src/lib/mirror.js');
    const { createNote } = await import('../src/lib/note.js');
    const root = await bm.ensureRoot();
    const work = await bm.createNotebook(root, 'Work');
    const big = { ...createNote({ title: 'Log', body: bigBody() }), created: 5000 };
    await app.saveNote(big, root);
    expect(await mirror.isLocalOnly(big.id)).toBe(true);
    await app.initUI(root);
    await waitFor(() => editorTitle() === 'Log');
    dropOn(row('Work'), big.id);
    await waitFor(async () => (await mirror.localOnlyBackups(work)).some((n) => n.id === big.id));
    type('textarea.note-body', `${bigBody()} edited`);
    document.querySelector('#editor button.save').click();
    await waitFor(() => document.getElementById('toast').textContent === 'Too large to sync — saved locally only');
    expect((await mirror.getBackup(big.id)).current.body.endsWith(' edited')).toBe(true);
    expect((await mirror.localOnlyBackups(work)).map((n) => n.id)).toContain(big.id);
  });

  it('trashing a device-local note while its last edit saves leaves it in Trash', async () => {
    const app = await import('../src/app/app.js');
    const bm = await import('../src/lib/bookmarks.js');
    const mirror = await import('../src/lib/mirror.js');
    const { createNote } = await import('../src/lib/note.js');
    const root = await bm.ensureRoot();
    const big = { ...createNote({ title: 'Log', body: bigBody() }), created: 5000 };
    await app.saveNote(big, root);
    await app.initUI(root);
    await waitFor(() => editorTitle() === 'Log');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      // Clicking Delete blurs the editor, so its save is running when the delete starts.
      type('textarea.note-body', `${bigBody()} edited`).dispatchEvent(new Event('blur'));
      document.querySelector('#editor .delete').click();
      await waitFor(() => document.getElementById('toast').textContent === 'Moved to Trash');
    } finally {
      confirm.mockRestore();
    }
    await new Promise((r) => setTimeout(r, 100));
    expect((await mirror.localOnlyBackups(root)).map((n) => n.id)).not.toContain(big.id);
    expect((await app.loadNotes(root)).map((n) => n.id)).not.toContain(big.id);
  });

  it('a new note deleted while its first save runs does not stay among the notes', async () => {
    const app = await import('../src/app/app.js');
    const bm = await import('../src/lib/bookmarks.js');
    const root = await bm.ensureRoot();
    await app.initUI(root);
    document.querySelector('button.new').click();
    type('.note-title', 'Throwaway');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      type('textarea.note-body', 'x').dispatchEvent(new Event('blur'));
      document.querySelector('#editor .delete').click();
      await waitFor(() => /Moved to Trash|Discarded/.test(document.getElementById('toast').textContent));
    } finally {
      confirm.mockRestore();
    }
    await new Promise((r) => setTimeout(r, 100));
    expect((await app.loadNotes(root)).map((n) => n.title)).not.toContain('Throwaway');
  });

  it('turning Drive sync on while a device-local note is open does not duplicate it on the next save', async () => {
    const app = await import('../src/app/app.js');
    const bm = await import('../src/lib/bookmarks.js');
    const { createNote } = await import('../src/lib/note.js');
    const { saveNote } = await import('../src/lib/save-note.js');
    const root = await bm.ensureRoot();
    const big = { ...createNote({ title: 'Log', body: bigBody() }), created: 5000 };
    await app.saveNote(big, root);
    await app.initUI(root);
    await waitFor(() => editorTitle() === 'Log');
    // What enabling Drive does to it: a stub bookmark, with the body in a Drive file.
    const toDrive = (note, folder) => saveNote(note, folder, undefined, async (n) => n, async (content) => ({
      stub: { id: content.id, title: content.title, version: content.version, hash: content.hash, _driveBody: 'FILE', preview: '' },
      fileId: 'FILE',
    }));
    expect(await app.reconcileLocalToDrive(toDrive)).toBe(1);
    type('textarea.note-body', 'now short'); // fits a bookmark again
    document.querySelector('#editor button.save').click();
    await waitFor(async () => (await app.loadNotes(root)).some((n) => n.body === 'now short'));
    expect((await app.loadNotes(root)).filter((n) => n.id === big.id)).toHaveLength(1);
  });
});

describe('fixes from the second real-Chrome round', () => {
  const card = (title) => [...document.querySelectorAll('#note-list .card')].find((c) => c.textContent.includes(title));
  const editorTitle = () => document.querySelector('#editor .note-title')?.value;
  const body = () => document.querySelector('#editor textarea.note-body');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const press = async (target, { holdMs = 30 } = {}) => {
    // A real click: the press moves focus out of the note (a blur-save starts), and the
    // button comes up a moment later.
    target.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    body().dispatchEvent(new Event('blur'));
    await sleep(holdMs);
    target.dispatchEvent(new Event('pointerup', { bubbles: true }));
    target.click();
  };

  async function bootWith(notes) {
    const app = await import('../src/app/app.js');
    const bm = await import('../src/lib/bookmarks.js');
    const { encode } = await import('../src/lib/codec.js');
    const root = await bm.ensureRoot();
    for (const n of notes) await bm.createNote(root, n.title, await encode(n));
    await app.initUI(root);
    await waitFor(() => editorTitle() === notes[notes.length - 1].title);
    return { app, bm, encode, root };
  }

  it('pressing Save right after typing still confirms the save', async () => {
    await bootWith([{ id: 'g1', title: 'Groceries', body: 'milk', created: 2000 }]);
    type('textarea.note-body', 'milk and eggs');
    await press(document.querySelector('#editor button.save'));
    await waitFor(() => document.getElementById('toast').textContent === 'Saved');
    await waitFor(() => document.querySelector('#editor .save-status').textContent === 'Saved ✓');
  });

  it('reopening the open note while its save runs keeps what was typed during that save', async () => {
    const { app, root } = await bootWith([{ id: 'g1', title: 'Groceries', body: 'milk', created: 2000 }]);
    const update = chrome.bookmarks.update;
    chrome.bookmarks.update = async (...args) => { await sleep(300); return update(...args); }; // a slow save, as to Drive
    try {
      type('textarea.note-body', 'milk eggs').dispatchEvent(new Event('blur'));
      await sleep(50);
      const before = type('textarea.note-body', 'milk eggs bread'); // typed while that save runs
      await press(card('Groceries'));
      await waitFor(async () => (await app.loadNotes(root)).some((n) => n.body === 'milk eggs bread'));
      await waitFor(() => body() !== before && editorTitle() === 'Groceries');
      expect(body().value).toBe('milk eggs bread');
    } finally {
      chrome.bookmarks.update = update;
    }
  });

  it('does not say the open note changed on another device when a different note changed', async () => {
    const { app, bm, encode, root } = await bootWith([
      { id: 'b1', title: 'Books', body: 'dune', created: 1000 },
      { id: 'g1', title: 'Groceries', body: 'milk', created: 2000 },
    ]);
    type('textarea.note-body', 'milk and'); // unsaved
    const books = (await app.loadNotes(root)).find((n) => n.id === 'b1');
    await bm.updateNote(books.bookmarkId, 'Books', await encode({ id: 'b1', title: 'Books', body: 'dune 2', created: 1000 }));
    await sleep(100);
    expect(document.querySelector('#editor .remote-change-bar').hidden).toBe(true);
    expect(body().value).toBe('milk and');
  });

  it('Reload on the changed-elsewhere bar keeps the other version, not the local text', async () => {
    const { app, bm, encode, root } = await bootWith([{ id: 'g1', title: 'Groceries', body: 'milk', created: 2000, version: 1 }]);
    type('textarea.note-body', 'milk mine'); // unsaved
    const groceries = (await app.loadNotes(root)).find((n) => n.id === 'g1');
    await bm.updateNote(groceries.bookmarkId, 'Groceries', await encode({ id: 'g1', title: 'Groceries', body: 'milk theirs', created: 2000, version: 5 }));
    const bar = document.querySelector('#editor .remote-change-bar');
    await waitFor(() => !bar.hidden);
    const reload = bar.querySelector('.remote-reload');
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    reload.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true); // focus stays in the note: no blur-save of 'milk mine'
    reload.click();
    await waitFor(() => body().value === 'milk theirs');
    await sleep(100);
    expect((await app.loadNotes(root)).find((n) => n.id === 'g1').body).toBe('milk theirs');
  });

  it('opens a Drive-backed note it cannot fetch as read-only, so its preview is never saved over it', async () => {
    await bootWith([{ id: 'big1', title: 'Big', _driveBody: 'FID', preview: 'short preview', version: 2, hash: 'hh', created: 3000 }]);
    expect(body().value).toBe('short preview');
    expect(body().readOnly).toBe(true);
    expect(document.querySelector('#editor').textContent).toContain('Only the start of this note could be loaded from Google Drive');
  });

  it('a note opened after one that could not be fetched is editable', async () => {
    await bootWith([{ id: 'big1', title: 'Big', _driveBody: 'FID', preview: 'short preview', version: 2, hash: 'hh', created: 3000 }]);
    document.querySelector('button.new').click();
    expect(body().readOnly).toBe(false);
  });
});

describe('fixes from the third real-Chrome round', () => {
  const card = (title) => [...document.querySelectorAll('#note-list .card')].find((c) => c.textContent.includes(title));
  const row = (name) => [...document.querySelectorAll('#sidebar .item')].find((r) => r.textContent.includes(name));
  const editorTitle = () => document.querySelector('#editor .note-title')?.value;
  const body = () => document.querySelector('#editor textarea.note-body');
  const bar = () => document.querySelector('#editor .remote-change-bar');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const slowDown = (obj, name, ms) => {
    const original = obj[name];
    obj[name] = async (...args) => { await sleep(ms); return original.apply(obj, args); };
    return () => { obj[name] = original; };
  };

  async function boot(notes, { setup } = {}) {
    const app = await import('../src/app/app.js');
    const bm = await import('../src/lib/bookmarks.js');
    const mirror = await import('../src/lib/mirror.js');
    const { encode } = await import('../src/lib/codec.js');
    const root = await bm.ensureRoot();
    const ids = {};
    for (const n of notes) ids[n.id] = await bm.createNote(n.folder ?? root, n.title, await encode(n.payload ?? n));
    if (setup) await setup({ bm, mirror, encode, root, ids });
    await app.initUI(root);
    await waitFor(() => editorTitle() === notes[notes.length - 1].title);
    return { app, bm, mirror, encode, root, ids };
  }

  it('keeps a fully loaded Drive-backed note editable when a background check cannot reach Drive', async () => {
    const full = { id: 'd1', title: 'Big', body: 'the whole body', version: 2, hash: 'H1', created: 3000 };
    const stub = { id: 'd1', title: 'Big', _driveBody: 'FID', preview: 'the whole', version: 2, hash: 'H1', created: 3000 };
    const { app, bm, mirror, encode, ids } = await boot([{ ...stub, payload: stub }], {
      setup: ({ mirror: m }) => m.saveBackup(full, { localOnly: false }), // this device has the body
    });
    expect(body().value).toBe('the whole body');
    await mirror.removeBackup('d1');
    await bm.updateNote(ids.d1, 'Big', await encode(stub)); // any bookmark event: a check that fails on Drive
    await sleep(100);
    await app.togglePhonetics(); // the same note is drawn again
    expect(body().readOnly).toBe(false);
    expect(body().value).toBe('the whole body');
  });

  it('shows the bar instead of loading another device\'s version while a drawing is open', async () => {
    const { bm, encode, ids } = await boot([{ id: 'g1', title: 'Groceries', body: 'milk', created: 2000, version: 1 }]);
    document.querySelector('#editor .insert-drawing').click();
    expect(document.querySelector('.draw-backdrop')).toBeTruthy();
    try {
      await bm.updateNote(ids.g1, 'Groceries', await encode({ id: 'g1', title: 'Groceries', body: 'milk theirs', created: 2000, version: 5 }));
      await waitFor(() => !bar().hidden);
      expect(body().value).toBe('milk'); // the drawing still has a note to land in
    } finally {
      document.querySelector('.draw-backdrop')?.remove();
    }
  });

  it('reopens a note in the notebook it was dragged to while its save ran', async () => {
    let restore;
    const { bm, root } = await boot([
      { id: 'b1', title: 'Books', body: 'dune', created: 1000 },
      { id: 'p1', title: 'Plan', body: 'start', created: 2000 },
    ], { setup: ({ bm: b, root: r }) => b.createNotebook(r, 'Work') });
    try {
      restore = slowDown(chrome.bookmarks, 'update', 300); // a slow save, as to Drive
      type('textarea.note-body', 'start more').dispatchEvent(new Event('blur'));
      card('Books').click();
      await waitFor(() => editorTitle() === 'Books');
      const plan = (await bm.allNotes(root)).find((n) => n.title === 'Plan');
      const drop = new Event('drop', { bubbles: true, cancelable: true });
      drop.dataTransfer = { getData: (kind) => (kind === 'text/plain' ? plan.bookmarkId : '') };
      row('Work').dispatchEvent(drop);
      await waitFor(() => /Note moved/.test(document.getElementById('toast').textContent));
      card('Plan').click();
      await waitFor(() => editorTitle() === 'Plan');
      expect(body().value).toBe('start more');
      expect(document.querySelector('#editor .editor-breadcrumb').textContent).toContain('Work');
    } finally {
      restore?.();
    }
  });

  it('notices another device\'s edit that lands while its own save is finishing', async () => {
    const { bm, encode, ids } = await boot([{ id: 'p1', title: 'Plan', body: 'v0', created: 2000, version: 1 }]);
    const restore = slowDown(chrome.storage.local, 'set', 150); // the save's tail after its bookmark write
    try {
      type('textarea.note-body', 'v1 desk');
      document.querySelector('#editor button.save').click();
      const { decode } = await import('../src/lib/codec.js');
      await waitFor(async () => (await decode(await bm.payloadAt(ids.p1))).body === 'v1 desk'); // its bookmark write is done
      await bm.updateNote(ids.p1, 'Plan', await encode({ id: 'p1', title: 'Plan', body: 'v1 laptop', created: 2000, version: 9 }));
    } finally {
      restore();
    }
    await waitFor(() => body().value === 'v1 laptop', 4000); // loaded, as the editor holds nothing unsaved
  });

  it('Reload keeps the other version even when a save of the local text was already running', async () => {
    const { app, bm, encode, root, ids } = await boot([{ id: 'g1', title: 'Groceries', body: 'milk', created: 2000, version: 1 }]);
    type('textarea.note-body', 'milk mine');
    await bm.updateNote(ids.g1, 'Groceries', await encode({ id: 'g1', title: 'Groceries', body: 'milk theirs', created: 2000, version: 5 }));
    await waitFor(() => !bar().hidden);
    const restore = slowDown(chrome.bookmarks, 'update', 300);
    try {
      body().dispatchEvent(new Event('blur')); // the local text starts saving
      bar().querySelector('.remote-reload').click(); // …and the reader picks the other version
      expect(body().value).toBe('milk theirs');
      // The local save lands, then the chosen version is stored again over it.
      await waitFor(() => document.getElementById('toast').textContent === 'Saved', 5000);
      await sleep(100);
      expect((await app.loadNotes(root)).find((n) => n.id === 'g1').body).toBe('milk theirs');
      expect(body().value).toBe('milk theirs');
    } finally {
      restore();
    }
  });

  it('turning Drive on while the open device-local note is being saved makes one note, not two', async () => {
    const app = await import('../src/app/app.js');
    const bm = await import('../src/lib/bookmarks.js');
    const { createNote } = await import('../src/lib/note.js');
    const { saveNote } = await import('../src/lib/save-note.js');
    const root = await bm.ensureRoot();
    const big = { ...createNote({ title: 'Log', body: bigBody() }), created: 5000 };
    await app.saveNote(big, root);
    await app.initUI(root);
    await waitFor(() => editorTitle() === 'Log');
    const toDrive = async (note, folder) => {
      await sleep(200); // a slow upload
      return saveNote(note, folder, undefined, async (n) => n, async (content) => ({
        stub: { id: content.id, title: content.title, version: content.version, hash: content.hash, _driveBody: 'FILE', preview: '' },
        fileId: 'FILE',
      }));
    };
    const promoting = app.reconcileLocalToDrive(toDrive);
    await sleep(20);
    type('textarea.note-body', 'now short'); // saved while the upload runs
    document.querySelector('#editor button.save').click();
    expect(await promoting).toBe(1);
    await waitFor(async () => (await app.loadNotes(root)).some((n) => n.body === 'now short'));
    expect((await app.loadNotes(root)).filter((n) => n.id === big.id)).toHaveLength(1);
    expect((await bm.allNotes(root)).filter((r) => r.title === 'Log' || r.title === 'now short')).toHaveLength(1);
  });
});

describe('fixes from the final real-Chrome round', () => {
  const card = (title) => [...document.querySelectorAll('#note-list .card')].find((c) => c.textContent.includes(title));
  const editorTitle = () => document.querySelector('#editor .note-title')?.value;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const slowDown = (obj, name, ms) => {
    const original = obj[name];
    obj[name] = async (...args) => { await sleep(ms); return original.apply(obj, args); };
    return () => { obj[name] = original; };
  };

  it('Delete pressed while the note\'s own card reopens it still deletes it', async () => {
    const app = await import('../src/app/app.js');
    const bm = await import('../src/lib/bookmarks.js');
    const { encode } = await import('../src/lib/codec.js');
    const root = await bm.ensureRoot();
    await bm.createNote(root, 'Plan', await encode({ id: 'p1', title: 'Plan', body: 'start', created: 2000 }));
    await app.initUI(root);
    await waitFor(() => editorTitle() === 'Plan');
    const restore = slowDown(chrome.bookmarks, 'update', 300); // a slow save
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      type('textarea.note-body', 'start more').dispatchEvent(new Event('blur'));
      card('Plan').click(); // reopen: waits for that save
      document.querySelector('#editor .delete').click(); // …and Delete while it waits
      await waitFor(() => document.getElementById('toast').textContent === 'Moved to Trash', 5000);
      expect(confirm).toHaveBeenCalledWith('Move this note to Trash?');
    } finally {
      confirm.mockRestore();
      restore();
    }
    await sleep(100);
    expect((await app.loadNotes(root)).map((n) => n.id)).not.toContain('p1');
  });

  // A device-local note being given a bookmark by "Drive on" (reconcileLocalToDrive).
  async function promotingBig({ uploadMs = 300 } = {}) {
    const app = await import('../src/app/app.js');
    const bm = await import('../src/lib/bookmarks.js');
    const mirror = await import('../src/lib/mirror.js');
    const { createNote } = await import('../src/lib/note.js');
    const { saveNote } = await import('../src/lib/save-note.js');
    const { encode } = await import('../src/lib/codec.js');
    const root = await bm.ensureRoot();
    await bm.createNote(root, 'Books', await encode({ id: 'b1', title: 'Books', body: 'dune', created: 1000 }));
    const big = { ...createNote({ title: 'Log', body: bigBody() }), created: 5000 };
    await app.saveNote(big, root);
    await app.initUI(root);
    await waitFor(() => editorTitle() === 'Log');
    const toDrive = async (note, folder) => {
      await sleep(uploadMs); // a slow upload
      return saveNote(note, folder, undefined, async (n) => n, async (content) => ({
        stub: { id: content.id, title: content.title, version: content.version, hash: content.hash, _driveBody: 'FILE', preview: '' },
        fileId: 'FILE',
      }));
    };
    const bookmarksFor = async (id) => {
      const { decode } = await import('../src/lib/codec.js');
      const rows = await bm.allNotes(root);
      const decoded = await Promise.all(rows.map(async (r) => decode(r.payload).catch(() => null)));
      return decoded.filter((n) => n && n.id === id).length;
    };
    return { app, bm, mirror, root, big, toDrive, bookmarksFor };
  }

  it('switching to another note while the open one is being given a bookmark makes one note', async () => {
    const { app, big, toDrive, bookmarksFor } = await promotingBig();
    const promoting = app.reconcileLocalToDrive(toDrive);
    await sleep(20);
    type('textarea.note-body', 'now short').dispatchEvent(new Event('blur')); // saved behind the upload
    card('Books').click();
    expect(await promoting).toBe(1);
    await waitFor(async () => (await app.loadNotes(await (await import('../src/lib/bookmarks.js')).ensureRoot())).some((n) => n.body === 'now short'));
    expect(await bookmarksFor(big.id)).toBe(1);
  });

  it('a device-local note opened while it is being given a bookmark is not given a second one', async () => {
    const { app, big, toDrive, bookmarksFor, root } = await promotingBig();
    card('Books').click();
    await waitFor(() => editorTitle() === 'Books');
    const promoting = app.reconcileLocalToDrive(toDrive);
    await sleep(20);
    card('Log').click(); // opens once its promotion has landed
    await waitFor(() => editorTitle() === 'Log', 5000);
    type('textarea.note-body', 'now short');
    document.querySelector('#editor button.save').click();
    expect(await promoting).toBe(1);
    await waitFor(async () => (await app.loadNotes(root)).some((n) => n.body === 'now short'));
    expect(await bookmarksFor(big.id)).toBe(1);
  });

  it('deleting the open device-local note while it is being given a bookmark leaves it in Trash', async () => {
    const { app, big, toDrive, root } = await promotingBig();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      const promoting = app.reconcileLocalToDrive(toDrive);
      await sleep(20);
      document.querySelector('#editor .delete').click();
      await promoting;
      await waitFor(() => document.getElementById('toast').textContent === 'Moved to Trash', 5000);
    } finally {
      confirm.mockRestore();
    }
    await sleep(100);
    expect((await app.loadNotes(root)).map((n) => n.id)).not.toContain(big.id);
  });

  it('keeps text typed during that upload on this device straight away', async () => {
    const { app, toDrive } = await promotingBig({ uploadMs: 600 });
    // What reaches storage (the fake hands back the stored object itself, so reading it
    // back would also show text that only the editor holds).
    const writes = [];
    const set = chrome.storage.local.set;
    chrome.storage.local.set = async (items) => { writes.push(JSON.stringify(items)); return set.call(chrome.storage.local, items); };
    try {
      const promoting = app.reconcileLocalToDrive(toDrive);
      await sleep(20);
      type('textarea.note-body', 'typed during the upload');
      document.querySelector('#editor button.save').click();
      await sleep(100); // the upload is still running
      expect(writes.some((w) => w.includes('typed during the upload'))).toBe(true);
      await promoting;
    } finally {
      chrome.storage.local.set = set;
    }
  });

  it('a list refresh already loading when a press starts waits for the click before redrawing', async () => {
    const app = await import('../src/app/app.js');
    const bm = await import('../src/lib/bookmarks.js');
    const { encode } = await import('../src/lib/codec.js');
    const root = await bm.ensureRoot();
    await bm.createNote(root, 'Books', await encode({ id: 'b1', title: 'Books', body: 'dune', created: 1000 }));
    await bm.createNote(root, 'Groceries', await encode({ id: 'g1', title: 'Groceries', body: 'milk', created: 2000 }));
    await app.initUI(root);
    await waitFor(() => editorTitle() === 'Groceries');
    const restore = slowDown(chrome.bookmarks, 'getChildren', 40); // loading the list is slow
    try {
      type('textarea.note-body', 'milk eggs').dispatchEvent(new Event('blur')); // its save refreshes the list
      await sleep(10);
      const target = card('Books');
      target.dispatchEvent(new Event('pointerdown', { bubbles: true })); // pressed while it loads
      await sleep(400);
      expect(target.isConnected).toBe(true);
      target.dispatchEvent(new Event('pointerup', { bubbles: true }));
      target.click();
      await waitFor(() => editorTitle() === 'Books');
    } finally {
      restore();
    }
  });
});

describe('fixes from the focused real-Chrome round', () => {
  const card = (title) => [...document.querySelectorAll('#note-list .card')].find((c) => c.textContent.includes(title));
  const editorTitle = () => document.querySelector('#editor .note-title')?.value;
  const body = () => document.querySelector('#editor textarea.note-body');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const slowDown = (obj, name, ms) => {
    const original = obj[name];
    obj[name] = async (...args) => { await sleep(ms); return original.apply(obj, args); };
    return () => { obj[name] = original; };
  };
  async function boot(notes) {
    const app = await import('../src/app/app.js');
    const bm = await import('../src/lib/bookmarks.js');
    const { encode } = await import('../src/lib/codec.js');
    const root = await bm.ensureRoot();
    const ids = {};
    for (const n of notes) ids[n.id] = await bm.createNote(root, n.title, await encode(n));
    await app.initUI(root);
    await waitFor(() => editorTitle() === notes[notes.length - 1].title);
    return { app, bm, encode, root, ids };
  }

  it('a press that starts as the last one ends still holds back a waiting list refresh', async () => {
    await boot([
      { id: 'b1', title: 'Books', body: 'dune', created: 1000 },
      { id: 'g1', title: 'Groceries', body: 'milk', created: 2000 },
    ]);
    const restore = slowDown(chrome.bookmarks, 'getChildren', 40); // loading the list is slow
    try {
      type('textarea.note-body', 'milk eggs').dispatchEvent(new Event('blur')); // its save refreshes the list
      await sleep(10);
      const target = card('Books');
      target.dispatchEvent(new Event('pointerdown', { bubbles: true })); // pressed while it loads
      await sleep(400); // loaded: the refresh now waits for this press before redrawing
      target.dispatchEvent(new Event('pointerup', { bubbles: true }));
      target.dispatchEvent(new Event('pointerdown', { bubbles: true })); // the next press, before it resumes
      await sleep(100);
      expect(target.isConnected).toBe(true); // not redrawn under the new press
      target.dispatchEvent(new Event('pointerup', { bubbles: true }));
      target.click();
      await waitFor(() => editorTitle() === 'Books');
    } finally {
      restore();
    }
  });

  it('opens a note that left device-local storage since the list was drawn as the bookmark it now is', async () => {
    const app = await import('../src/app/app.js');
    const bm = await import('../src/lib/bookmarks.js');
    const { createNote } = await import('../src/lib/note.js');
    const { encode } = await import('../src/lib/codec.js');
    const root = await bm.ensureRoot();
    await bm.createNote(root, 'Books', await encode({ id: 'b1', title: 'Books', body: 'dune', created: 1000 }));
    const big = { ...createNote({ title: 'Log', body: bigBody() }), created: 500 };
    await app.saveNote(big, root);
    await app.initUI(root);
    await waitFor(() => editorTitle() === 'Log'); // the most recently updated note
    card('Books').click();
    await waitFor(() => editorTitle() === 'Books');
    const stale = card('Log'); // drawn while Log was device-local
    // Meanwhile it is cut short and given a bookmark (another tab, say), unseen by this list.
    await app.saveNote({ ...big, body: 'short now', version: big.version + 1 }, root);
    stale.click();
    await waitFor(() => editorTitle() === 'Log' && body().value === 'short now');
    type('textarea.note-body', 'short now, edited');
    document.querySelector('#editor button.save').click();
    await waitFor(async () => (await app.loadNotes(root)).some((n) => n.body === 'short now, edited'));
    const { decode } = await import('../src/lib/codec.js');
    const rows = await bm.allNotes(root);
    const copies = (await Promise.all(rows.map((r) => decode(r.payload)))).filter((n) => n.id === big.id);
    expect(copies).toHaveLength(1); // no second bookmark
  });

  it('does not write a local copy of a bookmarked note while its save waits its turn', async () => {
    const { app } = await boot([{ id: 'g1', title: 'Groceries', body: 'milk', created: 2000 }]);
    const writes = [];
    const set = chrome.storage.local.set;
    chrome.storage.local.set = async (items) => { writes.push(JSON.stringify(items)); return set.call(chrome.storage.local, items); };
    const restore = slowDown(chrome.bookmarks, 'update', 300);
    try {
      type('textarea.note-body', 'milk eggs').dispatchEvent(new Event('blur')); // a slow save
      await sleep(20);
      await app.togglePhonetics(); // the same note drawn again: a second editor on its session
      type('textarea.note-body', 'milk eggs queued');
      document.querySelector('#editor button.save').click(); // queued behind the first editor's save
      await sleep(50);
      expect(writes.some((w) => w.includes('milk eggs queued'))).toBe(false);
      // Let both saves land before the next test replaces the browser under them.
      await waitFor(() => document.querySelector('#editor .save-status').textContent === 'Saved ✓', 5000);
    } finally {
      restore();
      chrome.storage.local.set = set;
    }
  });

  it('Reload stores the chosen version even when the reader opens another note before the slow save lands', async () => {
    const { app, bm, encode, root, ids } = await boot([
      { id: 'b1', title: 'Books', body: 'dune', created: 1000 },
      { id: 'g1', title: 'Groceries', body: 'milk', created: 2000, version: 1 },
    ]);
    type('textarea.note-body', 'milk mine');
    await bm.updateNote(ids.g1, 'Groceries', await encode({ id: 'g1', title: 'Groceries', body: 'milk theirs', created: 2000, version: 5 }));
    const bar = () => document.querySelector('#editor .remote-change-bar');
    await waitFor(() => !bar().hidden);
    const restore = slowDown(chrome.bookmarks, 'update', 300);
    try {
      body().dispatchEvent(new Event('blur')); // the local text starts saving
      bar().querySelector('.remote-reload').click(); // the reader picks the other version…
      card('Books').click(); // …and moves on before that save lands
      await waitFor(() => editorTitle() === 'Books', 5000);
      await waitFor(async () => (await app.loadNotes(root)).find((n) => n.id === 'g1')?.body === 'milk theirs', 5000);
      await sleep(800);
      expect((await app.loadNotes(root)).find((n) => n.id === 'g1').body).toBe('milk theirs');
    } finally {
      restore();
    }
  });
});
