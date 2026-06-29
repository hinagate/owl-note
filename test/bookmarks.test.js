import { describe, it, expect, beforeEach } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import * as bm from '../src/lib/bookmarks.js';

beforeEach(() => installFakeChrome());

describe('bookmarks wrapper', () => {
  it('builds and parses note URLs', () => {
    const url = bm.buildNoteUrl('PAYLOAD');
    expect(url).toBe('chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/app.html#PAYLOAD');
    expect(bm.isNoteUrl(url)).toBe(true);
    expect(bm.isNoteUrl('https://example.com')).toBe(false);
    expect(bm.payloadFromUrl(url)).toBe('PAYLOAD');
  });

  it('recognizes note URLs from any extension id (a different build)', () => {
    const other = `chrome-extension://${'b'.repeat(32)}/app.html#OTHERPAYLOAD`;
    expect(bm.isNoteUrl(other)).toBe(true);
    expect(bm.payloadFromUrl(other)).toBe('OTHERPAYLOAD');
    // not a valid 32-char a–p id, and a non-app.html path, are rejected
    expect(bm.isNoteUrl('chrome-extension://short/app.html#x')).toBe(false);
    expect(bm.isNoteUrl(`chrome-extension://${'a'.repeat(32)}/other.html#x`)).toBe(false);
  });

  it('healNoteUrls rewrites foreign-id note bookmarks to the current runtime id', async () => {
    const root = await bm.ensureRoot();
    const foreign = `chrome-extension://${'b'.repeat(32)}/app.html#PAYLOAD`;
    await chrome.bookmarks.create({ parentId: root, title: 'Old', url: foreign });
    await bm.createNote(root, 'New', 'P2'); // already current id — must be left alone

    const healed = await bm.healNoteUrls(root);
    expect(healed).toBe(1);

    const notes = await bm.listNotes(root);
    const old = notes.find((n) => n.title === 'Old');
    expect(old.url).toBe(`chrome-extension://${'a'.repeat(32)}/app.html#PAYLOAD`);
    expect(old.payload).toBe('PAYLOAD');
    expect(await bm.healNoteUrls(root)).toBe(0); // idempotent: nothing left to heal
  });

  it('ensureRoot is idempotent', async () => {
    const a = await bm.ensureRoot();
    const b = await bm.ensureRoot();
    expect(a).toBe(b);
    const notebooks = await bm.listNotebooks(a);
    expect(notebooks).toEqual([]);
  });

  it('follows the root folder after the user moves it elsewhere (no duplicate)', async () => {
    const root = await bm.ensureRoot();
    // User drags "📓 Notes" out of Other Bookmarks onto the Bookmarks bar.
    await chrome.bookmarks.move(root, { parentId: '1' });
    const again = await bm.ensureRoot();
    expect(again).toBe(root); // same folder, followed by stable id — not recreated
    // The folder must NOT have been duplicated back into Other Bookmarks.
    const otherKids = await chrome.bookmarks.getChildren('2');
    expect(otherKids.filter((c) => c.title === bm.ROOT_TITLE)).toHaveLength(0);
    // Exactly one lives on the Bookmarks bar now, and it's the original.
    const barKids = await chrome.bookmarks.getChildren('1');
    const onBar = barKids.filter((c) => c.title === bm.ROOT_TITLE);
    expect(onBar).toHaveLength(1);
    expect(onBar[0].id).toBe(root);
  });

  it('re-adopts an existing root folder when persisted id is missing (no duplicate)', async () => {
    // Simulate a folder that exists in the tree but was never recorded in storage
    // (e.g. storage cleared, or a synced profile where ids differ per device).
    const created = await chrome.bookmarks.create({ parentId: '1', title: bm.ROOT_TITLE });
    await chrome.storage.local.clear();
    const root = await bm.ensureRoot();
    expect(root).toBe(created.id); // adopted the existing one
    const otherKids = await chrome.bookmarks.getChildren('2');
    expect(otherKids.filter((c) => c.title === bm.ROOT_TITLE)).toHaveLength(0);
  });

  it('recreates the root folder if the persisted folder was deleted', async () => {
    const root = await bm.ensureRoot();
    await chrome.bookmarks.removeTree(root); // user deletes the whole folder
    const fresh = await bm.ensureRoot();
    expect(fresh).not.toBe(root);
    const [node] = await chrome.bookmarks.get(fresh);
    expect(node.title).toBe(bm.ROOT_TITLE);
  });

  it('ensureRoot resolves Other Bookmarks when its id is not "2" (folderType)', async () => {
    installFakeChrome({ otherBookmarksId: '37' });
    const root = await bm.ensureRoot();
    const [node] = await chrome.bookmarks.get(root);
    expect(node.parentId).toBe('37');
  });

  it('ensureRoot falls back to layout order when folderType is absent', async () => {
    installFakeChrome({ otherBookmarksId: '37', folderType: false });
    const root = await bm.ensureRoot();
    const [node] = await chrome.bookmarks.get(root);
    expect(node.parentId).toBe('37');
  });

  it('creates notebooks and notes and lists them', async () => {
    const root = await bm.ensureRoot();
    const nb = await bm.createNotebook(root, 'Code Base');
    const id = await bm.createNote(nb, 'Snippet', 'PAY1');
    const notes = await bm.listNotes(nb);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ bookmarkId: id, title: 'Snippet', payload: 'PAY1' });
    const all = await bm.allNotes(root);
    expect(all).toHaveLength(1);
    expect(all[0].folderId).toBe(nb);
  });

  it('updates and deletes a note', async () => {
    const root = await bm.ensureRoot();
    const id = await bm.createNote(root, 'A', 'P1');
    await bm.updateNote(id, 'B', 'P2');
    let notes = await bm.listNotes(root);
    expect(notes[0]).toMatchObject({ title: 'B', payload: 'P2' });
    await bm.deleteNote(id);
    notes = await bm.listNotes(root);
    expect(notes).toHaveLength(0);
  });

  it('moves a note between notebooks', async () => {
    const root = await bm.ensureRoot();
    const nb1 = await bm.createNotebook(root, 'NB1');
    const nb2 = await bm.createNotebook(root, 'NB2');
    const id = await bm.createNote(nb1, 'Note', 'PAY');
    await bm.moveNote(id, nb2);
    expect(await bm.listNotes(nb1)).toHaveLength(0);
    const moved = await bm.listNotes(nb2);
    expect(moved).toHaveLength(1);
    expect(moved[0].bookmarkId).toBe(id);
  });
});
