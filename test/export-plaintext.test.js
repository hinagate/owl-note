// @vitest-environment node
// Node, not jsdom: jsdom's Blob cannot be read back (no arrayBuffer(), and Response
// does not accept it either), and these tests read the exported bytes for real.
import { describe, it, expect, beforeEach } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import * as bm from '../src/lib/bookmarks.js';
import * as mirror from '../src/lib/mirror.js';
import { saveNote } from '../src/lib/save-note.js';
import { buildMarkdownExport } from '../src/lib/markdown-export.js';
import { buildOwlNotePackage } from '../src/lib/owl-note-package.js';
import { createNote } from '../src/lib/note.js';
import { unzip } from '../src/lib/unzip.js';
import { decode } from '../src/lib/codec.js';
import { _resetCache } from '../src/lib/note-key.js';

beforeEach(() => { installFakeChrome(); _resetCache(); });

const SECRET = 'the quick brown fox jumps over the lazy dog';

// Encryption exists to protect notes AT REST in the bookmark tree. It must never
// reach an export or a share: those files are meant to be opened by other
// programs — a text editor, Obsidian, a PDF reader — and ciphertext there would
// make the data useless. These tests pin that boundary, because the surfaces are
// far apart in the codebase and nothing else would catch a regression.
describe('exports stay plaintext while storage is encrypted', () => {
  it('the bookmark is encrypted but the local mirror keeps the note readable', async () => {
    const root = await bm.ensureRoot();
    const note = createNote({ title: 'Notes', body: SECRET });
    const { bookmarkId } = await saveNote(note, root, null);

    const [node] = await chrome.bookmarks.get(bookmarkId);
    expect(node.url).not.toContain(SECRET); // at rest: sealed
    expect((await decode(node.url.split('#')[1])).body).toBe(SECRET); // and recoverable

    const backup = await mirror.getBackup(note.id);
    expect(backup.current.body).toBe(SECRET); // mirror is plaintext by design
  });

  // The whole-notes JSON backup was removed: it collected from the local mirror,
  // which only holds notes THIS device saved, so anything synced in from another
  // device was silently missing from a file people treated as a complete restore.
  // The Markdown export reads the bookmark tree and is the note backup now.
  it('the mirror no longer offers a note backup at all', async () => {
    expect(mirror.exportAll).toBeUndefined();
    expect(mirror.importAll).toBeUndefined();
  });

  it('the local mirror still keeps the note readable for recovery', async () => {
    const root = await bm.ensureRoot();
    const note = createNote({ title: 'Notes', body: SECRET });
    await saveNote(note, root, null);
    expect((await mirror.getBackup(note.id)).current.body).toBe(SECRET);
  });

  it('Markdown export produces readable .md text', async () => {
    const entries = buildMarkdownExport(
      [{ id: 'n1', title: 'Notes', body: SECRET, folderId: 'f1' }],
      [{ id: 'f1', title: 'Work', parentId: 'root' }],
      'root',
    );
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.map((e) => e.text).join('\n')).toContain(SECRET);
  });

  it('.owl-note package unzips to readable Markdown with any zip tool', async () => {
    const blob = await buildOwlNotePackage(createNote({ title: 'Notes', body: SECRET }));
    const entries = await unzip(new Uint8Array(await blob.arrayBuffer()));
    const md = entries.find((e) => e.path === 'note.md');
    expect(md).toBeTruthy();
    expect(new TextDecoder().decode(md.bytes)).toContain(SECRET);
  });

  it('a round-trip through save and re-read returns the original text', async () => {
    const root = await bm.ensureRoot();
    const note = createNote({ title: 'Notes', body: SECRET });
    await saveNote(note, root, null);
    const [stored] = await bm.listNotes(root);
    expect((await decode(stored.payload)).body).toBe(SECRET);
  });
});
