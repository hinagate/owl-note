import { describe, it, expect, beforeEach } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import * as bm from '../src/lib/bookmarks.js';
import * as mirror from '../src/lib/mirror.js';
import { encode } from '../src/lib/codec.js';
import { createNote, contentHash } from '../src/lib/note.js';
import { bodyPreview } from '../src/lib/note-drive.js';
import { ensureTrash, trashNotes } from '../src/lib/trash.js';
import { collectExportEntries } from '../src/app/app.js';

beforeEach(() => installFakeChrome());

// The bookmark shape of a Drive-offloaded note: metadata + preview, NO body.
// Mirrors stubForBigNote in src/lib/note-drive.js.
function stubOf(note, fileId) {
  return {
    id: note.id, title: note.title, created: note.created, version: note.version,
    hash: note.hash, pinned: note.pinned, _driveBody: fileId, preview: bodyPreview(note.body),
  };
}

function bigNote(title) {
  const body = `# ${title}\n` + 'full body line that must survive the export round-trip.\n'.repeat(40);
  const n = createNote({ title, body });
  return { ...n, hash: contentHash(body) };
}

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

  // A Drive-offloaded note's bookmark is a body-less stub; exporting the stub as-is
  // writes an empty .md that a later import silently skips — the note never survives
  // an export → import loop (user-reported). Export must hydrate the full body.
  it('hydrates a Drive-stub note from the local mirror without touching Drive', async () => {
    const root = await bm.ensureRoot();
    const note = bigNote('BigLocal');
    await mirror.saveBackup(note); // origin device: mirror holds the full note
    await bm.createNote(root, note.title, await encode(stubOf(note, 'file-1')));

    const neverDrive = async () => { throw new Error('must not fetch — mirror has it'); };
    const { entries, count, skipped } = await collectExportEntries(root, neverDrive);

    expect(count).toBe(1);
    expect(skipped).toBe(0);
    expect(entries[0].text).toContain('full body line that must survive');
  });

  it('hydrates a Drive-stub note from Drive when the mirror misses', async () => {
    const root = await bm.ensureRoot();
    const note = bigNote('BigRemote'); // no mirror entry — e.g. authored on another device
    await bm.createNote(root, note.title, await encode(stubOf(note, 'file-2')));

    const fromDrive = async (fileId) => { expect(fileId).toBe('file-2'); return encode(note); };
    const { entries, count, skipped } = await collectExportEntries(root, fromDrive);

    expect(count).toBe(1);
    expect(skipped).toBe(0);
    expect(entries[0].text).toContain('full body line that must survive');
  });

  it('counts a stub as skipped when Drive is unreachable — never exports an empty body', async () => {
    const root = await bm.ensureRoot();
    const note = bigNote('BigUnreachable');
    await bm.createNote(root, note.title, await encode(stubOf(note, 'file-3')));

    const driveDown = async () => { throw new Error('offline'); };
    const { entries, count, skipped } = await collectExportEntries(root, driveDown);

    expect(count).toBe(0);
    expect(skipped).toBe(1);
    expect(entries.every((e) => !e.path.includes('BigUnreachable'))).toBe(true);
  });

  it('inlines a Drive-offloaded attachment from the local byte cache', async () => {
    const root = await bm.ensureRoot();
    // Offloaded attachment: driveFileId, no dataUri — bytes live in the owlcache.
    await chrome.storage.local.set({ 'owlcache:a1': 'data:image/png;base64,AAAA' });
    const note = createNote({
      title: 'Pic', body: 'see ![shot](owl-img:a1) here',
      attachments: [{ id: 'a1', name: 's.png', mime: 'image/png', driveFileId: 'F1' }],
    });
    await bm.createNote(root, note.title, await encode(note));

    const { entries } = await collectExportEntries(root, async () => { throw new Error('no body fetch'); });

    expect(entries[0].text).toContain('![shot](data:image/png;base64,AAAA)');
    expect(entries[0].text).not.toContain('undefined');
  });

  it('leaves an unresolvable attachment ref intact instead of corrupting the markdown', async () => {
    const root = await bm.ensureRoot();
    const note = createNote({
      title: 'PicGone', body: 'see ![shot](owl-img:a2) here',
      attachments: [{ id: 'a2', name: 's.png', mime: 'image/png', driveFileId: 'F2' }],
    });
    await bm.createNote(root, note.title, await encode(note));

    const { entries } = await collectExportEntries(root, async () => { throw new Error('no body fetch'); });

    expect(entries[0].text).toContain('![shot](owl-img:a2)'); // ref preserved, re-importable
    expect(entries[0].text).not.toContain('undefined');
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
