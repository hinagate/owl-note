import { describe, it, expect } from 'vitest';
import mammoth from 'mammoth';

describe('mammoth smoke', () => {
  it('converts the fixture .docx to HTML (heading, bold, table)', async () => {
    const html = (await mammoth.convertToHtml({ path: 'test/fixtures/sample.docx' })).value;
    expect(html).toContain('<h1>My Title</h1>');
    expect(html).toContain('<strong>bold text</strong>');
    expect(html).toContain('<table>');
  });
});
