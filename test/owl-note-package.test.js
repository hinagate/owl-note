// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { buildOwlNotePackage, parseOwlNotePackage, owlNoteFilename } from '../src/lib/owl-note-package.js';
import { unzip } from '../src/lib/unzip.js';

describe('.owl-note package', () => {
  it('contains note.json, portable note.md, and raw attachments', async () => {
    const note = {
      id: 'sender-id',
      title: 'Trip / July',
      body: 'Photo: ![lake](owl-img:img1)\n\nFile: [plan](owl-file:file1)',
      attachments: [
        { id: 'img1', name: 'lake.png', mime: 'image/png', dataUri: 'data:image/png;base64,AQID' },
        { id: 'file1', name: 'plan.txt', mime: 'text/plain', dataUri: 'data:text/plain;base64,SGk=' },
      ],
    };
    const blob = await buildOwlNotePackage(note);
    const entries = await unzip(new Uint8Array(await blob.arrayBuffer()));
    const paths = entries.map((entry) => entry.path);
    expect(paths).toContain('note.json');
    expect(paths).toContain('note.md');
    expect(paths.filter((path) => path.startsWith('attachments/'))).toHaveLength(2);

    const manifest = JSON.parse(new TextDecoder().decode(entries.find((entry) => entry.path === 'note.json').bytes));
    expect(manifest.note).not.toHaveProperty('id');
    expect(manifest.attachments).toHaveLength(2);
    const markdown = new TextDecoder().decode(entries.find((entry) => entry.path === 'note.md').bytes);
    expect(markdown).toContain('(attachments/');
    expect(markdown).not.toContain('owl-img:');
    expect(owlNoteFilename(note.title)).toBe('Trip - July.owl-note');
  });

  it('round-trips editable OWL references and attachment bytes', async () => {
    const source = {
      title: 'Shared',
      body: '![photo](owl-img:abc)',
      attachments: [{ id: 'abc', name: 'p.jpg', mime: 'image/jpeg', dataUri: 'data:image/jpeg;base64,AQIDBA==' }],
    };
    const blob = await buildOwlNotePackage(source);
    const parsed = await parseOwlNotePackage(new Uint8Array(await blob.arrayBuffer()));
    expect(parsed.title).toBe('Shared');
    expect(parsed.body).toBe(source.body);
    expect(parsed.attachments).toEqual(source.attachments);
  });
});
