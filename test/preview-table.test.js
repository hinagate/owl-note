import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderMarkdown } from '../src/lib/markdown.js';
import { inlineImages } from '../src/lib/note-images.js';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const attachments = [{ id: 'a1b2c3', name: 'drawing.png', dataUri: PNG }];

const table = [
  '| Step | Sketch |',
  '| --- | --- |',
  '| Assembly | ![drawing.png](owl-img:a1b2c3) |',
  '| Wiring | plain text |',
].join('\n');

// jsdom applies no external stylesheet, so the only honest way to guard the
// preview's table styling is to assert it against the CSS text itself.
const css = readFileSync('src/app/app.css', 'utf8');

describe('tables in the rendered preview', () => {
  it('renders GFM pipe syntax as a real table', () => {
    const html = renderMarkdown(table);
    expect(html).toContain('<table>');
    expect(html).toContain('<thead>');
    expect(html).toContain('<th>Step</th>');
    expect(html).toContain('<td>Wiring</td>');
  });

  it('inlines an attachment reference inside a table cell', () => {
    const html = renderMarkdown(inlineImages(table, attachments));
    // The image must land INSIDE the cell, not get hoisted out of the table.
    expect(html).toMatch(/<td><img src="data:image\/png;base64,[^"]+" alt="drawing\.png"><\/td>/);
  });

  it('keeps column alignment markers through sanitization', () => {
    const html = renderMarkdown('| L | C | R |\n| :-- | :-: | --: |\n| a | b | c |');
    expect(html).toContain('align="center"');
    expect(html).toContain('align="right"');
  });

  // Alignment arrives as an align="" presentational hint, which any author
  // text-align rule would outrank — so the default must exclude aligned cells.
  it('does not let the default text-align clobber an alignment marker', () => {
    expect(css).toMatch(/\.preview th:not\(\[align\]\),\s*\.preview td:not\(\[align\]\)/);
    expect(css).not.toMatch(/\.preview th,\s*\.preview td\s*\{[^}]*text-align/);
  });

  it('treats an escaped pipe as cell content rather than a new column', () => {
    const html = renderMarkdown('| A | B |\n| --- | --- |\n| x \\| y | z |');
    const cells = html.match(/<td[^>]*>/g) || [];
    expect(cells).toHaveLength(2); // not 3
    expect(html).toContain('x | y');
  });

  it('draws a border on every table cell', () => {
    expect(css).toMatch(/\.preview th,\s*\.preview td\s*\{[^}]*border:\s*1px solid/);
  });

  it('collapses the shared cell edges so borders do not double up', () => {
    expect(css).toMatch(/\.preview table\s*\{[^}]*border-collapse:\s*collapse/);
  });

  it('distinguishes the header row from the body', () => {
    expect(css).toMatch(/\.preview thead th\s*\{[^}]*background:/);
  });

  it('caps an image inside a cell so one sketch cannot set the column width', () => {
    expect(css).toMatch(/\.preview td img\s*\{[^}]*max-height:/);
  });
});
