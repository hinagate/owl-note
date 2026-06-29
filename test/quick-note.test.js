import { describe, it, expect } from 'vitest';
import { buildQuickNote } from '../src/lib/quick-note.js';

describe('buildQuickNote', () => {
  it('selection + a markdown source link', () => {
    expect(buildQuickNote({ title: 'Wiki', url: 'https://w/p', selection: 'cats' }))
      .toEqual({ title: 'Wiki', body: 'cats\n\n[Wiki](https://w/p)' });
  });
  it('no selection -> just the source link', () => {
    expect(buildQuickNote({ title: 'Wiki', url: 'https://w/p', selection: '' }).body)
      .toBe('[Wiki](https://w/p)');
  });
  it('no url -> just the selection, no link', () => {
    expect(buildQuickNote({ title: '', url: '', selection: 'note' })).toEqual({ title: '', body: 'note' });
  });
  it('trims and defaults missing fields', () => {
    expect(buildQuickNote()).toEqual({ title: '', body: '' });
    expect(buildQuickNote({ title: '  T  ', selection: '  s  ' })).toEqual({ title: 'T', body: 's' });
  });
  it('falls back to the url as the link label when title is blank', () => {
    expect(buildQuickNote({ url: 'https://w/p', selection: 'x' }).body)
      .toBe('x\n\n[https://w/p](https://w/p)');
  });
});
