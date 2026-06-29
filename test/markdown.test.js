import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../src/lib/markdown.js';

describe('markdown', () => {
  it('renders headings and paragraphs', () => {
    const html = renderMarkdown('# Title\n\nHello');
    expect(html).toContain('<h1');
    expect(html).toContain('Title');
    expect(html).toContain('Hello');
  });

  it('highlights fenced code blocks', () => {
    const html = renderMarkdown('```js\nconst x = 1;\n```');
    expect(html).toContain('hljs');
    expect(html).toContain('<code');
  });

  it('strips script tags (sanitizes)', () => {
    const html = renderMarkdown('hi <script>alert(1)</script>');
    expect(html.toLowerCase()).not.toContain('<script');
  });
});

describe('markdown math', () => {
  it('renders a $$...$$ block as a KaTeX display equation', () => {
    const html = renderMarkdown('$$a^2 + b^2 = c^2$$');
    expect(html).toContain('katex-display');
    expect(html).toContain('class="katex"');
  });

  it('renders inline $...$ math without a display wrapper', () => {
    const html = renderMarkdown('Pythagoras: $x^2 + y^2$ done.');
    expect(html).toContain('class="katex"');
    expect(html).not.toContain('katex-display');
    expect(html).toContain('done.');
  });

  it('preserves the MathML branch (accessibility) through sanitization', () => {
    const html = renderMarkdown('$$E = mc^2$$');
    expect(html).toContain('<math');
    expect(html).toContain('</math>');
    // The original TeX is kept in an <annotation> for copy/screen-reader use.
    expect(html).toContain('annotation');
    expect(html).toContain('E = mc^2');
  });

  it('renders the CJK display example without throwing', () => {
    const src = '$$P(\\text{反彈} \\mid \\text{連續下跌 } n \\text{ 次}) = P(\\text{反彈})$$';
    const html = renderMarkdown(src);
    expect(html).toContain('katex-display');
    expect(html).toContain('反彈');
  });

  it('keeps the inline style heights KaTeX needs for layout', () => {
    const html = renderMarkdown('$$\\frac{1}{2}$$');
    // KaTeX positions glyphs with inline style (e.g. height/vertical-align); if the
    // sanitizer stripped style=, the equation would collapse.
    expect(html).toMatch(/style="[^"]*height/);
  });

  it('leaves currency-looking text alone (strict delimiters)', () => {
    const html = renderMarkdown('It costs $5 and $10 total.');
    expect(html).not.toContain('class="katex"');
    expect(html).toContain('$5');
    expect(html).toContain('$10');
  });

  it('degrades a currency-before-equation collision to plain text, not a red error box', () => {
    // The leading currency $ greedily pairs with the equation's opening $, making
    // invalid TeX. softenKatexErrors() must keep that from rendering a red box that
    // swallows the user's prose.
    const html = renderMarkdown('It costs $5, and the model is $P = P_0 e^{rt}$.');
    expect(html).not.toContain('katex-error');
    expect(html).not.toContain('#cc0000');
    expect(html).toContain('the model is'); // prose survives, not consumed by an error span
  });

  it('softens an invalid-TeX error span to its source text', () => {
    const html = renderMarkdown('$\\frac{1}{2$');
    expect(html).not.toContain('katex-error');
    expect(html).not.toContain('#cc0000');
  });

  it('does not emit a javascript: link from \\href in math (KaTeX trust off)', () => {
    const html = renderMarkdown('$$\\href{javascript:alert(1)}{x}$$');
    // With trust off, KaTeX renders \href as inert text — never a real anchor. The
    // string may appear as text; what matters is that no executable link is produced.
    expect(html).not.toMatch(/<a\b/i);
    expect(html).not.toMatch(/href\s*=\s*["']?\s*javascript:/i);
  });

  it('invalid TeX does not throw and stays inline', () => {
    expect(() => renderMarkdown('$\\frac{1}{$')).not.toThrow();
  });
});
