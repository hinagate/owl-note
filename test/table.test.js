import { describe, it, expect } from 'vitest';
import {
  splitTableRow, tableRow, isSeparatorRow, isTableRowLine,
  tableCellSpans, tableCellTarget, normalizeTables, autoWidenTableAt,
} from '../src/lib/table.js';
import { renderMarkdown } from '../src/lib/markdown.js';

describe('table row primitives', () => {
  it('splits on pipes and trims each cell', () => {
    expect(splitTableRow('| a | b |')).toEqual(['a', 'b']);
  });

  it('keeps an escaped pipe inside its cell', () => {
    expect(splitTableRow('| cost \\| tax | b |')).toEqual(['cost \\| tax', 'b']);
  });

  it('rebuilds a row from cells', () => {
    expect(tableRow(['a', 'b'])).toBe('| a | b |');
  });

  it('recognises every delimiter spelling', () => {
    for (const row of ['| --- | --- |', '| :-- | --: |', '| :-: | ---- |']) {
      expect(isSeparatorRow(row)).toBe(true);
    }
    expect(isSeparatorRow('| a | b |')).toBe(false);
  });

  it('only treats pipe-delimited lines as rows', () => {
    expect(isTableRowLine('| a |')).toBe(true);
    expect(isTableRowLine('plain prose')).toBe(false);
    expect(isTableRowLine('a | b')).toBe(false); // no outer pipes
  });

  it('reports each cell\'s trimmed content bounds', () => {
    const line = '| ab | cd |';
    expect(tableCellSpans(line).map(([a, b]) => line.slice(a, b))).toEqual(['ab', 'cd']);
  });
});

// Typing a third header cell leaves the delimiter row two wide. GFM then refuses
// to parse the block at all, so the preview must repair it to stay readable.
const BROKEN = [
  '| title 1 | title 2 | title 3 |',
  '| --- | --- |',
  '|  |  |',
].join('\n');

describe('normalizeTables (forgiving render)', () => {
  it('widens a table broken by a hand-added header cell', () => {
    expect(normalizeTables(BROKEN).split('\n')).toEqual([
      '| title 1 | title 2 | title 3 |',
      '| --- | --- | --- |',
      '|  |  |  |',
    ]);
  });

  it('makes that table render again, with no button press', () => {
    expect(renderMarkdown(BROKEN)).toContain('<table>');
    expect(renderMarkdown(BROKEN)).toContain('<th>title 3</th>');
  });

  it('leaves a well-formed table byte-identical', () => {
    const good = '| a | b |\n| --- | --- |\n| 1 | 2 |';
    expect(normalizeTables(good)).toBe(good);
  });

  it('is idempotent', () => {
    const once = normalizeTables(BROKEN);
    expect(normalizeTables(once)).toBe(once);
  });

  it('never invents a table out of prose that merely contains pipes', () => {
    const prose = '| a | b |\n| c | d |'; // no delimiter row -> not a table
    expect(normalizeTables(prose)).toBe(prose);
    expect(renderMarkdown(prose)).not.toContain('<table>');
  });

  it('leaves pipe lines inside a fenced code block completely alone', () => {
    const fenced = ['```', '| a | b | c |', '| --- | --- |', '```'].join('\n');
    expect(normalizeTables(fenced)).toBe(fenced);
  });

  it('repairs a table that follows a fenced block', () => {
    const body = ['```', 'code | here', '```', '', ...BROKEN.split('\n')].join('\n');
    expect(normalizeTables(body)).toContain('| --- | --- | --- |');
  });

  it('handles two separate tables in one note', () => {
    const body = `${BROKEN}\n\n| x | y | z |\n| --- | --- |\n| 1 | 2 | 3 |`;
    const out = normalizeTables(body);
    expect(out.split('\n').filter((l) => l === '| --- | --- | --- |')).toHaveLength(2);
  });

  it('passes through text with no pipes untouched', () => {
    expect(normalizeTables('just prose')).toBe('just prose');
  });

  it('preserves existing cell content while widening', () => {
    const body = '| a | b | c |\n| --- | --- |\n| 1 | 2 |';
    expect(normalizeTables(body).split('\n')[2]).toBe('| 1 | 2 |  |');
  });
});

