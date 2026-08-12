import { describe, it, expect } from 'vitest';
import { blockRanges, refineOffset, blockIndexOf } from '../src/lib/source-map.js';
import { renderMarkdown } from '../src/lib/markdown.js';

const NOTE = [
  '# Title',
  '',
  'First paragraph with **bold** text.',
  '',
  '- alpha',
  '- beta',
  '',
  '```js',
  'const x = 1;',
  '```',
  '',
  '## 中文小節',
  '',
  '最後一段內容。',
].join('\n');

describe('blockRanges', () => {
  it('gives an offset for every block that renders', () => {
    const ranges = blockRanges(NOTE);
    expect(ranges.map((r) => r.type)).toEqual(['heading', 'paragraph', 'list', 'code', 'heading', 'paragraph']);
  });

  // The whole feature rests on this: a range must slice the original text back out.
  it('each range slices its own source back out of the note', () => {
    for (const r of blockRanges(NOTE)) {
      expect(NOTE.slice(r.start, r.end).trim()).not.toBe('');
    }
    const [heading, para] = blockRanges(NOTE);
    expect(NOTE.slice(heading.start, heading.end)).toContain('# Title');
    expect(NOTE.slice(para.start, para.end)).toContain('First paragraph');
  });

  it('ranges are ordered, non-overlapping, and inside the note', () => {
    const ranges = blockRanges(NOTE);
    let prevEnd = 0;
    for (const r of ranges) {
      expect(r.start).toBeGreaterThanOrEqual(prevEnd);
      expect(r.end).toBeGreaterThan(r.start);
      expect(r.end).toBeLessThanOrEqual(NOTE.length);
      prevEnd = r.end;
    }
  });

  // One block of source must equal one top-level element, or index lookup is wrong.
  it('produces one range per rendered top-level element', () => {
    const host = document.createElement('div');
    host.innerHTML = renderMarkdown(NOTE);
    expect(host.children.length).toBe(blockRanges(NOTE).length);
  });

  it('survives empty and malformed input instead of throwing', () => {
    expect(blockRanges('')).toEqual([]);
    expect(blockRanges(null)).toEqual([]);
    expect(blockRanges(undefined)).toEqual([]);
    expect(Array.isArray(blockRanges('| ragged |\n| -- |\n| a | b |'))).toBe(true);
  });
});

describe('refineOffset', () => {
  const ranges = blockRanges(NOTE);
  const para = ranges[1];

  it('lands on the exact words when they appear verbatim', () => {
    const spot = refineOffset(NOTE, para, 'paragraph with');
    expect(NOTE.slice(spot.start, spot.end)).toBe('paragraph with');
  });

  // Rendered text has lost its markup, so an exact match usually fails.
  it('falls back to the longest leading run that does match', () => {
    const spot = refineOffset(NOTE, para, 'First paragraph with bold text.');
    expect(spot.start).toBeGreaterThanOrEqual(para.start);
    expect(NOTE.slice(spot.start)).toMatch(/^First paragraph with/);
  });

  it('returns the block start when nothing matches, never null', () => {
    const spot = refineOffset(NOTE, para, 'zzz qqq wwq vvq');
    expect(spot).toEqual({ start: para.start, end: para.start });
  });

  // The leading run is what anchors: a needle beginning with a word that IS in the
  // block lands on that word, which is where the reader clicked.
  it('anchors on the first word of the clicked text when the rest diverges', () => {
    const spot = refineOffset(NOTE, para, 'bold text that diverges after this');
    expect(NOTE.slice(spot.start, spot.end)).toBe('bold');
  });

  it('handles CJK, which has no spaces to split on', () => {
    const cjk = ranges[ranges.length - 1];
    const spot = refineOffset(NOTE, cjk, '最後一段');
    expect(NOTE.slice(spot.start, spot.end)).toBe('最後一段');
  });

  it('is safe with empty input and a missing range', () => {
    expect(refineOffset(NOTE, null, 'x')).toBeNull();
    expect(refineOffset(NOTE, para, '')).toEqual({ start: para.start, end: para.start });
  });
});

describe('blockIndexOf', () => {
  const build = () => {
    const root = document.createElement('div');
    root.innerHTML = '<h1>T</h1><p>one <em>two</em></p><ul><li>x</li></ul>';
    return root;
  };

  it('finds the top-level block for a deeply nested click target', () => {
    const root = build();
    expect(blockIndexOf(root, root.querySelector('em'))).toBe(1);
    expect(blockIndexOf(root, root.querySelector('li'))).toBe(2);
    expect(blockIndexOf(root, root.querySelector('h1'))).toBe(0);
  });

  it('returns -1 for the root itself or a node outside it', () => {
    const root = build();
    expect(blockIndexOf(root, root)).toBe(-1);
    expect(blockIndexOf(root, document.createElement('p'))).toBe(-1);
    expect(blockIndexOf(null, root)).toBe(-1);
  });
});
