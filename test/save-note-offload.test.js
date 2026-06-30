// test/save-note-offload.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import * as bm from '../src/lib/bookmarks.js';
import { createNote } from '../src/lib/note.js';
import { saveNote } from '../src/lib/save-note.js';

beforeEach(() => installFakeChrome());

describe('saveNote with offload', () => {
  it('an oversized image note becomes a synced bookmark after offload', async () => {
    const root = await bm.ensureRoot();
    // Create incompressible data using pseudo-random values (like in save-note.test.js).
    // ~9KB of pseudo-random chars won't compress and will exceed 8KB when encoded.
    let body = 'data:image/png;base64,', x = 987654321;
    for (let i = 0; i < 9000; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; body += String.fromCharCode(33 + (Math.abs(x) % 94)); }
    const note = createNote({ body: '![](owl-img:h1)', attachments: [{ id: 'h1', name: 'p.png', dataUri: body }] });
    // Injected offload simulates a successful Drive upload: strip dataUri, add driveFileId.
    const offload = async (n) => ({ ...n, attachments: n.attachments.map((a) => ({ id: a.id, name: a.name, mime: 'image/png', driveFileId: 'FID' })) });
    const res = await saveNote(note, root, undefined, offload);
    expect(res.status).not.toBe('capped');
    expect(await bm.listNotes(root)).toHaveLength(1); // a real, synced bookmark exists
  });

  it('still caps when offload is a no-op (sync disabled)', async () => {
    const root = await bm.ensureRoot();
    // Create incompressible data using pseudo-random values.
    let body = 'data:image/png;base64,', x = 987654321;
    for (let i = 0; i < 9000; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; body += String.fromCharCode(33 + (Math.abs(x) % 94)); }
    const note = createNote({ body: '![](owl-img:h1)', attachments: [{ id: 'h1', name: 'p.png', dataUri: body }] });
    const res = await saveNote(note, root, undefined, async (n) => n); // disabled -> unchanged
    expect(res.status).toBe('capped');
    expect(await bm.listNotes(root)).toHaveLength(0);
  });
});