describe('autoWidenTableAt (rewrites the note while typing)', () => {
  // The reported case: a third header cell typed by hand, with the rows below
  // left two wide. They should gain their empty cells without any button press.
  const TYPED = [
    '| title 1 | title 2 | xxx|',
    '| --- | --- |',
    '|  |  |',
    '|  |  ',
  ].join('\n');

  it('fills every row out to the new header width', () => {
    const caret = TYPED.indexOf('xxx') + 3; // caret right where the user is typing
    const edit = autoWidenTableAt(TYPED, caret);
    const out = TYPED.slice(0, edit.replaceStart) + edit.insert + TYPED.slice(edit.replaceEnd);
    expect(out.split('\n')).toEqual([
      '| title 1 | title 2 | xxx |',
      '| --- | --- | --- |',
      '|  |  |  |',
      '|  |  |  |',
    ]);
  });

  it('leaves the caret exactly where the user was typing', () => {
    const caret = TYPED.indexOf('xxx') + 3;
    const edit = autoWidenTableAt(TYPED, caret);
    const out = TYPED.slice(0, edit.replaceStart) + edit.insert + TYPED.slice(edit.replaceEnd);
    expect(out.slice(0, edit.selStart)).toBe('| title 1 | title 2 | xxx');
  });

  it('remaps the caret when rows ABOVE it grow', () => {
    const body = '| a | b | c |\n| --- | --- |\n| 1 | 2 |';
    const caret = body.indexOf('2');
    const edit = autoWidenTableAt(body, caret);
    const out = body.slice(0, edit.replaceStart) + edit.insert + body.slice(edit.replaceEnd);
    expect(out[edit.selStart]).toBe('2'); // still sitting on the same character
  });

  it('is null once every row already matches', () => {
    expect(autoWidenTableAt('| a | b |\n| --- | --- |\n| 1 | 2 |', 3)).toBeNull();
  });

  it('is null outside a table', () => {
    expect(autoWidenTableAt('plain prose', 4)).toBeNull();
  });

  it('will not touch a block with no delimiter row', () => {
    expect(autoWidenTableAt('| a | b | c |\n| 1 | 2 |', 3)).toBeNull();
  });
});

const TABLE = '| one | two |\n| --- | --- |\n| aa | bb |';

describe('tableCellTarget (Tab between cells)', () => {
  const at = (text) => TABLE.indexOf(text);
  const sel = (move) => TABLE.slice(move.selStart, move.selEnd);

  it('is null outside a table, so Tab keeps moving focus', () => {
    expect(tableCellTarget('plain prose', 3, 3, true)).toBeNull();
  });

  it('moves to the next cell and selects it', () => {
    expect(sel(tableCellTarget(TABLE, at('one'), at('one'), true))).toBe('two');
  });

  it('moves back to the previous cell', () => {
    expect(sel(tableCellTarget(TABLE, at('two'), at('two'), false))).toBe('one');
  });

  // The delimiter row is structure, not data — Tab must step straight over it.
  it('skips the delimiter row going forward, header to first data row', () => {
    const from = at('two');
    expect(sel(tableCellTarget(TABLE, from, from, true))).toBe('aa');
  });

  it('skips the delimiter row going backward, first data row to header', () => {
    const from = at('aa');
    expect(sel(tableCellTarget(TABLE, from, from, false))).toBe('two');
  });

  it('walks the whole table left to right, never landing on ---', () => {
    const visited = [];
    let pos = at('one');
    for (let i = 0; i < 3; i++) {
      const move = tableCellTarget(TABLE, pos, pos, true);
      visited.push(TABLE.slice(move.selStart, move.selEnd));
      pos = move.selStart;
    }
    expect(visited).toEqual(['two', 'aa', 'bb']);
  });

  it('opens a new row when tabbing past the last cell', () => {
    const from = at('bb');
    const move = tableCellTarget(TABLE, from, from, true);
    expect(move.insert).toBe('\n|  |  |');
    expect(TABLE.slice(0, move.replaceStart) + move.insert).toBe(`${TABLE}\n|  |  |`);
  });

  it('opens the new row below the delimiter, not inside the table', () => {
    const header = '| a | b |\n| --- | --- |'; // header + delimiter only
    const from = header.indexOf('b');
    const move = tableCellTarget(header, from, from, true);
    expect(header.slice(0, move.replaceStart) + move.insert).toBe(`${header}\n|  |  |`);
  });

  // Without this, Tab would be trapped in the textarea with no keyboard escape.
  it('returns null for Shift+Tab in the very first cell', () => {
    expect(tableCellTarget(TABLE, at('one'), at('one'), false)).toBeNull();
  });

  it('ignores Tab when there is a selection', () => {
    expect(tableCellTarget(TABLE, 0, 6, true)).toBeNull();
  });

  it('lands in an empty cell rather than skipping it', () => {
    const body = '| a |  |\n| --- | --- |';
    const move = tableCellTarget(body, 2, 2, true);
    expect(move.selStart).toBe(move.selEnd); // empty cell -> caret, nothing selected
    expect(body[move.selStart]).toBe('|');   // sitting inside the cell, before its closing pipe
    expect(body.slice(0, move.selStart)).toBe('| a |  ');
  });
});
