// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import * as bm from '../src/lib/bookmarks.js';
import { decode, encode } from '../src/lib/codec.js';
import { createNote } from '../src/lib/note.js';
import { saveNote, MAX_URL_BYTES, urlByteLength } from '../src/lib/save-note.js';

beforeEach(() => installFakeChrome());

describe('saveNote (lib)', () => {
  it('saves a small note as a synced bookmark', async () => {
    const root = await bm.ensureRoot();
    const note = createNote({ title: 'Hi', body: 'short body' });
    const res = await saveNote(note, root, undefined);
    expect(res.status).toBe('ok');
    expect(res.bookmarkId).toBeTruthy();
    const notes = await bm.allNotes(root);
    expect(notes).toHaveLength(1);
    expect((await decode(notes[0].payload)).body).toBe('short body');
  });
  it('caps at Chrome\'s real ~8KB bookmark-URL sync limit', () => { expect(MAX_URL_BYTES).toBe(8192); });

  it('caps a mid-size note that beats the real 8KB sync ceiling but fit the old 64KB cap', async () => {
    const root = await bm.ensureRoot();
    // Incompressible ~9k chars -> compressed bookmark URL lands ABOVE 8KB but
    // below the old 64KB cap. Such a note used to be written as a bookmark that
    // silently never synced; it must now fall back to local-only instead.
    let body = '', x = 987654321;
    for (let i = 0; i < 9000; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; body += String.fromCharCode(33 + (Math.abs(x) % 94)); }
    const note = createNote({ body });
    const bytes = urlByteLength(await encode(note));
    expect(bytes).toBeGreaterThan(8192);   // beyond the real sync ceiling
    expect(bytes).toBeLessThanOrEqual(65536); // but the old cap would have synced it
    const res = await saveNote(note, root, undefined);
    expect(res.status).toBe('capped');
    expect(await bm.listNotes(root)).toHaveLength(0); // no masquerading bookmark
  });
});
