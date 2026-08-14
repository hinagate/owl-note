// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import * as bm from '../src/lib/bookmarks.js';
import * as mirror from '../src/lib/mirror.js';
import { createNote } from '../src/lib/note.js';
import { loadNotes } from '../src/app/app.js';
import { _resetCache } from '../src/lib/note-key.js';

beforeEach(() => { installFakeChrome(); _resetCache(); });

describe('loadNotes merges local-only notes', () => {
  it('returns a folder\'s local-only note even with no bookmark', async () => {
    const root = await bm.ensureRoot();
    const folder = await bm.createNotebook(root, 'Big');
    const n = createNote({ title: 'LocalOnly', body: 'x' });
    await mirror.saveBackup(n, { folderId: folder, localOnly: true });
    const notes = await loadNotes(folder);
    const found = notes.find((x) => x.id === n.id);
    expect(found).toBeTruthy();
    expect(found.localOnly).toBe(true);
    expect(found.bookmarkId).toBe(null);
  });

  it('does not duplicate a note that also exists as a bookmark', async () => {
    const root = await bm.ensureRoot();
    const folder = await bm.createNotebook(root, 'Mix');
    const n = createNote({ title: 'Dup', body: 'hi' });
    const { encode } = await import('../src/lib/codec.js');
    await bm.createNote(folder, n.title, await encode(n));        // as a bookmark
    await mirror.saveBackup(n, { folderId: folder, localOnly: true }); // and (wrongly) local
    const notes = await loadNotes(folder);
    expect(notes.filter((x) => x.id === n.id)).toHaveLength(1);
  });

  it('lists a note as locked when another extension shares the bookmark but not its key', async () => {
    const source = chrome;
    const root = await bm.ensureRoot();
    const n = createNote({ title: 'Shared secret', body: 'never show this without the key' });
    const { encode } = await import('../src/lib/codec.js');
    const bookmarkId = await bm.createNote(root, n.title, await encode(n));

    const target = installFakeChrome({ extensionId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' });
    target.bookmarks = source.bookmarks; // one Chrome profile: shared bookmark tree
    _resetCache();                       // separate extension storage: no source key

    const notes = await loadNotes(root);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ id: n.id, bookmarkId, title: 'Shared secret', locked: true });
    expect(notes[0].body).toContain('key is not on this device');
    expect(notes[0].body).not.toContain('never show this');
  });
});
