import { describe, it, expect, beforeEach } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';

beforeEach(async () => {
  installFakeChrome();
  document.body.innerHTML =
    '<div id="toolbar"></div><aside id="sidebar"></aside><section id="note-list"></section><main id="editor"></main><div id="toast" hidden></div>';
  const app = await import('../src/app/app.js');
  app.resetUI();
});

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
    await new Promise((r) => setTimeout(r, 10));
    const notes = await bm.allNotes(root);
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe('Hello list');
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
