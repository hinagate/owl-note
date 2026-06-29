import { describe, it, expect, beforeEach } from 'vitest';
import SparkMD5 from 'spark-md5';
import { installFakeChrome } from './helpers/fake-chrome.js';
import * as bm from '../src/lib/bookmarks.js';
import { decode } from '../src/lib/codec.js';
import { importFiles, collectExportEntries } from '../src/app/app.js';

beforeEach(() => installFakeChrome());

function enexFile(name, xml) {
  return { name, text: async () => xml, arrayBuffer: async () => new TextEncoder().encode(xml).buffer };
}

function b64bytes(b64) {
  const bin = atob(b64);
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}

const ENEX = `<?xml version="1.0" encoding="UTF-8"?><en-export><note>`
  + `<title>SQL Snippet</title><created>20240115T101530Z</created>`
  + `<content><![CDATA[<en-note><div style="-en-codeblock:true;"><div>SELECT 1</div><div>FROM dual</div></div></en-note>]]></content>`
  + `</note></en-export>`;

describe('importFiles .enex', () => {
  it('imports a .enex into a folder named after the file', async () => {
    const root = await bm.ensureRoot();
    const tally = await importFiles([enexFile('Work.enex', ENEX)]);
    expect(tally.created).toBe(1);
    const work = (await bm.listNotebooks(root)).find((n) => n.title === 'Work');
    expect(work).toBeTruthy();
    const notes = await bm.listNotes(work.id);
    expect(notes.length).toBe(1);
    const note = await decode(notes[0].payload);
    expect(note.title).toBe('SQL Snippet');
    expect(note.body).toContain('```\nSELECT 1\nFROM dual\n```');
  });

  it('is idempotent: re-importing the same .enex updates with no duplicate', async () => {
    await importFiles([enexFile('Work.enex', ENEX)]);
    const tally = await importFiles([enexFile('Work.enex', ENEX)]);
    expect(tally.created).toBe(0);
    expect(tally.updated).toBe(1);
  });

  it('moves imported images into attachments (body keeps only a ref) and export inlines them back', async () => {
    const img = 'iVBORw0KGgo=';
    const hash = SparkMD5.ArrayBuffer.hash(b64bytes(img).buffer);
    const enex = '<en-export><note><title>Pic</title>'
      + `<content><![CDATA[<en-note><div><en-media hash="${hash}" type="image/png"/></div></en-note>]]></content>`
      + `<resource><data>${img}</data><mime>image/png</mime><resource-attributes><file-name>pic.png</file-name></resource-attributes></resource>`
      + '</note></en-export>';
    const root = await bm.ensureRoot();
    await importFiles([enexFile('Pics.enex', enex)]);

    // The (tiny) image note is small enough to be a real bookmark.
    const folder = (await bm.listNotebooks(root)).find((n) => n.title === 'Pics');
    const note = await decode((await bm.listNotes(folder.id))[0].payload);
    expect(note.body).toMatch(/!\[pic\.png\]\(owl-img:[a-z0-9]+\)/i);
    expect(note.body).not.toContain('base64'); // no data: wall in the stored body
    expect(note.attachments).toHaveLength(1);
    expect(note.attachments[0].dataUri).toBe(`data:image/png;base64,${img}`);

    // Export inlines the image back so the .md is self-contained.
    const { entries } = await collectExportEntries(root);
    const entry = entries.find((e) => e.text.includes('owl-img:') || e.text.includes('data:image/png'));
    expect(entry.text).toContain(`![pic.png](data:image/png;base64,${img})`);
    expect(entry.text).not.toContain('owl-img:');
  });
});
