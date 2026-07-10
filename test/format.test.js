import { describe, it, expect } from 'vitest';
import { toggleInline, cycleHeading } from '../src/lib/format.js';

// Apply an edit object to a body string — the same splice editor.js performs.
export function applyEdit(body, edit) {
  return body.slice(0, edit.replaceStart) + edit.insert + body.slice(edit.replaceEnd);
}

describe('toggleInline', () => {
  const BOLD = { left: '**', right: '**' };

  it('wraps a plain selection', () => {
    const e = toggleInline('hello world', 0, 5, BOLD);
    expect(applyEdit('hello world', e)).toBe('**hello** world');
    expect([e.selStart, e.selEnd]).toEqual([2, 7]); // "hello" stays selected
  });

  it('unwraps when the markers sit just OUTSIDE the selection', () => {
    const e = toggleInline('**hello** world', 2, 7, BOLD);
    expect(applyEdit('**hello** world', e)).toBe('hello world');
    expect([e.selStart, e.selEnd]).toEqual([0, 5]);
  });

  it('unwraps when the markers are INSIDE the selection', () => {
    const e = toggleInline('**hello** world', 0, 9, BOLD);
    expect(applyEdit('**hello** world', e)).toBe('hello world');
    expect([e.selStart, e.selEnd]).toEqual([0, 5]);
  });

  it('collapsed caret inserts the pair with the caret between', () => {
    const e = toggleInline('ab', 1, 1, BOLD);
    expect(applyEdit('ab', e)).toBe('a****b');
    expect([e.selStart, e.selEnd]).toEqual([3, 3]);
  });

  it('collapsed toggle twice is a no-op (second press removes the empty pair)', () => {
    const first = toggleInline('ab', 1, 1, BOLD);
    const between = applyEdit('ab', first); // 'a****b', caret at 3
    const second = toggleInline(between, first.selStart, first.selEnd, BOLD);
    expect(applyEdit(between, second)).toBe('ab');
  });

  it('leaves edge whitespace OUTSIDE the markers (** word** does not parse)', () => {
    const e = toggleInline('word  x', 0, 5, BOLD); // selection is "word "
    expect(applyEdit('word  x', e)).toBe('**word**  x');
  });

  it('works with asymmetric HTML markers (underline, highlight)', () => {
    const u = toggleInline('term', 0, 4, { left: '<u>', right: '</u>' });
    expect(applyEdit('term', u)).toBe('<u>term</u>');
    expect([u.selStart, u.selEnd]).toEqual([3, 7]);
    const back = toggleInline('<u>term</u>', 3, 7, { left: '<u>', right: '</u>' });
    expect(applyEdit('<u>term</u>', back)).toBe('term');
  });

  it('clamps out-of-range and reversed selections', () => {
    const e = toggleInline('ab', 99, -5, BOLD); // reversed + out of range -> full string
    expect(applyEdit('ab', e)).toBe('**ab**');
  });
});

describe('cycleHeading', () => {
  it('cycles none -> # -> ## -> ### -> none', () => {
    expect(applyEdit('title', cycleHeading('title', 0))).toBe('# title');
    expect(applyEdit('# title', cycleHeading('# title', 0))).toBe('## title');
    expect(applyEdit('## title', cycleHeading('## title', 0))).toBe('### title');
    expect(applyEdit('### title', cycleHeading('### title', 0))).toBe('title');
  });

  it('#### and deeper cycle back to plain text', () => {
    expect(applyEdit('#### deep', cycleHeading('#### deep', 0))).toBe('deep');
  });

  it('only touches the caret line', () => {
    expect(applyEdit('a\nb', cycleHeading('a\nb', 2))).toBe('a\n# b');
  });

  it('does NOT treat unspaced #tag as a heading (tidy-markdown parity)', () => {
    expect(applyEdit('#tag', cycleHeading('#tag', 0))).toBe('# #tag');
  });

  it('caret at position 0 on an empty first line edits THAT line, not the next', () => {
    expect(applyEdit('\na', cycleHeading('\na', 0))).toBe('# \na');
  });
});
