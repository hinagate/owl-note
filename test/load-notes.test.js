// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import * as bm from '../src/lib/bookmarks.js';
import * as mirror from '../src/lib/mirror.js';
import { createNote } from '../src/lib/note.js';
import { loadNotes } from '../src/app/app.js';

beforeEach(() => installFakeChrome());

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
});
