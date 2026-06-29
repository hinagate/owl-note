// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import * as bm from '../src/lib/bookmarks.js';
import * as mirror from '../src/lib/mirror.js';
import { createNote } from '../src/lib/note.js';
import { dropNote } from '../src/app/app.js';

beforeEach(() => installFakeChrome());

describe('dropNote', () => {
  it('re-folders a local-only note in the mirror (handle is its id)', async () => {
    const root = await bm.ensureRoot();
    const a = await bm.createNotebook(root, 'A');
    const b = await bm.createNotebook(root, 'B');
    const n = createNote({ title: 'L', body: 'x' });
    await mirror.saveBackup(n, { folderId: a, localOnly: true });
    await dropNote(n.id, b);
    expect(await mirror.localOnlyBackups(a)).toHaveLength(0);
    expect((await mirror.localOnlyBackups(b))[0].id).toBe(n.id);
  });

  it('moves a normal note via bookmarks (handle is a bookmarkId)', async () => {
    const root = await bm.ensureRoot();
    const a = await bm.createNotebook(root, 'A');
    const b = await bm.createNotebook(root, 'B');
    const { encode } = await import('../src/lib/codec.js');
    const n = createNote({ title: 'S', body: 'hi' });
    const bmId = await bm.createNote(a, n.title, await encode(n));
    await dropNote(bmId, b);
    expect((await bm.listNotes(a)).length).toBe(0);
    expect((await bm.listNotes(b)).length).toBe(1);
  });
});
