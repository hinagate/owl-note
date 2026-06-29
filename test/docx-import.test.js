import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { docxToMarkdown } from '../src/lib/docx-import.js';
import mammoth from 'mammoth';
globalThis.mammoth = mammoth; // prod loads mammoth as a separate vendored <script>; tests supply the global

const bytes = readFileSync('test/fixtures/sample.docx');
const ab = () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

describe('docxToMarkdown', () => {
  it('converts heading + bold to Markdown', async () => {
    const md = await docxToMarkdown(ab());
    expect(md).toContain('# My Title');
    expect(md).toContain('**bold text**');
  });

  it('converts a header-less Word table into a GFM table', async () => {
    const md = await docxToMarkdown(ab());
    expect(md).toMatch(/\|\s*Name\s*\|\s*Age\s*\|/);
    expect(md).toMatch(/\|\s*-+\s*\|\s*-+\s*\|/);
    expect(md).toMatch(/\|\s*Ann\s*\|\s*30\s*\|/);
    expect(md).not.toContain('<table'); // no raw HTML table leaked through
  });
});
