import { describe, it, expect, beforeEach } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';

beforeEach(async () => {
  installFakeChrome();
  document.body.innerHTML =
    '<div id="toolbar"></div><aside id="sidebar"></aside><section id="note-list"></section><main id="editor"></main><div id="toast" hidden></div>';
  const app = await import('../src/app/app.js');
  app.resetUI();
});

async function waitFor(fn, ms = 1500) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('waitFor: condition not met in time');
}

describe('app integration', () => {
  it('creates a notebook implicitly under root, saves a note, and lists it', async () => {
    const app = await import('../src/app/app.js');
    const bm = await import('../src/lib/bookmarks.js');
    const root = await bm.ensureRoot();
    await app.initUI(root);
    // simulate: new note -> set title -> type body -> save
    document.querySelector('button.new').click();
    const titleInput = document.querySelector('#editor .note-title');
    titleInput.value = 'Hello list';
    titleInput.dispatchEvent(new Event('input'));
    const ta = document.querySelector('#editor textarea.note-body');
    ta.value = 'body text';
    ta.dispatchEvent(new Event('input'));
    document.querySelector('#editor button.save').click();
    await waitFor(async () => (await bm.allNotes(root)).length >= 1); // wait for the save to actually land, not a fixed delay
    const notes = await bm.allNotes(root);
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe('Hello list');
  });

  it('lists notes newest-first across reloads (older notes ordered by bookmark dateAdded)', async () => {
    const app = await import('../src/app/app.js');
    const bm = await import('../src/lib/bookmarks.js');
    const { encode } = await import('../src/lib/codec.js');
    const root = await bm.ensureRoot();
    // Prior-session notes (no `created` field) created in chronological order.
    for (const t of ['First', 'Second', 'Third']) {
      await bm.createNote(root, t, await encode({ id: t, title: t, body: t, version: 1, hash: 'h' }));
    }
    await app.initUI(root); // recentIds is empty -> pure persistent order, newest first
    const titles = [...document.querySelectorAll('#note-list .item.card .card-title')].map((e) => e.textContent.trim());
    expect(titles).toEqual(['Third', 'Second', 'First']);
  });

  it("shows the open note's notebook path in the editor breadcrumb", async () => {
    const app = await import('../src/app/app.js');
    const bm = await import('../src/lib/bookmarks.js');
    const { encode } = await import('../src/lib/codec.js');
    const root = await bm.ensureRoot();
    const work = await bm.createNotebook(root, 'Work');
    await bm.createNote(work, 'Spec', await encode({ id: 'n1', title: 'Spec', body: 'x', version: 1, hash: 'h' }));
    await app.initUI(root); // root view lists every note, incl. the one inside Work
    const card = [...document.querySelectorAll('#note-list .item.card')].find((c) => c.textContent.includes('Spec'));
    card.click();
    await new Promise((r) => setTimeout(r, 0)); // let openBookmark settle
    const crumbs = [...document.querySelectorAll('#editor .editor-breadcrumb .crumb')].map((c) => c.textContent);
    expect(crumbs).toEqual(['📓 Notes', 'Work']);
  });

  it('creates a sub-notebook under the selected notebook', async () => {
    const app = await import('../src/app/app.js');
    const bm = await import('../src/lib/bookmarks.js');
    window.prompt = () => 'Child';
    const root = await bm.ensureRoot();
    const parent = await bm.createNotebook(root, 'Parent');
    await app.initUI(root);
    [...document.querySelectorAll('#sidebar .item.folder')]
      .find((x) => x.querySelector('.nb-label')?.textContent === 'Parent').click();
    await new Promise((r) => setTimeout(r, 10));
    document.querySelector('#sidebar button.new-notebook').click();
    await new Promise((r) => setTimeout(r, 15));
    const child = (await bm.listNotebooks(root)).find((n) => n.title === 'Child');
    expect(child).toBeTruthy();
    expect(child.parentId).toBe(parent); // nested under the selected notebook, not root
  });

  it('resolves the breadcrumb path for a note opened via its bookmark URL (hash)', async () => {
    const app = await import('../src/app/app.js');
    const bm = await import('../src/lib/bookmarks.js');
    const { encode } = await import('../src/lib/codec.js');
    const root = await bm.ensureRoot();
    const work = await bm.createNotebook(root, 'Work');
    const payload = await encode({ id: 'h1', title: 'Deep', body: 'x', version: 1, hash: 'h' });
    await bm.createNote(work, 'Deep', payload);
    location.hash = '#' + payload; // simulate clicking the note's bookmark (fresh boot)
    await app.initUI(root);
    location.hash = ''; // reset so it doesn't leak into other tests
    const crumbs = [...document.querySelectorAll('#editor .editor-breadcrumb .crumb')].map((c) => c.textContent);
    expect(crumbs).toEqual(['📓 Notes', 'Work']); // full path, not just the root
  });

  it('reveals a new sub-notebook even when an ancestor was collapsed', async () => {
    const app = await import('../src/app/app.js');
    const bm = await import('../src/lib/bookmarks.js');
    window.prompt = () => 'Leaf';
    const root = await bm.ensureRoot();
    const g = await bm.createNotebook(root, 'Grand');
    await bm.createNotebook(g, 'Child');
    await app.initUI(root);
    const row = (name) => [...document.querySelectorAll('#sidebar .item.folder')].find((x) => x.querySelector('.nb-label')?.textContent === name);
    row('Child').click(); // select Child
    await new Promise((r) => setTimeout(r, 10));
    row('Grand').querySelector('.nb-toggle').click(); // collapse Grand -> Child hidden
    await new Promise((r) => setTimeout(r, 10));
    expect(row('Child')).toBeUndefined();
    document.querySelector('#sidebar button.new-notebook').click(); // create under still-selected Child
    await new Promise((r) => setTimeout(r, 15));
    expect(row('Leaf')).toBeTruthy(); // visible: ancestors auto-expanded
    expect(row('Child')).toBeTruthy();
  });

  it('updates the open note breadcrumb when its notebook is renamed', async () => {
    const app = await import('../src/app/app.js');
    const bm = await import('../src/lib/bookmarks.js');
    const { encode } = await import('../src/lib/codec.js');
    const root = await bm.ensureRoot();
    await bm.createNotebook(root, 'Work');
    const work = (await bm.listNotebooks(root)).find((n) => n.title === 'Work').id;
    await bm.createNote(work, 'Note', await encode({ id: 'r1', title: 'Note', body: 'x', version: 1, hash: 'h' }));
    await app.initUI(root);
    [...document.querySelectorAll('#note-list .item.card')].find((c) => c.textContent.includes('Note')).click();
    await new Promise((r) => setTimeout(r, 10));
    const crumbs = () => [...document.querySelectorAll('#editor .editor-breadcrumb .crumb')].map((c) => c.textContent);
    expect(crumbs()).toEqual(['📓 Notes', 'Work']);
    window.prompt = () => 'Job';
    [...document.querySelectorAll('#sidebar .item.folder')].find((x) => x.querySelector('.nb-label')?.textContent === 'Work')
      .querySelector('.nb-rename').click();
    await new Promise((r) => setTimeout(r, 15));
    expect(crumbs()).toEqual(['📓 Notes', 'Job']); // breadcrumb refreshed in place
  });

  it('shows a note created outside the app (Save-selection context menu) without a manual refresh', async () => {
    const app = await import('../src/app/app.js');
    const bm = await import('../src/lib/bookmarks.js');
    const { createNote } = await import('../src/lib/note.js');
    const { encode } = await import('../src/lib/codec.js');
    const root = await bm.ensureRoot();
    await app.initUI(root);
    expect(document.querySelectorAll('#note-list .item.card').length).toBe(0);
    // The service worker's context-menu handler creates a note bookmark in root while
    // the app tab is open; the fake fires chrome.bookmarks.onCreated like a real browser.
    const ext = createNote({ title: 'From context menu', body: 'selected text' });
    await bm.createNote(root, ext.title, await encode(ext));
    await new Promise((r) => setTimeout(r, 10)); // let the live refresh re-render
    const titles = [...document.querySelectorAll('#note-list .item.card')].map((el) => el.textContent);
    expect(titles.some((t) => t.includes('From context menu'))).toBe(true);
  });

  it('shows a "New note" draft entry, active, when starting a new note', async () => {
    const app = await import('../src/app/app.js');
    const bm = await import('../src/lib/bookmarks.js');
    const root = await bm.ensureRoot();
    await app.initUI(root);
    document.querySelector('button.new').click();
    await new Promise((r) => setTimeout(r, 15));
    const active = document.querySelector('#note-list .item.active');
    expect(active).not.toBeNull();
    expect(active.classList.contains('draft')).toBe(true);
    expect(active.textContent).toContain('New note');
  });

  it('removes the New note draft from the list once the note is saved', async () => {
    const app = await import('../src/app/app.js');
    const bm = await import('../src/lib/bookmarks.js');
    const root = await bm.ensureRoot();
    await app.initUI(root);
    document.querySelector('button.new').click();
    await new Promise((r) => setTimeout(r, 10));
    expect(document.querySelector('#note-list .item.draft')).not.toBeNull();
    const titleInput = document.querySelector('#editor .note-title');
    titleInput.value = 'Saved One';
    titleInput.dispatchEvent(new Event('input'));
    document.querySelector('#editor button.save').click();
    await new Promise((r) => setTimeout(r, 15));
    expect(document.querySelector('#note-list .item.draft')).toBeNull();
    const items = document.querySelectorAll('#note-list .item');
    expect(items).toHaveLength(1);
    expect(items[0].classList.contains('active')).toBe(true);
    expect(items[0].textContent).toContain('Saved One');
  });

  it('suppresses the draft while searching and restores it when the query clears', async () => {
    const app = await import('../src/app/app.js');
    const bm = await import('../src/lib/bookmarks.js');
    const root = await bm.ensureRoot();
    await app.initUI(root);
    document.querySelector('button.new').click();
    await new Promise((r) => setTimeout(r, 10));
    expect(document.querySelector('#note-list .item.draft')).not.toBeNull();
    const search = document.querySelector('input.search');
    search.value = 'anything';
    search.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 10));
    expect(document.querySelector('#note-list .item.draft')).toBeNull();
    search.value = '';
    search.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 10));
    expect(document.querySelector('#note-list .item.draft')).not.toBeNull();
  });

  it('rehydrates the editor title input when reopening a saved note', async () => {
    const app = await import('../src/app/app.js');
    const bm = await import('../src/lib/bookmarks.js');
    const root = await bm.ensureRoot();
    await app.initUI(root);
    document.querySelector('button.new').click();
    const titleInput = document.querySelector('#editor .note-title');
    titleInput.value = 'Round Trip';
    titleInput.dispatchEvent(new Event('input'));
    const ta = document.querySelector('#editor textarea.note-body');
    ta.value = 'body';
    ta.dispatchEvent(new Event('input'));
    document.querySelector('#editor button.save').click();
    await new Promise((r) => setTimeout(r, 15));
    document.querySelector('#note-list .item.card').click();
    await new Promise((r) => setTimeout(r, 15));
    expect(document.querySelector('#editor .note-title').value).toBe('Round Trip');
  });

  it('moves a note to another notebook when dropped onto it', async () => {
    const app = await import('../src/app/app.js');
    const bm = await import('../src/lib/bookmarks.js');
    const root = await bm.ensureRoot();
    const nb1 = await bm.createNotebook(root, 'NB1');
    const nb2 = await bm.createNotebook(root, 'NB2');
    await app.initUI(root);
    // select NB1, then create + save a note in it
    [...document.querySelectorAll('#sidebar .item.folder')]
      .find((x) => x.querySelector('.nb-label')?.textContent === 'NB1')
      .click();
    await new Promise((r) => setTimeout(r, 10));
    document.querySelector('button.new').click();
    const titleInput = document.querySelector('#editor .note-title');
    titleInput.value = 'Mover';
    titleInput.dispatchEvent(new Event('input'));
    document.querySelector('#editor button.save').click();
    await new Promise((r) => setTimeout(r, 15));
    const bid = (await bm.listNotes(nb1))[0].bookmarkId;
    expect(bid).toBeTruthy();
    // drop it onto NB2
    const nb2Row = [...document.querySelectorAll('#sidebar .item.folder')]
      .find((x) => x.querySelector('.nb-label')?.textContent === 'NB2');
    const ev = new Event('drop', { bubbles: true });
    ev.dataTransfer = { getData: () => bid };
    ev.preventDefault = () => {};
    nb2Row.dispatchEvent(ev);
    await new Promise((r) => setTimeout(r, 15));
    expect(await bm.listNotes(nb1)).toHaveLength(0);
    expect(await bm.listNotes(nb2)).toHaveLength(1);
  });

  it('keeps the same search input element across keystrokes (no focus loss)', async () => {
    const app = await import('../src/app/app.js');
    const bm = await import('../src/lib/bookmarks.js');
    const root = await bm.ensureRoot();
    await app.initUI(root);
    const input = document.querySelector('input.search');
    input.value = 'pa';
    input.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 10));
    // The toolbar must NOT be rebuilt on search, so the same element persists.
    expect(document.querySelector('input.search')).toBe(input);
  });

  it('does not lose in-progress editor text when the note list refreshes', async () => {
    const app = await import('../src/app/app.js');
    const bm = await import('../src/lib/bookmarks.js');
    const root = await bm.ensureRoot();
    await app.initUI(root);
    document.querySelector('button.new').click();
    const ta = document.querySelector('#editor textarea.note-body');
    ta.value = '# Draft\nin progress';
    ta.dispatchEvent(new Event('input'));
    const input = document.querySelector('input.search');
    input.value = 'x';
    input.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 10));
    expect(document.querySelector('#editor textarea.note-body').value).toContain('in progress');
  });

  it('moves the open note to Trash (not permanent) when deleted', async () => {
    const app = await import('../src/app/app.js');
    const bm = await import('../src/lib/bookmarks.js');
    const root = await bm.ensureRoot();
    await app.initUI(root);
    document.querySelector('button.new').click();
    const titleInput = document.querySelector('#editor .note-title');
    titleInput.value = 'Trash me';
    titleInput.dispatchEvent(new Event('input'));
    document.querySelector('#editor button.save').click();
    await new Promise((r) => setTimeout(r, 10));
    // delete -> Trash
    window.confirm = () => true;
    document.querySelector('#editor button.delete').click();
    await new Promise((r) => setTimeout(r, 10));
    // gone from the visible list, present in the Trash folder
    const trashId = (await chrome.storage.local.get('owl:trash-id'))['owl:trash-id'];
    expect((await bm.listNotes(trashId)).length).toBe(1);
    expect((await bm.allNotes(root)).filter((n) => n.folderId !== trashId).length).toBe(0);
  });

  it('excludes trashed notes from the All-notes list', async () => {
    const app = await import('../src/app/app.js');
    const bm = await import('../src/lib/bookmarks.js');
    const { encode } = await import('../src/lib/codec.js');
    const { createNote } = await import('../src/lib/note.js');
    const { trashNotes, ensureTrash } = await import('../src/lib/trash.js');
    const root = await bm.ensureRoot();
    await app.initUI(root);
    const trashId = await ensureTrash(root);
    const note = createNote({ title: 'Hidden', body: 'x' });
    const bid = await bm.createNote(root, note.title, await encode(note));
    await trashNotes([{ id: note.id, bookmarkId: bid, folderId: root }], trashId);
    const visible = await app.loadNotes(root);
    expect(visible.some((n) => n.title === 'Hidden')).toBe(false);
  });

  it('deletes a notebook and its notes (bookmarks + backups)', async () => {
    const app = await import('../src/app/app.js');
    const bm = await import('../src/lib/bookmarks.js');
    const mirror = await import('../src/lib/mirror.js');
    window.confirm = () => true;
    window.prompt = () => 'Recipes';
    const root = await bm.ensureRoot();
    await app.initUI(root);
    document.querySelector('#sidebar button.new-notebook').click();
    await new Promise((r) => setTimeout(r, 15));
    const nb = (await bm.listNotebooks(root)).find((n) => n.title === 'Recipes');
    expect(nb).toBeTruthy();
    expect(nb.title).toBe('Recipes');
    [...document.querySelectorAll('#sidebar .item.folder')]
      .find((x) => x.querySelector('.nb-label')?.textContent === 'Recipes')
      .click();
    await new Promise((r) => setTimeout(r, 15));
    document.querySelector('button.new').click();
    const ta = document.querySelector('#editor textarea.note-body');
    ta.value = '# Pasta\nboil';
    ta.dispatchEvent(new Event('input'));
    document.querySelector('#editor button.save').click();
    await new Promise((r) => setTimeout(r, 15));
    expect(await bm.listNotes(nb.id)).toHaveLength(1);
    const id = (await mirror.allBackups())[0].id;
    document.querySelector('#sidebar .item.folder .nb-delete').click();
    await new Promise((r) => setTimeout(r, 15));
    const trashId = (await chrome.storage.local.get('owl:trash-id'))['owl:trash-id'];
    expect((await bm.listNotebooks(root)).filter((n) => n.id !== trashId)).toHaveLength(0);
    expect(await bm.allNotes(root)).toHaveLength(0);
    expect(await mirror.getBackup(id)).toBeNull();
  });

  it('selects (focuses) a newly created notebook', async () => {
    const app = await import('../src/app/app.js');
    const bm = await import('../src/lib/bookmarks.js');
    window.prompt = () => 'Fresh NB';
    const root = await bm.ensureRoot();
    await app.initUI(root);
    document.querySelector('#sidebar button.new-notebook').click();
    await new Promise((r) => setTimeout(r, 15));
    const active = document.querySelector('#sidebar .item.folder.active');
    expect(active).not.toBeNull();
    expect(active.querySelector('.nb-label').textContent).toBe('Fresh NB');
  });

  it('shows the Trash row with a count, opens the Trash view, restores and empties', async () => {
    const app = await import('../src/app/app.js');
    const bm = await import('../src/lib/bookmarks.js');
    const { encode } = await import('../src/lib/codec.js');
    const { createNote } = await import('../src/lib/note.js');
    const { trashNotes, ensureTrash } = await import('../src/lib/trash.js');
    const root = await bm.ensureRoot();
    await app.initUI(root);
    const trashId = await ensureTrash(root);
    const note = createNote({ title: 'Bin me', body: 'x' });
    const bid = await bm.createNote(root, note.title, await encode(note));
    await trashNotes([{ id: note.id, bookmarkId: bid, folderId: root }], trashId);
    window.confirm = () => true;
    await app.initUI(root); // re-render panes with the trashed note
    const trashRow = document.querySelector('#sidebar .trash-row');
    expect(trashRow).not.toBeNull();
    expect(trashRow.querySelector('.trash-count').textContent).toBe('1');
    trashRow.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(document.querySelector('#note-list .item.trashed')).not.toBeNull();
    document.querySelector('#note-list .restore').click();
    await new Promise((r) => setTimeout(r, 10));
    expect((await bm.listNotes(trashId)).length).toBe(0);
    expect((await bm.listNotes(root)).map((n) => n.bookmarkId)).toContain(bid);
  });

  it('Ctrl-click selects multiple and Delete moves them to Trash', async () => {
    const app = await import('../src/app/app.js');
    const bm = await import('../src/lib/bookmarks.js');
    const { encode } = await import('../src/lib/codec.js');
    const { createNote } = await import('../src/lib/note.js');
    const root = await bm.ensureRoot();
    for (const t of ['One', 'Two', 'Three']) {
      const n = createNote({ title: t, body: t });
      await bm.createNote(root, n.title, await encode(n));
    }
    await app.initUI(root);
    const cards = () => [...document.querySelectorAll('#note-list .item.card')];
    expect(cards().length).toBe(3);
    // Ctrl-click two cards
    cards()[0].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    cards()[2].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    await new Promise((r) => setTimeout(r, 5));
    expect(document.querySelectorAll('#note-list .item.selected').length).toBe(2);
    // Delete key -> batch trash
    window.confirm = () => true;
    document.getElementById('note-list').dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    await new Promise((r) => setTimeout(r, 15));
    expect(document.querySelectorAll('#note-list .item.card').length).toBe(1);
    const trashId = (await chrome.storage.local.get('owl:trash-id'))['owl:trash-id'];
    expect((await bm.listNotes(trashId)).length).toBe(2);
  });

  it('Shift+ArrowDown extends the selection', async () => {
    const app = await import('../src/app/app.js');
    const bm = await import('../src/lib/bookmarks.js');
    const { encode } = await import('../src/lib/codec.js');
    const { createNote } = await import('../src/lib/note.js');
    const root = await bm.ensureRoot();
    for (const t of ['A', 'B', 'C']) {
      const n = createNote({ title: t, body: t });
      await bm.createNote(root, n.title, await encode(n));
    }
    await app.initUI(root);
    const first = document.querySelectorAll('#note-list .item.card')[0];
    first.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })); // anchor + select #0
    const list = document.getElementById('note-list');
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
    expect(document.querySelectorAll('#note-list .item.selected').length).toBe(2);
  });
});
