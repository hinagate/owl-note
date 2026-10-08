import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import * as bm from '../src/lib/bookmarks.js';
import { decode } from '../src/lib/codec.js';
import { createNote } from '../src/lib/note.js';
import * as noteDrive from '../src/lib/note-drive.js';
import { saveNote } from '../src/lib/save-note.js';

// Mock the Drive note-body store so save-note's cleanup call is observable and no network runs.
vi.mock('../src/lib/note-drive.js', () => ({
  stubForBigNote: vi.fn(async () => null),
  deleteNoteBody: vi.fn(async () => {}),
}));

beforeEach(() => {
  installFakeChrome();
  noteDrive.stubForBigNote.mockReset();
  noteDrive.deleteNoteBody.mockReset();
});

// Incompressible body that exceeds the 8 KB sync cap even after deflate.
function bigBody() {
  let b = '', x = 12345;
  for (let i = 0; i < 9000; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; b += String.fromCharCode(33 + (Math.abs(x) % 94)); }
  return b;
}

describe('saveNote — over-cap notes via Drive', () => {
  it('writes a stub bookmark (status "synced") when over the cap and Drive sync is on', async () => {
    const root = await bm.ensureRoot();
    const note = createNote({ body: bigBody() });
    const bigNote = async (content) => ({
      stub: { id: content.id, title: content.title, version: content.version, hash: content.hash, _driveBody: 'FID', preview: content.body.slice(0, 200) },
      fileId: 'FID',
    });
    const res = await saveNote(note, root, undefined, async (n) => n, bigNote);
    expect(res.status).toBe('synced');
    const saved = await bm.listNotes(root);
    expect(saved).toHaveLength(1);
    const stub = await decode(saved[0].payload);
    expect(stub._driveBody).toBe('FID');
    expect(stub.body).toBeUndefined(); // the body lives in Drive, not the bookmark
  });

  it('falls back to local-only ("capped") when over the cap and Drive sync is off', async () => {
    const root = await bm.ensureRoot();
    const note = createNote({ body: bigBody() });
    const res = await saveNote(note, root, undefined, async (n) => n, async () => null);
    expect(res.status).toBe('capped');
    expect(await bm.listNotes(root)).toHaveLength(0);
  });

  it('deletes the Drive body when a previously Drive-backed note shrinks under the cap', async () => {
    const root = await bm.ensureRoot();
    const note = { ...createNote({ body: 'short' }), _driveBody: 'OLDFILE' };
    await saveNote(note, root, undefined, async (n) => n); // default bigNote not reached (note is small)
    expect(noteDrive.deleteNoteBody).toHaveBeenCalledWith('OLDFILE');
    expect(await bm.listNotes(root)).toHaveLength(1); // saved as a normal bookmark
  });
});

describe('saveNote — the returned note says where its body lives on Drive', () => {
  const bigNoteAs = (fileId) => vi.fn(async (content, payload, prevFileId) => ({
    stub: { id: content.id, title: content.title, version: content.version, hash: content.hash, _driveBody: prevFileId || fileId, preview: '' },
    fileId: prevFileId || fileId,
  }));

  it('points at the file it uploaded, so the next save updates that file instead of uploading another', async () => {
    const root = await bm.ensureRoot();
    const bigNote = bigNoteAs('FILE-1');
    const first = await saveNote(createNote({ body: bigBody() }), root, undefined, async (n) => n, bigNote);
    expect(first.note._driveBody).toBe('FILE-1');
    await saveNote({ ...first.note, body: `${bigBody()} more` }, root, first.bookmarkId, async (n) => n, bigNote);
    expect(bigNote.mock.calls[1][2]).toBe('FILE-1'); // the previous file, to be updated in place
  });

  it('tries once to delete the old body file and never queues it for later', async () => {
    // Until sync catches up another device may still have the note over the cap and be
    // updating this file: a retry from here could delete its copy. A failed delete leaves
    // the file behind instead.
    const root = await bm.ensureRoot();
    noteDrive.deleteNoteBody.mockRejectedValueOnce(new Error('Failed to fetch')); // offline
    const res = await saveNote({ ...createNote({ body: 'short' }), _driveBody: 'OLDFILE' }, root, undefined, async (n) => n);
    expect(res.status).toBe('ok');
    expect(res.note).not.toHaveProperty('_driveBody'); // not retried from this session on every save
    await new Promise((r) => setTimeout(r, 20));
    expect((await chrome.storage.local.get('drive:pendingCleanupV1'))['drive:pendingCleanupV1']).toBeUndefined();
    const { getBackup } = await import('../src/lib/mirror.js');
    expect((await getBackup(res.note.id)).current).not.toHaveProperty('_driveBody');
  });

  it('treats a body file that is already gone as deleted', async () => {
    const root = await bm.ensureRoot();
    noteDrive.deleteNoteBody.mockRejectedValueOnce(new Error('Drive API 404 for https://www.googleapis.com/drive/v3/files/OLDFILE'));
    const res = await saveNote({ ...createNote({ body: 'short' }), _driveBody: 'OLDFILE' }, root, undefined, async (n) => n);
    expect(res.note).not.toHaveProperty('_driveBody');
    await new Promise((r) => setTimeout(r, 20));
    expect((await chrome.storage.local.get('drive:pendingCleanupV1'))['drive:pendingCleanupV1']).toBeUndefined();
  });

  it('does nothing — no Drive upload — for a note deleted while it was open', async () => {
    const root = await bm.ensureRoot();
    const note = createNote({ body: 'short' });
    const first = await saveNote(note, root, undefined, async (n) => n);
    await bm.deleteNote(first.bookmarkId); // deleted forever in another tab
    const bigNote = vi.fn(async () => ({ stub: {}, fileId: 'NEW' }));
    await expect(saveNote({ ...note, body: bigBody() }, root, first.bookmarkId, async (n) => n, bigNote)).rejects.toThrow('deleted');
    expect(bigNote).not.toHaveBeenCalled();
  });

  it('drops the pointer once the note shrinks back into its bookmark and its file is deleted', async () => {
    const root = await bm.ensureRoot();
    const res = await saveNote({ ...createNote({ body: 'short' }), _driveBody: 'OLDFILE' }, root, undefined, async (n) => n);
    expect(noteDrive.deleteNoteBody).toHaveBeenCalledWith('OLDFILE');
    expect(res.note).not.toHaveProperty('_driveBody');
  });
});
