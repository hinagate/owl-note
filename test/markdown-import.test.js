import { describe, it, expect } from 'vitest';
import { parseMarkdownNote } from '../src/lib/markdown-import.js';

describe('parseMarkdownNote', () => {
  it('reads our frontmatter and keeps the body untouched', () => {
    const text = '---\ntitle: "Pumpkin Soup"\nnotebook: "Recipes"\nid: "abc-123"\n---\n\n# Pumpkin Soup\nyum';
    const r = parseMarkdownNote(text, 'Pumpkin Soup.md');
    expect(r.meta).toEqual({ title: 'Pumpkin Soup', notebook: 'Recipes', id: 'abc-123' });
    expect(r.title).toBe('Pumpkin Soup');
    expect(r.body).toBe('# Pumpkin Soup\nyum');
  });

  it('JSON-unquotes escaped frontmatter values (round-trips the exporter)', () => {
    const text = '---\ntitle: "A \\"quote\\": \\\\path"\nid: "i1"\n---\n\nbody';
    const r = parseMarkdownNote(text, 'x.md');
    expect(r.meta.title).toBe('A "quote": \\path');
  });

  it('falls back to the first heading when there is no title frontmatter', () => {
    const r = parseMarkdownNote('# My Heading\n\ntext', 'whatever.md');
    expect(r.title).toBe('My Heading');
    expect(r.meta.id).toBeUndefined();
    expect(r.body).toBe('# My Heading\n\ntext');
  });

  it('falls back to the filename (no frontmatter, no heading)', () => {
    const r = parseMarkdownNote('just text', 'My Note.md');
    expect(r.title).toBe('My Note');
    expect(r.body).toBe('just text');
  });

  it('ignores foreign frontmatter keys but drops them from the body', () => {
    const text = '---\ntags: a, b\naliases: x\n---\n\nthe body';
    const r = parseMarkdownNote(text, 'f.md');
    expect(r.meta.title).toBeUndefined();
    expect(r.meta.notebook).toBeUndefined();
    expect(r.body).toBe('the body');
    expect(r.title).toBe('f');
  });
});
