// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import * as bm from '../src/lib/bookmarks.js';
import * as mirror from '../src/lib/mirror.js';
import * as client from '../src/lib/drive/client.js';
import { encode } from '../src/lib/codec.js';
import { createNote } from '../src/lib/note.js';
import { ensureTrash, trashNotes, restoreNotes, deleteForever } from '../src/lib/trash.js';

vi.mock('../src/lib/drive/client.js', () => ({ deleteFile: vi.fn(async () => {}) }));

beforeEach(() => { installFakeChrome(); client.deleteFile.mockClear(); });

describe('trash', () => {
  it('ensureTrash creates one folder and reuses it', async () => {
    const root = await bm.ensureRoot();
    const t1 = await ensureTrash(root);
    const t2 = await ensureTrash(root);
    expect(t1).toBe(t2);
    const [node] = await chrome.bookmarks.get(t1);
    expect(node.url).toBeUndefined();
  });

  it('trashNotes moves a synced note into Trash + remembers origin; restore returns it', async () => {
    const root = await bm.ensureRoot();
    const nb = await bm.createNotebook(root, 'Work');
    const trash = await ensureTrash(root);
    const note = createNote({ body: 'hi' });
    const bid = await bm.createNote(nb, note.title, await encode(note));
    await trashNotes([{ id: note.id, bookmarkId: bid, folderId: nb }], trash);
    expect((await bm.listNotes(trash)).map((n) => n.bookmarkId)).toContain(bid);
    expect((await bm.listNotes(nb)).length).toBe(0);
    await restoreNotes([{ id: note.id, bookmarkId: bid }], root);
    expect((await bm.listNotes(nb)).map((n) => n.bookmarkId)).toContain(bid);
  });

  it('restores to root when the origin notebook was deleted', async () => {
    const root = await bm.ensureRoot();
    const nb = await bm.createNotebook(root, 'Temp');
    const trash = await ensureTrash(root);
    const note = createNote({ body: 'x' });
    const bid = await bm.createNote(nb, note.title, await encode(note));
    await trashNotes([{ id: note.id, bookmarkId: bid, folderId: nb }], trash);
    await bm.deleteFolder(nb);
    await restoreNotes([{ id: note.id, bookmarkId: bid }], root);
    const [node] = await chrome.bookmarks.get(bid);
    expect(node.parentId).toBe(root);
  });

  it('deleteForever removes the bookmark and the backup', async () => {
    const root = await bm.ensureRoot();
    const trash = await ensureTrash(root);
    const note = createNote({ body: 'gone' });
    await mirror.saveBackup(note);
    const bid = await bm.createNote(root, note.title, await encode(note));
    await deleteForever([{ id: note.id, bookmarkId: bid }]);
    expect((await bm.allNotes(root)).map((n) => n.bookmarkId)).not.toContain(bid);
    expect(await mirror.getBackup(note.id)).toBeNull();
    expect(client.deleteFile).not.toHaveBeenCalled(); // plain note has no Drive files
  });

  it('deleteForever deletes the note\'s Drive body and attachment files', async () => {
    const root = await bm.ensureRoot();
    await ensureTrash(root);
    const note = { id: 'n1', title: 'N', body: 'x', _driveBody: 'BODY1', attachments: [{ id: 'a1', driveFileId: 'FILE1' }] };
    const bid = await bm.createNote(root, note.title, await encode(note));
    await deleteForever([{ id: note.id, bookmarkId: bid }]);
    expect(client.deleteFile).toHaveBeenCalledWith('BODY1');
    expect(client.deleteFile).toHaveBeenCalledWith('FILE1');
    expect(client.deleteFile).toHaveBeenCalledTimes(2);
  });

  it('deleteForever keeps a file still referenced by a surviving note (shared image)', async () => {
    const root = await bm.ensureRoot();
    await ensureTrash(root);
    const del = { id: 'del', title: 'Del', body: 'x', attachments: [{ id: 'img', driveFileId: 'SHARED' }] };
    const keep = { id: 'keep', title: 'Keep', body: 'y', attachments: [{ id: 'img', driveFileId: 'SHARED' }] };
    const delBid = await bm.createNote(root, del.title, await encode(del));
    await bm.createNote(root, keep.title, await encode(keep));
    await deleteForever([{ id: del.id, bookmarkId: delBid }]);
    expect(client.deleteFile).not.toHaveBeenCalled(); // SHARED is still used by 'keep'
  });

  it('deleteForever deletes files unique to the removed note but keeps shared ones', async () => {
    const root = await bm.ensureRoot();
    await ensureTrash(root);
    const del = { id: 'del', title: 'D', body: 'x', attachments: [{ id: 'u', driveFileId: 'UNIQUE' }, { id: 's', driveFileId: 'SHARED' }] };
    const keep = { id: 'keep', title: 'K', body: 'y', attachments: [{ id: 's', driveFileId: 'SHARED' }] };
    const delBid = await bm.createNote(root, del.title, await encode(del));
    await bm.createNote(root, keep.title, await encode(keep));
    await deleteForever([{ id: del.id, bookmarkId: delBid }]);
    expect(client.deleteFile).toHaveBeenCalledWith('UNIQUE');
    expect(client.deleteFile).not.toHaveBeenCalledWith('SHARED');
    expect(client.deleteFile).toHaveBeenCalledTimes(1);
  });

  it('trashNotes re-folders a local-only note to Trash; restore returns it', async () => {
    const root = await bm.ensureRoot();
    const trash = await ensureTrash(root);
    const note = createNote({ body: 'local' });
    await mirror.saveBackup(note, { folderId: root, localOnly: true });
    await trashNotes([{ id: note.id, bookmarkId: null, folderId: root, localOnly: true }], trash);
    expect((await mirror.localOnlyBackups(trash)).some((n) => n.id === note.id)).toBe(true);
    expect((await mirror.localOnlyBackups(root)).length).toBe(0);
    await restoreNotes([{ id: note.id, bookmarkId: null }], root);
    expect((await mirror.localOnlyBackups(root)).some((n) => n.id === note.id)).toBe(true);
  });
});
