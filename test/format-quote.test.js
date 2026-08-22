// Test cases for the Quote button (❝) in the format bar.
//
// The button is `toggleLinePrefix(body, start, end, 'quote')` wired through
// applyFormat -> insertText. Its rule: if EVERY non-blank line in the selected
// line-block already carries the prefix, strip one level; otherwise add it to the
// lines that lack it. Detection accepts `>` with or without the following space —
// CommonMark and our renderer both treat `>text` as a blockquote, and a `> `-only
// test made the button add a SECOND level to a line that was already quoted.
import { describe, it, expect } from 'vitest';
import { toggleLinePrefix } from '../src/lib/format.js';
import { renderMarkdown } from '../src/lib/markdown.js';

// Apply the returned edit the way applyFormat does, so these assert what the user
// would actually see in the textarea rather than the raw edit descriptor.
const quote = (body, start, end) => {
  const edit = toggleLinePrefix(body, start, end === undefined ? start : end, 'quote');
  if (!edit) return body;
  return body.slice(0, edit.replaceStart) + edit.insert + body.slice(edit.replaceEnd);
};
const quoteAll = (body) => quote(body, 0, body.length);

describe('Quote button — positive cases', () => {
  it('P1 quotes the caret line with no selection', () => {
    expect(quote('hello world', 5, 5)).toBe('> hello world');
  });

  it('P2 quotes a fully selected single line', () => {
    expect(quoteAll('hello')).toBe('> hello');
  });

  it('P3 quotes every line of a multi-line selection', () => {
    expect(quoteAll('a\nb\nc')).toBe('> a\n> b\n> c');
  });

  it('P4/P5 removes the prefix when every selected line already has it', () => {
    expect(quoteAll('> hello')).toBe('hello');
    expect(quoteAll('> a\n> b')).toBe('a\nb');
  });

  // The asymmetry is deliberate: a mixed selection means "make these quoted", so it
  // levels up rather than toggling off and losing the user's existing quotes.
  it('P6 adds to a mixed selection instead of removing, leaving quoted lines alone', () => {
    expect(quoteAll('> a\nb')).toBe('> a\n> b');
  });

  it('P7/P8 puts the prefix after the indent, preserving spaces and tabs', () => {
    expect(quoteAll('    code')).toBe('    > code');
    expect(quoteAll('\ttabbed')).toBe('\t> tabbed');
  });

  it('P9 keeps the indent when removing', () => {
    expect(quoteAll('    > x')).toBe('    x');
  });

  // Unlike the list buttons, which skip headings, quoting one is legitimate markdown.
  it('P10 quotes a heading', () => {
    expect(quoteAll('# Title')).toBe('> # Title');
  });

  it('P11 removes exactly one level from a nested quote', () => {
    expect(quoteAll('> > deep')).toBe('> deep');
  });

  it('P12 leaves a blank line inside the block untouched', () => {
    expect(quoteAll('a\n\nb')).toBe('> a\n\n> b');
  });

  it('P13 starts a quote on an empty body', () => {
    expect(quote('', 0, 0)).toBe('> ');
  });

  it('P14 selects the whole rewritten block', () => {
    const edit = toggleLinePrefix('a\nb', 0, 3, 'quote');
    expect(edit.selStart).toBe(edit.replaceStart);
    expect(edit.selEnd).toBe(edit.replaceStart + edit.insert.length);
  });

  it('P15 round-trips: pressing twice restores the original', () => {
    const body = 'a\nb';
    expect(quoteAll(quoteAll(body))).toBe(body);
  });
});

describe('Quote button — negative and malformed input', () => {
  it('N3 normalises a reversed selection instead of throwing', () => {
    expect(quote('hello', 5, 0)).toBe('> hello');
  });

  it('N4 clamps a selection past the end of the body', () => {
    expect(quote('hi', 99, 999)).toBe('> hi');
  });

  it('N5 clamps a negative start', () => {
    expect(quote('hi', -5, 1)).toBe('> hi');
  });

  it('N6 treats a missing end as a caret', () => {
    expect(quote('hello', 2, undefined)).toBe('> hello');
  });
});

