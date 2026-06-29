import { describe, it, expect } from 'vitest';
import { slug, buildMarkdownExport } from '../src/lib/markdown-export.js';

describe('slug', () => {
  it('strips path-illegal characters but keeps Unicode', () => {
    expect(slug('a/b:c*?"<>|d')).toBe('abcd');
    expect(slug('反彈分析')).toBe('反彈分析');
  });
  it('collapses whitespace and trims', () => {
    expect(slug('  hello   world  ')).toBe('hello world');
  });
  it('falls back to untitled for empty/illegal-only names', () => {
    expect(slug('')).toBe('untitled');
    expect(slug('   ')).toBe('untitled');
    expect(slug('///')).toBe('untitled');
  });
  it('drops a trailing dot or space (Windows-illegal)', () => {
    expect(slug('report.')).toBe('report');
    expect(slug('note ')).toBe('note');
  });
  it('strips ASCII control characters (U+0000-U+001F)', () => {
    // Built with fromCharCode so no raw control bytes live in this source file.
    const ctrl = String.fromCharCode(1) + String.fromCharCode(31) + String.fromCharCode(0);
    expect(slug('a' + ctrl + 'b')).toBe('ab');
  });
  it('keeps ordinary punctuation like hyphens and parentheses', () => {
    expect(slug('2024-01 (draft)')).toBe('2024-01 (draft)');
    expect(slug('a-b')).toBe('a-b');
  });
});

describe('buildMarkdownExport', () => {
  const root = 'r';

  it('puts notebook notes in a folder and root notes in Inbox/, body untouched', () => {
    const folders = [{ id: 'nb', title: 'Recipes', parentId: root }];
    const notes = [
      { id: 'i1', title: 'Soup', body: '# Soup\nyum', folderId: 'nb' },
      { id: 'i2', title: 'Loose', body: 'hi', folderId: root },
    ];
    const out = buildMarkdownExport(notes, folders, root);
    const byPath = Object.fromEntries(out.map((e) => [e.path, e.text]));
    expect(Object.keys(byPath).sort()).toEqual(['Inbox/Loose.md', 'Recipes/Soup.md']);
    expect(byPath['Recipes/Soup.md']).toBe(
      '---\ntitle: "Soup"\nnotebook: "Recipes"\nid: "i1"\n---\n\n# Soup\nyum',
    );
    expect(byPath['Inbox/Loose.md']).toBe(
      '---\ntitle: "Loose"\nnotebook: "Inbox"\nid: "i2"\n---\n\nhi',
    );
  });

  it('preserves nested notebook folders', () => {
    const folders = [
      { id: 'a', title: 'Work', parentId: root },
      { id: 'b', title: 'ProjectA', parentId: 'a' },
    ];
    const notes = [{ id: 'i1', title: 'Plan', body: 'x', folderId: 'b' }];
    const out = buildMarkdownExport(notes, folders, root);
    expect(out[0].path).toBe('Work/ProjectA/Plan.md');
    expect(out[0].text).toContain('notebook: "ProjectA"');
  });

  it('disambiguates same-title notes in one folder with a numeric suffix', () => {
    const folders = [{ id: 'nb', title: 'Recipes', parentId: root }];
    const notes = [
      { id: 'i1', title: 'Soup', body: 'a', folderId: 'nb' },
      { id: 'i2', title: 'Soup', body: 'b', folderId: 'nb' },
      { id: 'i3', title: 'Soup', body: 'c', folderId: 'nb' },
    ];
    const paths = buildMarkdownExport(notes, folders, root).map((e) => e.path);
    expect(paths).toEqual(['Recipes/Soup.md', 'Recipes/Soup 2.md', 'Recipes/Soup 3.md']);
  });

  it('escapes YAML-special characters in the title', () => {
    const notes = [{ id: 'i1', title: 'A "quote": \\path', body: 'x', folderId: root }];
    const text = buildMarkdownExport(notes, [], root)[0].text;
    expect(text).toContain('title: "A \\"quote\\": \\\\path"');
  });

  it('escapes a newline in the title so it cannot inject frontmatter keys', () => {
    const NL = String.fromCharCode(10); // built at runtime to keep the source single-line
    const notes = [{ id: 'i1', title: 'evil' + NL + 'notebook: hacked', body: 'x', folderId: root }];
    const text = buildMarkdownExport(notes, [], root)[0].text;
    // Frontmatter is the block before the closing `---`. The title's newline must be
    // escaped (not a literal break), so exactly one real `notebook:`/`title:` line exists.
    const fm = text.slice(0, text.indexOf(NL + '---' + NL));
    const lines = fm.split(NL);
    expect(lines.filter((l) => l.startsWith('title:')).length).toBe(1);
    expect(lines.filter((l) => l.startsWith('notebook:')).length).toBe(1);
  });
});
