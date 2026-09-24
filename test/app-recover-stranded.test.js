import { describe, it, expect, beforeEach } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import { _resetCache } from '../src/lib/note-key.js';
import * as bm from '../src/lib/bookmarks.js';
import * as mirror from '../src/lib/mirror.js';
import { saveNote } from '../src/lib/save-note.js';
import { createNote } from '../src/lib/note.js';
import { decode } from '../src/lib/codec.js';

beforeEach(() => {
  installFakeChrome();
  _resetCache();
  document.body.innerHTML = '<div id="toast" hidden></div>';
});

const jpeg = `data:image/jpeg;base64,${'A'.repeat(100_000)}`;
const captureNote = (id) => ({
  id, title: 'A long page', body: `![A long page](owl-img:${id}img)`,
  attachments: [{ id: `${id}img`, name: 'A long page.jpg', mime: 'image/jpeg', dataUri: jpeg }],
  version: 1, hash: 'h',
});

describe('recoverStrandedCaptures', () => {
  it('lists the captures an interrupted save hid, and nothing else', async () => {
    const app = await import('../src/app/app.js');
    const root = await bm.ensureRoot();
    const notebook = await bm.createNotebook(root, 'Reading');
    const gone = await bm.createNotebook(root, 'Deleted later');
    await bm.deleteFolder(gone);

    // A normal, fully saved note: encrypted in its bookmark, listed already.
    const listed = createNote({ title: 'Saved fine', body: 'x' });
    await saveNote(listed, root, undefined, async (n) => n);
    // The user's case: a capture stranded before saves were marked.
    await chrome.storage.local.set({ 'note:old': { current: captureNote('old'), previous: null, localOnly: false } });
    // Marked saves abandoned long ago: one headed for a live notebook, one for a deleted one.
    const longAgo = Date.now() - mirror.PENDING_GRACE_MS - 60_000;
    await chrome.storage.local.set({ 'note:toNb': { current: captureNote('toNb'), previous: null, localOnly: false, pending: { folderId: notebook, at: longAgo } } });
    await chrome.storage.local.set({ 'note:toGone': { current: captureNote('toGone'), previous: null, localOnly: false, pending: { folderId: gone, at: longAgo } } });

    expect(await app.recoverStrandedCaptures(root)).toBe(3);

    expect((await mirror.localOnlyBackups(root)).map((n) => n.id).sort()).toEqual(['old', 'toGone']);
    expect((await mirror.localOnlyBackups(notebook)).map((n) => n.id)).toEqual(['toNb']);
    expect((await mirror.getBackup(listed.id)).localOnly).toBe(false);
    expect(await app.recoverStrandedCaptures(root)).toBe(0); // nothing left to find
  });

  it('recognises a listed note by its bookmark even when this device lacks its key', async () => {
    const app = await import('../src/app/app.js');
    const source = chrome;
    const root = await bm.ensureRoot();
    const note = createNote({ title: 'Synced from elsewhere', body: 'x' });
    await saveNote(note, root, undefined, async (n) => n);
    expect(await bm.allNotes(root)).toHaveLength(1);

    // A second installation sharing the bookmark tree, without the key that sealed it.
    const target = installFakeChrome({ extensionId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' });
    target.bookmarks = source.bookmarks;
    _resetCache();
    const [{ payload }] = await bm.allNotes(root);
    await expect(decode(payload)).rejects.toThrow(); // this device really cannot open it
    // Its mirror copy looks stranded; only the bookmark says the note is listed.
    await target.storage.local.set({ [`note:${note.id}`]: { current: { ...captureNote('x'), id: note.id }, previous: null, localOnly: false } });

    expect(await app.recoverStrandedCaptures(root)).toBe(0);
    expect((await mirror.getBackup(note.id)).localOnly).toBe(false);
  });
});
