import { describe, it, expect, beforeEach } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import * as bm from '../src/lib/bookmarks.js';
import { encode } from '../src/lib/codec.js';
import { createNote } from '../src/lib/note.js';
import { ensureTrash, trashNotes } from '../src/lib/trash.js';
import { collectExportEntries } from '../src/app/app.js';

beforeEach(() => installFakeChrome());

describe('collectExportEntries', () => {
  it('gathers per-notebook markdown entries from the bookmark tree', async () => {
    const root = await bm.ensureRoot();
    const nb = await bm.createNotebook(root, 'Recipes');
    await bm.createNote(nb, 'Soup', await encode(createNote({ title: 'Soup', body: '# Soup\nyum' })));
    await bm.createNote(root, 'Loose', await encode(createNote({ title: 'Loose', body: 'hi' })));

    const { entries, count, skipped } = await collectExportEntries(root);
    const paths = entries.map((e) => e.path).sort();

    expect(count).toBe(2);
    expect(skipped).toBe(0);
    expect(paths).toEqual(['Inbox/Loose.md', 'Recipes/Soup.md']);
    const soup = entries.find((e) => e.path === 'Recipes/Soup.md');
    expect(soup.text).toContain('notebook: "Recipes"');
    expect(soup.text.endsWith('# Soup\nyum')).toBe(true);
  });

  it('skips notes whose payload cannot be decoded', async () => {
    const root = await bm.ensureRoot();
    await bm.createNote(root, 'Good', await encode(createNote({ title: 'Good', body: 'ok' })));
    await bm.createNote(root, 'Bad', 'not-a-valid-payload');

    const { count, skipped } = await collectExportEntries(root);
    expect(count).toBe(1);
    expect(skipped).toBe(1);
  });

  it('excludes trashed notes from the export', async () => {
    const root = await bm.ensureRoot();
    const trashId = await ensureTrash(root);
    // Normal note that should appear in the export
    await bm.createNote(root, 'NormalNote', await encode(createNote({ title: 'NormalNote', body: 'keep me' })));
    // Note moved to Trash — must not appear in the export
    const trashedNote = createNote({ title: 'TrashedNote', body: 'delete me' });
    const bid = await bm.createNote(root, trashedNote.title, await encode(trashedNote));
    await trashNotes([{ id: trashedNote.id, bookmarkId: bid, folderId: root }], trashId);

    const { entries } = await collectExportEntries(root);

    const paths = entries.map((e) => e.path);
    const texts = entries.map((e) => e.text);
    expect(paths.every((p) => !p.startsWith('🗑 Trash'))).toBe(true);
    expect(texts.every((t) => !t.includes('TrashedNote'))).toBe(true);
  });
});
