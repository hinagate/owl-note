import { describe, it, expect } from 'vitest';
import { searchNotes } from '../src/lib/search.js';

const notes = [
  { id: '1', title: 'Pasta recipe', body: 'boil water' },
  { id: '2', title: 'Sprint plan', body: 'discuss pasta sprint' },
  { id: '3', title: 'Other', body: 'nothing here' },
];

describe('search', () => {
  it('returns all for an empty query', () => {
    expect(searchNotes(notes, '')).toHaveLength(3);
  });

  it('matches title and body, title first', () => {
    const r = searchNotes(notes, 'pasta');
    expect(r.map((n) => n.id)).toEqual(['1', '2']);
  });

  it('is case-insensitive and excludes non-matches', () => {
    const r = searchNotes(notes, 'WATER');
    expect(r.map((n) => n.id)).toEqual(['1']);
  });

  it('ranks title matches before body matches regardless of input order', () => {
    const reversed = [
      { id: '2', title: 'Sprint plan', body: 'discuss pasta sprint' }, // body match, listed first
      { id: '1', title: 'Pasta recipe', body: 'boil water' },          // title match, listed second
    ];
    const r = searchNotes(reversed, 'pasta');
    expect(r.map((n) => n.id)).toEqual(['1', '2']);
  });
});
