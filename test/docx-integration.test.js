import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { installFakeChrome } from './helpers/fake-chrome.js';
import * as bm from '../src/lib/bookmarks.js';
import { decode } from '../src/lib/codec.js';
import { importFiles } from '../src/app/app.js';
import mammoth from 'mammoth';
globalThis.mammoth = mammoth; // prod loads mammoth as a separate vendored <script>; tests supply the global

beforeEach(() => installFakeChrome());

const bytes = readFileSync('test/fixtures/sample.docx');
function docxFile(name) {
  return {
    name,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    text: async () => '',
  };
}

describe('importFiles .docx', () => {
  it('imports a .docx as one note in root, titled by filename', async () => {
    const root = await bm.ensureRoot();
    const tally = await importFiles([docxFile('My Notes.docx')]);
    expect(tally.created).toBe(1);
    const notes = await bm.allNotes(root);
    expect(notes.length).toBe(1);
    expect(notes[0].folderId).toBe(root);
    const note = await decode(notes[0].payload);
    expect(note.title).toBe('My Notes');
    expect(note.body).toContain('# My Title');
    expect(note.body).toMatch(/\|\s*Name\s*\|\s*Age\s*\|/);
  });

  it('imports multiple .docx as separate notes', async () => {
    await bm.ensureRoot();
    const tally = await importFiles([docxFile('A.docx'), docxFile('B.docx')]);
    expect(tally.created).toBe(2);
  });

  it('counts a corrupt .docx as skipped without aborting the batch', async () => {
    await bm.ensureRoot();
    const garbage = { name: 'bad.docx', arrayBuffer: async () => new TextEncoder().encode('not a zip').buffer, text: async () => '' };
    const tally = await importFiles([garbage, docxFile('Good.docx')]);
    expect(tally.skipped).toBe(1);
    expect(tally.created).toBe(1);
  });
});
