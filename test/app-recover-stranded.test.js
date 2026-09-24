import { describe, it, expect, beforeEach, vi } from 'vitest';
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

// Incompressible, like a real capture JPEG (see mirror-recover.test.js).
function randomBase64(bytes) {
  const raw = new Uint8Array(bytes);
  for (let i = 0; i < raw.length; i += 65536) crypto.getRandomValues(raw.subarray(i, Math.min(i + 65536, raw.length)));
  let s = '';
  for (let i = 0; i < raw.length; i += 0x8000) s += String.fromCharCode(...raw.subarray(i, i + 0x8000));
  return btoa(s);
}
const captureNote = (id) => ({
  id, title: 'A long page', body: `![A long page](owl-img:${id}img)`,
  attachments: [{ id: `${id}img`, name: 'A long page.jpg', mime: 'image/jpeg', dataUri: `data:image/jpeg;base64,${randomBase64(400 * 1024)}` }],
  version: 1, hash: 'h', updated: 1,
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

  it('looks for copies stranded the old way only once per installation', async () => {
    const app = await import('../src/app/app.js');
    const root = await bm.ensureRoot();
    expect(await app.recoverStrandedCaptures(root)).toBe(0); // first launch: nothing there
    // One appearing afterwards cannot have been stranded by an old build.
    await chrome.storage.local.set({ 'note:later': { current: captureNote('later'), previous: null, localOnly: false } });
    expect(await app.recoverStrandedCaptures(root)).toBe(0);
    expect((await mirror.getBackup('later')).localOnly).toBe(false);
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

  it('runs on launch: boot brings a stranded capture back and says so', async () => {
    document.body.innerHTML = '<div id="toolbar"></div><aside id="sidebar"></aside><section id="note-list"></section>'
      + '<main id="editor"></main><div id="toast" hidden></div>';
    const app = await import('../src/app/app.js');
    app.resetUI();
    await chrome.storage.local.set({ 'note:old': { current: captureNote('old'), previous: null, localOnly: false } });

    await app.boot();

    await vi.waitFor(async () => expect((await mirror.getBackup('old')).localOnly).toBe(true), { timeout: 5000 });
    await vi.waitFor(() => expect(document.querySelector('#toast').textContent).toContain('Recovered 1 capture'), { timeout: 5000 });
  });

  it('reports only the notes that really synced when Drive sync is turned on', async () => {
    const app = await import('../src/app/app.js');
    const root = await bm.ensureRoot();
    await mirror.saveBackup({ id: 'up', title: 'Up', body: 'x' }, { localOnly: true, folderId: root });
    await mirror.saveBackup({ id: 'stuck', title: 'Stuck', body: 'y' }, { localOnly: true, folderId: root });
    // saveNote keeps a note whose Drive upload failed on the device and says 'capped'.
    const save = async (n) => (n.id === 'up' ? { status: 'synced', bookmarkId: 'b1' } : { status: 'capped', bookmarkId: null, driveFailed: true });
    expect(await app.reconcileLocalToDrive(save)).toBe(1);
  });
});
