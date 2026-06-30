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
