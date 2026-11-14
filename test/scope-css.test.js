import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { darkCodeTheme, scopeCss } from '../scripts/scope-css.mjs';

describe('scopeCss', () => {
  it('puts each rule under the scope', () => {
    expect(scopeCss('.a { color: red }', '.dark')).toBe('.dark .a { color: red }');
  });

  it('scopes every selector of a list', () => {
    const out = scopeCss('.a,\n.b .c { color: red }', '.dark');
    expect(out).toContain('.dark .a,');
    expect(out).toContain('.dark .b .c {');
  });

  it('keeps comments, the licence header among them', () => {
    const out = scopeCss('/*! Theme: X */\n.a { /* why */ color: red }', '.dark');
    expect(out).toContain('/*! Theme: X */');
    expect(out).toContain('/* why */');
    expect(out).toContain('.dark .a {');
  });

  it('can rewrite a declaration and leaves the others alone', () => {
    const out = scopeCss('.a { color: red; background: #000 }', '.dark', (property) => (property === 'background' ? 'none' : null));
    expect(out).toBe('.dark .a { color: red; background: none }');
  });

  // Scoping an at-rule's contents this way would produce CSS that means something else.
  it('refuses a stylesheet it cannot scope correctly', () => {
    expect(() => scopeCss('@media print { .a { color: red } }', '.dark')).toThrow(/at-rules/);
  });
});

describe('darkCodeTheme', () => {
  const css = darkCodeTheme(readFileSync('node_modules/highlight.js/styles/github-dark.css', 'utf8'));

  it('applies only while the app is dark', () => {
    const selectors = css.replace(/\/\*[\s\S]*?\*\//g, '').match(/[^{}]+(?=\{)/g).flatMap((list) => list.split(','));
    expect(selectors.length).toBeGreaterThan(20);
    for (const selector of selectors) expect(selector.trim()).toMatch(/^:root\[data-theme="dark"\] /);
  });

  it('keeps the code colours and drops the background, which the app draws itself', () => {
    expect(css).toMatch(/:root\[data-theme="dark"\] \.hljs \{\s*color: #c9d1d9;\s*background: transparent/);
    expect(css).toContain('#ff7b72'); // keywords
  });
});
