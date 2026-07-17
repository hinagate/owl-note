import { describe, it, expect } from 'vitest';
import { buildQuickNote } from '../src/lib/quick-note.js';

describe('buildQuickNote', () => {
  it('quotes a plain-text fallback and adds an unambiguous source URL', () => {
    expect(buildQuickNote({ title: 'Wiki', url: 'https://w/p', selection: 'cats' }))
      .toEqual({ title: 'Wiki', body: '> cats\n\nSource: <https://w/p>' });
  });
  it('no selection -> just the source link', () => {
    expect(buildQuickNote({ title: 'Wiki', url: 'https://w/p', selection: '' }).body)
      .toBe('Source: <https://w/p>');
  });
  it('no url -> just the selection, no link', () => {
    expect(buildQuickNote({ title: '', url: '', selection: 'note' })).toEqual({ title: '', body: '> note' });
  });
  it('trims and defaults missing fields', () => {
    expect(buildQuickNote()).toEqual({ title: '', body: '' });
    expect(buildQuickNote({ title: '  T  ', selection: '  s  ' })).toEqual({ title: 'T', body: '> s' });
  });
  it('does not need a duplicate link label when title is blank', () => {
    expect(buildQuickNote({ url: 'https://w/p', selection: 'x' }).body)
      .toBe('> x\n\nSource: <https://w/p>');
  });
  it('prefers captured rich Markdown and normalizes the page title', () => {
    expect(buildQuickNote({
      title: '  NVIDIA   reasoning  ', url: 'https://developer.nvidia.com/blog/x', selection: 'plain',
      selectionMarkdown: 'A **formatted** paragraph.\n\n- one\n- two',
    })).toEqual({
      title: 'NVIDIA reasoning',
      body: 'A **formatted** paragraph.\n\n- one\n- two\n\nSource: <https://developer.nvidia.com/blog/x>',
    });
  });
});
