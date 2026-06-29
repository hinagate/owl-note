import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import { saveNote, MAX_URL_BYTES } from '../src/app/app.js';
import * as bm from '../src/lib/bookmarks.js';
import * as mirror from '../src/lib/mirror.js';
import { getBackup } from '../src/lib/mirror.js';
import { createNote } from '../src/lib/note.js';

beforeEach(() => installFakeChrome());

// ~90k printable, incompressible chars => encoded note URL exceeds MAX_URL_BYTES.
function bigBody(n = 90000) {
  let s = '';
  const chunkSize = 65000; // crypto.getRandomValues limit
  for (let offset = 0; offset < n; offset += chunkSize) {
    const size = Math.min(chunkSize, n - offset);
    const arr = new Uint8Array(size);
    crypto.getRandomValues(arr);
    for (let i = 0; i < arr.length; i++) s += String.fromCharCode(33 + (arr[i] % 94));
  }
  return s;
}

describe('saveNote', () => {
  it('writes a bookmark and a mirror for a small note', async () => {
    const root = await bm.ensureRoot();
    const note = createNote({ body: 'small' });
    const res = await saveNote(note, root);
    expect(res.status).toBe('ok');
    expect((await bm.listNotes(root))).toHaveLength(1);
    expect((await getBackup(note.id)).current.body).toBe('small');
  });

  it('mirrors but does not write a bookmark when over the hard cap', async () => {
    const root = await bm.ensureRoot();
    // Incompressible body so the COMPRESSED bookmark URL genuinely exceeds the cap.
    // Xorshift32 produces high-entropy output that deflate-raw cannot compress
    // (80 000 chars → ~90 000 URL bytes, well above the 65 536 hard cap).
    let body = '';
    let x = 1234567891;
    for (let i = 0; i < 80000; i++) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      body += String.fromCharCode(33 + (Math.abs(x) % 94));
    }
    const note = createNote({ body });
    const res = await saveNote(note, root);
    expect(res.status).toBe('capped');
    expect(await bm.listNotes(root)).toHaveLength(0);
    expect((await getBackup(note.id)).current.id).toBe(note.id);
  });
});

describe('saveNote cap -> local-only', () => {
  it('creates no bookmark and stamps the mirror record local-only with its folderId', async () => {
    const root = await bm.ensureRoot();
    const folder = await bm.createNotebook(root, 'Big');
    const note = createNote({ title: 'Huge', body: bigBody() });
    const res = await saveNote(note, folder, undefined);
    expect(res.status).toBe('capped');
    expect(res.bookmarkId).toBe(null);
    expect((await bm.listNotes(folder)).length).toBe(0); // no bookmark
    const local = await mirror.localOnlyBackups(folder);
    expect(local.map((n) => n.id)).toContain(note.id);
  });

  it('a small note creates a bookmark and is not local-only', async () => {
    const root = await bm.ensureRoot();
    const note = createNote({ title: 'Small', body: 'hi' });
    const res = await saveNote(note, root, undefined);
    expect(res.status).toBe('ok');
    expect(await mirror.isLocalOnly(note.id)).toBe(false);
  });

  it('returns bookmarkId null and removes the old bookmark when an existing note hits the cap', async () => {
    const root = await bm.ensureRoot();
    const folder = await bm.createNotebook(root, 'Big');
    const small = createNote({ title: 'Was small', body: 'hi' });
    const first = await saveNote(small, folder, undefined);  // becomes a real bookmark
    expect(first.bookmarkId).toBeTruthy();
    const grown = { ...small, body: bigBody() };             // same note id, now too large
    const res = await saveNote(grown, folder, first.bookmarkId);
    expect(res.status).toBe('capped');
    expect(res.bookmarkId).toBe(null);
    expect((await bm.listNotes(folder)).length).toBe(0);     // stale bookmark removed
    expect((await mirror.localOnlyBackups(folder)).map((n) => n.id)).toContain(small.id);
  });

  it('clears localOnly when a previously-local note is edited under the cap', async () => {
    const root = await bm.ensureRoot();
    const folder = await bm.createNotebook(root, 'Shrink');
    const note = createNote({ title: 'grow then shrink', body: bigBody() });
    await saveNote(note, folder, undefined);              // capped -> local-only
    expect(await mirror.isLocalOnly(note.id)).toBe(true);
    const small = { ...note, body: 'tiny' };              // same id, now small
    const res = await saveNote(small, folder, undefined);
    expect(res.status).toBe('ok');
    expect(res.bookmarkId).toBeTruthy();
    expect(await mirror.isLocalOnly(note.id)).toBe(false); // mirror flag cleared
  });
});
