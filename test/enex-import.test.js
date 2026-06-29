import { describe, it, expect } from 'vitest';
import SparkMD5 from 'spark-md5';
import { parseEnexNotes } from '../src/lib/enex-import.js';

const wrap = (...notes) =>
  `<?xml version="1.0" encoding="UTF-8"?><en-export>${notes.join('')}</en-export>`;
const note = (title, enml, created = '20240115T101530Z') =>
  `<note><title>${title}</title><created>${created}</created><content><![CDATA[<en-note>${enml}</en-note>]]></content></note>`;

describe('parseEnexNotes', () => {
  it('splits multiple notes and converts basic ENML', () => {
    const out = parseEnexNotes(wrap(
      note('One', '<div>Hello <b>world</b></div>'),
      note('Two', '<div>Second</div>'),
    ));
    expect(out.map((n) => n.title)).toEqual(['One', 'Two']);
    expect(out[0].body).toBe('Hello **world**');
  });

  it('produces a stable deterministic id across re-parses', () => {
    const a = parseEnexNotes(wrap(note('Same', '<div>body</div>')))[0];
    const b = parseEnexNotes(wrap(note('Same', '<div>body</div>')))[0];
    expect(a.meta.id).toBe(b.meta.id);
    expect(a.meta.id.startsWith('enex-')).toBe(true);
  });

  it('falls back to Untitled when no title', () => {
    const out = parseEnexNotes('<en-export><note><content><![CDATA[<en-note><div>x</div></en-note>]]></content></note></en-export>');
    expect(out[0].title).toBe('Untitled');
  });
});

describe('parseEnexNotes code blocks', () => {
  it('rebuilds a multi-line Evernote code block into one fenced block', () => {
    const enml = '<div style="box-sizing:border-box;-en-codeblock:true;background:#fbfaf8;">'
      + '<div>SELECT id, name</div><div>FROM users</div><div>WHERE active = 1;</div></div>';
    const out = parseEnexNotes(`<en-export><note><title>Q</title><created>20240115T101530Z</created><content><![CDATA[<en-note>${enml}</en-note>]]></content></note></en-export>`);
    expect(out[0].body).toBe('```\nSELECT id, name\nFROM users\nWHERE active = 1;\n```');
  });

  it('rebuilds a <br>-delimited code block into one fenced block', () => {
    const enml = '<div style="-en-codeblock:true;">SELECT 1<br>FROM dual<br>WHERE x = 1</div>';
    const out = parseEnexNotes(`<en-export><note><title>B</title><content><![CDATA[<en-note>${enml}</en-note>]]></content></note></en-export>`);
    expect(out[0].body).toBe('```\nSELECT 1\nFROM dual\nWHERE x = 1\n```');
  });
});

describe('parseEnexNotes tables', () => {
  it('converts an HTML table to a GFM table', () => {
    const enml = '<table><tr><th>Name</th><th>Age</th></tr><tr><td>Ann</td><td>30</td></tr></table>';
    const out = parseEnexNotes(`<en-export><note><title>T</title><content><![CDATA[<en-note>${enml}</en-note>]]></content></note></en-export>`);
    expect(out[0].body).toMatch(/\|\s*Name\s*\|\s*Age\s*\|/);
    expect(out[0].body).toMatch(/\|\s*-+\s*\|\s*-+\s*\|/);
    expect(out[0].body).toMatch(/\|\s*Ann\s*\|\s*30\s*\|/);
  });
});

function b64bytes(b64) {
  const bin = atob(b64);
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}

describe('parseEnexNotes resources', () => {
  const img = 'iVBORw0KGgo='; // arbitrary small base64
  const imgHash = SparkMD5.ArrayBuffer.hash(b64bytes(img).buffer);

  const build = (media, resources) =>
    `<en-export><note><title>R</title><content><![CDATA[<en-note>${media}</en-note>]]></content>${resources}</note></en-export>`;

  it('inlines a matched image as a data URI', () => {
    const out = parseEnexNotes(build(
      `<en-media hash="${imgHash}" type="image/png"/>`,
      `<resource><data encoding="base64">${img}</data><mime>image/png</mime><resource-attributes><file-name>pic.png</file-name></resource-attributes></resource>`,
    ));
    expect(out[0].body).toBe(`![pic.png](data:image/png;base64,${img})`);
  });

  it('marks a non-image attachment by filename without a dead data link', () => {
    const out = parseEnexNotes(build(
      `<en-media hash="${imgHash}" type="application/pdf"/>`,
      `<resource><data encoding="base64">${img}</data><mime>application/pdf</mime><resource-attributes><file-name>doc.pdf</file-name></resource-attributes></resource>`,
    ));
    expect(out[0].body).toBe('[attachment: doc.pdf]');
  });

  it('drops media with no matching resource', () => {
    const out = parseEnexNotes(build(`<en-media hash="deadbeef" type="image/png"/>`, ''));
    expect(out[0].body).toBe('');
  });
});
