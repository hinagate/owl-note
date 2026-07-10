import { describe, it, expect } from 'vitest';
import { toggleInline, cycleHeading, toggleLinePrefix, toggleOrderedList, insertLink } from '../src/lib/format.js';

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

  it('caret INSIDE a marked span unwraps the whole span (Word-style toggle)', () => {
    const e = toggleInline('**hello** world', 4, 4, BOLD);
    expect(applyEdit('**hello** world', e)).toBe('hello world');
    expect([e.selStart, e.selEnd]).toEqual([2, 2]); // caret stays between 'he|llo'
  });

  it('partial selection inside a marked span unwraps the whole span', () => {
    const e = toggleInline('**hello** world', 3, 6, BOLD);
    expect(applyEdit('**hello** world', e)).toBe('hello world');
    expect([e.selStart, e.selEnd]).toEqual([1, 4]); // 'ell' stays selected
  });

  it('caret inside an HTML-marker span unwraps it', () => {
    const e = toggleInline('<u>term</u> x', 5, 5, { left: '<u>', right: '</u>' });
    expect(applyEdit('<u>term</u> x', e)).toBe('term x');
    expect([e.selStart, e.selEnd]).toEqual([2, 2]);
  });

  it('an italic scan never pairs with half of a bold marker', () => {
    const e = toggleInline('**hello** world', 4, 4, { left: '*', right: '*' });
    expect(applyEdit('**hello** world', e)).toBe('**he**llo** world'); // falls through to collapsed insert, unchanged behavior
  });

  it('caret in unmarked text still inserts an empty pair (spec behavior unchanged)', () => {
    const e = toggleInline('plain', 2, 2, BOLD);
    expect(applyEdit('plain', e)).toBe('pl****ain');
  });

  it('a span on a different line does not capture the caret', () => {
    const e = toggleInline('**a**\nb', 7, 7, BOLD);
    expect(applyEdit('**a**\nb', e)).toBe('**a**\nb****');
  });

  it('picks the correct span when the line has several', () => {
    const e = toggleInline('**a** b **c**', 10, 10, BOLD); // caret inside 'c'
    expect(applyEdit('**a** b **c**', e)).toBe('**a** b c');
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

describe('toggleLinePrefix (bullet / quote)', () => {
  it('bullets every selected line and selects the block', () => {
    const e = toggleLinePrefix('a\nb', 0, 3, 'bullet');
    expect(applyEdit('a\nb', e)).toBe('- a\n- b');
    expect([e.selStart, e.selEnd]).toEqual([0, 7]);
  });

  it('toggles off when ALL selected lines are bulleted (round-trip)', () => {
    const on = toggleLinePrefix('a\nb', 0, 3, 'bullet');
    const body = applyEdit('a\nb', on);
    const off = toggleLinePrefix(body, on.selStart, on.selEnd, 'bullet');
    expect(applyEdit(body, off)).toBe('a\nb');
  });

  it('mixed lines: fills in the missing bullets, leaves existing ones alone', () => {
    expect(applyEdit('- a\nb', toggleLinePrefix('- a\nb', 0, 5, 'bullet'))).toBe('- a\n- b');
  });

  it('skips blank lines inside the block', () => {
    expect(applyEdit('a\n\nb', toggleLinePrefix('a\n\nb', 0, 4, 'bullet'))).toBe('- a\n\n- b');
  });

  it('bullets an empty caret line (so the button works on a fresh line)', () => {
    expect(applyEdit('', toggleLinePrefix('', 0, 0, 'bullet'))).toBe('- ');
  });

  it('inserts after leading indent', () => {
    expect(applyEdit('  x', toggleLinePrefix('  x', 0, 3, 'bullet'))).toBe('  - x');
  });

  it('a selection ending exactly at a line start does not pull in the next line', () => {
    expect(applyEdit('a\nb', toggleLinePrefix('a\nb', 0, 2, 'bullet'))).toBe('- a\nb');
  });

  it('quote uses "> "', () => {
    expect(applyEdit('a', toggleLinePrefix('a', 0, 1, 'quote'))).toBe('> a');
  });

  it('caret at position 0 on an empty first line bullets THAT line, not the next', () => {
    expect(applyEdit('\na', toggleLinePrefix('\na', 0, 0, 'bullet'))).toBe('- \na');
  });
});

describe('toggleOrderedList', () => {
  it('numbers lines 1..n', () => {
    expect(applyEdit('a\nb\nc', toggleOrderedList('a\nb\nc', 0, 5))).toBe('1. a\n2. b\n3. c');
  });

  it('toggles numbering off when all lines are numbered', () => {
    expect(applyEdit('1. a\n2. b', toggleOrderedList('1. a\n2. b', 0, 9))).toBe('a\nb');
  });

  it('renumbers a mixed block cleanly', () => {
    expect(applyEdit('5. a\nb', toggleOrderedList('5. a\nb', 0, 6))).toBe('1. a\n2. b');
  });
});

describe('insertLink', () => {
  it('turns a selection into the link text and selects the url slot', () => {
    const e = insertLink('pick me', 0, 4);
    const body = applyEdit('pick me', e);
    expect(body).toBe('[pick](url) me');
    expect(body.slice(e.selStart, e.selEnd)).toBe('url');
  });

  it('collapsed caret inserts a placeholder with the text slot selected', () => {
    const e = insertLink('x', 1, 1);
    const body = applyEdit('x', e);
    expect(body).toBe('x[text](url)');
    expect(body.slice(e.selStart, e.selEnd)).toBe('text');
  });
});

describe('insertLink toggle-off', () => {
  it('clicking Link again with the url placeholder still selected unwraps back', () => {
    const on = insertLink('pick me', 0, 4);            // '[pick](url) me', 'url' selected
    const body = applyEdit('pick me', on);
    const off = insertLink(body, on.selStart, on.selEnd);
    expect(applyEdit(body, off)).toBe('pick me');
  });

  it('caret anywhere inside an existing link unwraps it to its text', () => {
    const body = 'a [b](https://c.d) e';
    const e = insertLink(body, 3, 3); // caret on the link text 'b'
    expect(applyEdit(body, e)).toBe('a b e');
    expect([e.selStart, e.selEnd]).toEqual([2, 2]);
  });

  it('a selection spanning the whole link unwraps it', () => {
    const body = '[pick](https://x.y) me';
    const e = insertLink(body, 0, 19);
    expect(applyEdit(body, e)).toBe('pick me');
  });

  it('never unwraps an image/attachment ref — no-op instead', () => {
    expect(insertLink('![shot](owl-img:abc) x', 3, 3)).toBeNull();
  });

  it('a link on another line does not capture the caret', () => {
    const body = '[a](https://b.c)\nplain';
    const e = insertLink(body, 19, 19); // caret in 'plain', after 'pl'
    expect(applyEdit(body, e)).toBe('[a](https://b.c)\npl[text](url)ain');
  });
});

describe('list buttons vs headings (skip rule)', () => {
  it('numbering a whole note keeps the title a title', () => {
    const note = '## Title\n\na\nb';
    const e = toggleOrderedList(note, 0, note.length);
    expect(applyEdit(note, e)).toBe('## Title\n\n1. a\n2. b');
  });

  it('bullet skips heading lines too', () => {
    const e = toggleLinePrefix('## T\na', 0, 6, 'bullet');
    expect(applyEdit('## T\na', e)).toBe('## T\n- a');
  });

  it('list button on a heading-only selection is a no-op (null)', () => {
    expect(toggleLinePrefix('## T', 0, 4, 'bullet')).toBeNull();
    expect(toggleOrderedList('## T', 0, 4)).toBeNull();
  });

  it('round-trips: toggle off strips numbers but leaves the heading', () => {
    const on = '## T\n1. a\n2. b';
    const e = toggleOrderedList(on, 0, on.length);
    expect(applyEdit(on, e)).toBe('## T\na\nb');
  });

  it('a #tag line is content, not a heading — it gets numbered', () => {
    const e = toggleOrderedList('#tag\nx', 0, 6);
    expect(applyEdit('#tag\nx', e)).toBe('1. #tag\n2. x');
  });

  it('quote still applies to headings (quoting a title is legitimate)', () => {
    const e = toggleLinePrefix('## T', 0, 4, 'quote');
    expect(applyEdit('## T', e)).toBe('> ## T');
  });

  it('list markers insert AFTER a quote run, and round-trip', () => {
    const on = toggleLinePrefix('> x', 0, 3, 'bullet');
    expect(applyEdit('> x', on)).toBe('> - x');
    const off = toggleLinePrefix('> - x', 0, 5, 'bullet');
    expect(applyEdit('> - x', off)).toBe('> x');
  });
});

describe('heading button composes with structure prefixes', () => {
  it('H on a list line puts the heading inside the item', () => {
    expect(applyEdit('1. item', cycleHeading('1. item', 0))).toBe('1. # item');
  });

  it('cycles within the item and returns to plain', () => {
    expect(applyEdit('1. ### item', cycleHeading('1. ### item', 0))).toBe('1. item');
  });

  it('H on a quoted line stays inside the quote', () => {
    expect(applyEdit('> x', cycleHeading('> x', 0))).toBe('> # x');
  });

  it('indent is preserved outside the heading marker', () => {
    expect(applyEdit('  x', cycleHeading('  x', 0))).toBe('  # x');
  });
});
