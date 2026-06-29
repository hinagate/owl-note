import { describe, it, expect } from 'vitest';
import { createNote, extractTitle, contentHash, withUpdatedBody, withUpdatedContent, withPinned, orderNotes } from '../src/lib/note.js';

describe('note model', () => {
  it('extracts a title from the first heading', () => {
    expect(extractTitle('# Hello world\nbody')).toBe('Hello world');
    expect(extractTitle('\n\nplain first line\nmore')).toBe('plain first line');
    expect(extractTitle('   ')).toBe('Untitled');
    expect(extractTitle('x'.repeat(200))).toHaveLength(120);
  });

  it('creates a note with id, version 1, and a deterministic hash', () => {
    const n = createNote({ body: '# Title\ntext' });
    expect(n.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(n.version).toBe(1);
    expect(n.title).toBe('Title');
    expect(n.hash).toBe(contentHash('# Title\ntext'));
    expect(n.attachments).toEqual([]);
  });

  it('bumps version and recomputes title/hash on update', () => {
    const n = createNote({ body: 'old' });
    const u = withUpdatedBody(n, '# New', []);
    expect(u.version).toBe(2);
    expect(u.title).toBe('New');
    expect(u.hash).toBe(contentHash('# New'));
    expect(u.id).toBe(n.id);
  });

  it('createNote keeps an explicit title and falls back to extraction when blank', () => {
    expect(createNote({ title: 'My Title', body: '# Heading' }).title).toBe('My Title');
    expect(createNote({ title: '   ', body: '# Heading\nx' }).title).toBe('Heading');
  });

  it('withUpdatedContent sets the explicit title, bumps version, recomputes hash', () => {
    const n = createNote({ title: 'A', body: 'b' });
    const u = withUpdatedContent(n, { title: 'B', body: 'c', attachments: [] });
    expect(u.title).toBe('B');
    expect(u.version).toBe(2);
    expect(u.hash).toBe(contentHash('c'));
    expect(u.id).toBe(n.id);
    // blank title falls back to body extraction
    expect(withUpdatedContent(n, { title: '  ', body: '# Z' }).title).toBe('Z');
  });
});

describe('withPinned', () => {
  it('sets and clears pinned without touching version/hash', () => {
    const n = createNote({ title: 'A', body: 'x' });
    const pinned = withPinned(n, true);
    expect(pinned.pinned).toBe(true);
    expect(pinned.version).toBe(n.version);
    expect(pinned.hash).toBe(n.hash);
    expect(pinned.body).toBe(n.body);
    expect(withPinned(pinned, false).pinned).toBe(false);
  });
});

describe('orderNotes', () => {
  const note = (id, pinned) => ({ id, title: id, body: '', pinned });
  it('floats pinned to the top, keeps the rest stable', () => {
    const out = orderNotes([note('a'), note('b', true), note('c')], []);
    expect(out.map((n) => n.id)).toEqual(['b', 'a', 'c']);
  });
  it('orders recent (newest-first) below pinned and above the rest', () => {
    const out = orderNotes([note('a'), note('b'), note('c'), note('p', true)], ['c', 'a']);
    // pinned p; recent newest-first c then a; rest b
    expect(out.map((n) => n.id)).toEqual(['p', 'c', 'a', 'b']);
  });
  it('keeps input order when nothing is pinned or recent', () => {
    const out = orderNotes([note('a'), note('b'), note('c')], []);
    expect(out.map((n) => n.id)).toEqual(['a', 'b', 'c']);
  });
  it('does not mutate the input array', () => {
    const input = [note('a'), note('b', true)];
    orderNotes(input, []);
    expect(input.map((n) => n.id)).toEqual(['a', 'b']);
  });
});
