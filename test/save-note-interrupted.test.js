import { describe, it, expect, beforeEach } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import * as bm from '../src/lib/bookmarks.js';
import * as mirror from '../src/lib/mirror.js';
import { createNote } from '../src/lib/note.js';
import { saveNote } from '../src/lib/save-note.js';

beforeEach(() => { installFakeChrome(); });

const identity = async (n) => n;

// Incompressible body that exceeds the 8 KB sync cap even after deflate.
function bigBody() {
  let b = '', x = 12345;
  for (let i = 0; i < 9000; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; b += String.fromCharCode(33 + (Math.abs(x) % 94)); }
  return b;
}

describe('saveNote — a save cut off part-way', () => {
  it('marks a new note\'s first copy with the notebook it was headed for', async () => {
    const root = await bm.ensureRoot();
    const note = createNote({ title: 'Capture', body: 'x' });
    // The Drive upload that never comes back: the service worker is stopped mid-await.
    const neverReturns = () => new Promise(() => {});
    saveNote(note, root, undefined, neverReturns);
    await new Promise((r) => setTimeout(r, 0));

    const entry = await mirror.getBackup(note.id);
    expect(entry.pending).toMatchObject({ folderId: root });
    expect(entry.localOnly).toBe(false); // not listed while the save may still be running
  });

  it('drops the marker once the save completes', async () => {
    const root = await bm.ensureRoot();
    const note = createNote({ title: 'Small', body: 'x' });
    await saveNote(note, root, undefined, identity);
    const entry = await mirror.getBackup(note.id);
    expect(entry.pending).toBeUndefined();
    expect(entry.localOnly).toBe(false);
  });

  it('drops the marker when the note is kept on this device', async () => {
    const root = await bm.ensureRoot();
    const note = createNote({ title: 'Big', body: bigBody() });
    const res = await saveNote(note, root, undefined, identity, async () => null);
    expect(res.status).toBe('capped');
    const entry = await mirror.getBackup(note.id);
    expect(entry.pending).toBeUndefined();
    expect(entry).toMatchObject({ localOnly: true, folderId: root });
  });

  it('does not mark an edit of an existing note', async () => {
    const root = await bm.ensureRoot();
    const note = createNote({ title: 'Existing', body: 'x' });
    const { bookmarkId } = await saveNote(note, root, undefined, identity);
    saveNote({ ...note, body: 'edited' }, root, bookmarkId, () => new Promise(() => {}));
    await new Promise((r) => setTimeout(r, 0));
    expect((await mirror.getBackup(note.id)).pending).toBeUndefined();
  });

  it('keeps a NEW over-cap note on this device when its Drive upload fails', async () => {
    const root = await bm.ensureRoot();
    const note = createNote({ title: 'Big', body: bigBody() });
    const res = await saveNote(note, root, undefined, identity, async () => { throw new Error('Drive request timed out'); });
    expect(res.status).toBe('capped');
    expect(await bm.listNotes(root)).toHaveLength(0);
    expect(await mirror.localOnlyBackups(root)).toEqual([expect.objectContaining({ id: note.id })]);
  });

  it('never deletes an EXISTING synced note\'s bookmark over a failed Drive upload', async () => {
    const root = await bm.ensureRoot();
    const note = createNote({ title: 'Grows', body: 'short' });
    const { bookmarkId } = await saveNote(note, root, undefined, identity);
    const grown = { ...note, body: bigBody() };
    await expect(saveNote(grown, root, bookmarkId, identity, async () => { throw new Error('offline'); }))
      .rejects.toThrow('offline');
    expect((await bm.listNotes(root)).map((n) => n.bookmarkId)).toEqual([bookmarkId]);
  });
});