describe('Quote button — edge cases', () => {
  // E1 was a real defect: the renderer already showed `>text` as a blockquote, but
  // the button did not recognise it and added a second level (`> >text`).
  it('E1 removes a quote written without the space after >', () => {
    expect(quoteAll('>hello')).toBe('hello');
    expect(quoteAll('>a\n>b')).toBe('a\nb');
  });

  it('E1b normalises the loose form to "> " when toggled back on', () => {
    expect(quoteAll(quoteAll('>hello'))).toBe('> hello');
  });

  it('E1c never turns one blockquote into two', () => {
    const depth = (md) => (renderMarkdown(md).match(/<blockquote/g) || []).length;
    for (const input of ['>hello', '> hello']) {
      expect(depth(input)).toBe(1);
      // Pressing Quote on an already-quoted line must reduce the depth, never raise it.
      expect(depth(quoteAll(input))).toBe(0);
    }
  });

  it('E2 clears a bare empty quote line', () => {
    expect(quoteAll('> ')).toBe('');
    expect(quoteAll('>')).toBe('');
  });

  it('E4 does not swallow a trailing newline', () => {
    expect(quote('a\n', 0, 2)).toBe('> a\n');
  });

  // lineBlock backs off a selection that ends exactly on a newline, so selecting a
  // line "to the end" does not silently quote the line after it too.
  it('E5 does not pull in the next line when the selection ends on a newline', () => {
    expect(quote('a\nb', 0, 2)).toBe('> a\nb');
  });

  it('E6 keeps CRLF line endings intact', () => {
    expect(quoteAll('a\r\nb')).toBe('> a\r\n> b');
  });

  it('E7/E8 handles CJK and emoji without splitting characters', () => {
    expect(quoteAll('中文字')).toBe('> 中文字');
    expect(quoteAll('👍 ok')).toBe('> 👍 ok');
  });

  it('E9 round-trips a fenced code block exactly', () => {
    const fence = '```js\nlet a = 1;\n```';
    const quoted = quoteAll(fence);
    expect(quoted).toBe('> ```js\n> let a = 1;\n> ```');
    expect(quoteAll(quoted)).toBe(fence);
  });
});

describe('Quote button — tables', () => {
  const table = '| Sym | Sounds |\n| --- | --- |\n| /b/ | boot |';

  it('T1 prefixes every row including the delimiter row', () => {
    expect(quoteAll(table)).toBe('> | Sym | Sounds |\n> | --- | --- |\n> | /b/ | boot |');
  });

  it('T2 round-trips a table byte-for-byte', () => {
    expect(quoteAll(quoteAll(table))).toBe(table);
  });

  // The point of quoting a table is that it still renders AS a table. A prefix that
  // broke the delimiter row would silently turn it into three lines of text.
  it('T3 still renders as a table, nested inside the blockquote', () => {
    const html = renderMarkdown(quoteAll(table));
    expect(html).toMatch(/<blockquote>[\s\S]*<table/);
    expect(html).toContain('</table>');
    expect(html).toContain('Sounds');
    expect(html).toContain('boot');
  });

  it('T4 quoting only the delimiter row breaks the table, as markdown dictates', () => {
    const delimStart = table.indexOf('\n') + 1;
    const delimEnd = table.indexOf('\n', delimStart);
    const out = quote(table, delimStart, delimEnd);
    expect(out).toContain('> | --- | --- |');
    expect(renderMarkdown(out)).not.toMatch(/<table/);
  });
});

describe('quote formatting — still reachable in markdown, no longer a button', () => {
  // The toolbar button was replaced by Reference. toggleLinePrefix('quote') stays
  // covered because Save-selection still GENERATES blockquotes (quick-note.js), so
  // the parsing rules below still decide whether those notes can be cleaned up.
  it('R5 pins the nesting asymmetry: removal steps one level, adding never nests', () => {
    expect(quoteAll('> > deep')).toBe('> deep');
    expect(quoteAll('> a\n> b')).toBe('a\nb');
  });

  it('R6 never places the prefix before the indent', () => {
    expect(quoteAll('  x')).toBe('  > x');
    expect(quoteAll('\tx')).toBe('\t> x');
    expect(quoteAll('    > x')).toBe('    x');
    expect(quoteAll('   >x')).toBe('   x');
  });
});
