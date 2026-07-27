// src/lib/table.js
// GFM table primitives, shared by the editor's format bar (src/lib/format.js)
// and the renderer (src/lib/markdown.js). Pure: no DOM, no chrome APIs.
//
// The rule that makes this module necessary: a GFM table's delimiter row must
// have the same cell count as its header. Add one header cell by hand and the
// block stops parsing as a table at all — it renders as a paragraph of literal
// pipes, with nothing to explain why. So the count has to be repairable both
// on demand (the format bar's button) and forgivingly at render time.

// A table row: begins and ends with a pipe. Deliberately loose — this only
// finds candidate blocks; marked remains the authority on what really parses.
export const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
// A delimiter cell: ---, :--, --: or :-:.
const SEPARATOR_CELL_RE = /^:?-{1,}:?$/;

export function isTableRowLine(line) { return TABLE_ROW_RE.test(line); }

// Split '| a | b |' into ['a', 'b'], honouring \| escapes so an escaped pipe
// stays inside its cell instead of opening a new column.
export function splitTableRow(line) {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells = [];
  let cell = '';
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === '\\' && inner[i + 1] === '|') { cell += '\\|'; i += 1; continue; }
    if (inner[i] === '|') { cells.push(cell.trim()); cell = ''; continue; }
    cell += inner[i];
  }
  cells.push(cell.trim());
  return cells;
}

export function tableRow(cells) {
  return `| ${cells.join(' | ')} |`;
}

export function isSeparatorRow(line) {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((c) => SEPARATOR_CELL_RE.test(c));
}

// Content bounds of each cell within a row line, as [start, end) offsets with
// the padding spaces trimmed off. Used to move the caret cell to cell.
export function tableCellSpans(line) {
  const raw = [];
  let cellStart = null;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\') { i += 1; continue; }
    if (line[i] !== '|') continue;
    if (cellStart !== null) raw.push([cellStart, i]);
    cellStart = i + 1;
  }
  return raw.map(([a, b]) => {
    while (a < b && line[a] === ' ') a += 1;
    while (b > a && line[b - 1] === ' ') b -= 1;
    return [a, b];
  });
}

function lineBoundsAt(body, pos) {
  const start = pos === 0 ? 0 : body.lastIndexOf('\n', pos - 1) + 1;
  let end = body.indexOf('\n', start);
  if (end === -1) end = body.length;
  return [start, end];
}

// Tab / Shift+Tab inside a table: move to the next or previous cell, selecting
// its contents so typing replaces them. Runs off the end of a row into the next
// row, and off the end of the table into a fresh row.
//
// Returns null when the caret is not in a table — Tab then keeps its normal
// meaning and moves focus out of the field. Shift+Tab in the FIRST cell also
// returns null on purpose: without that, Tab would be trapped in the textarea
// with no keyboard way out.
export function tableCellTarget(body, start, end, forward = true) {
  if (start !== end) return null;
  const [lineStart, lineEnd] = lineBoundsAt(body, start);
  const line = body.slice(lineStart, lineEnd);
  if (!isTableRowLine(line)) return null;
  const spans = tableCellSpans(line);
  if (!spans.length) return null;

  const offset = start - lineStart;
  let index = spans.findIndex(([a, b]) => offset >= a && offset <= b);
  if (index === -1) index = offset < spans[0][0] ? 0 : spans.length - 1;

  const select = (from, span) => ({ selStart: from + span[0], selEnd: from + span[1] });

  if (forward) {
    if (index + 1 < spans.length) return select(lineStart, spans[index + 1]);
    // Past the last cell: drop into the row below, or open a new one.
    const [nextStart, nextEnd] = lineBoundsAt(body, lineEnd + 1);
    if (lineEnd < body.length && isTableRowLine(body.slice(nextStart, nextEnd))) {
      const nextSpans = tableCellSpans(body.slice(nextStart, nextEnd));
      if (nextSpans.length) return select(nextStart, nextSpans[0]);
    }
    const insert = `\n${tableRow(Array(spans.length).fill(''))}`;
    const caret = lineEnd + 3; // past the new row's '| '
    return { replaceStart: lineEnd, replaceEnd: lineEnd, insert, selStart: caret, selEnd: caret };
  }

  if (index > 0) return select(lineStart, spans[index - 1]);
  if (lineStart === 0) return null; // first cell of the first row — let Tab escape
  const [prevStart, prevEnd] = lineBoundsAt(body, lineStart - 1);
  const prevLine = body.slice(prevStart, prevEnd);
  if (!isTableRowLine(prevLine)) return null;
  const prevSpans = tableCellSpans(prevLine);
  return prevSpans.length ? select(prevStart, prevSpans[prevSpans.length - 1]) : null;
}

// ``` fence lines toggle a protected region. Content inside a fence is left
// completely alone — a code sample full of pipe characters is NOT a table.
const FENCE_MARKER = /^```/;

// Widen every row of each table block to its widest row, so a table the user
// broke by adding a header cell still renders. Deliberately CONSERVATIVE
// compared with the format bar's explicit repair: this only touches blocks that
// already have a delimiter row in second position, so ordinary prose containing
// pipes is never silently promoted into a table behind the user's back.
// Content-preserving — it only ever appends empty cells.
export function normalizeTables(markdown) {
  const src = String(markdown ?? '');
  if (!src.includes('|')) return src; // fast path: no table anywhere
  const lines = src.split('\n');
  const out = [];
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE_MARKER.test(lines[i])) { fenced = !fenced; out.push(lines[i]); continue; }
    if (fenced || !isTableRowLine(lines[i])) { out.push(lines[i]); continue; }

    let end = i;
    while (end + 1 < lines.length && !FENCE_MARKER.test(lines[end + 1]) && isTableRowLine(lines[end + 1])) end += 1;
    const block = lines.slice(i, end + 1);
    // A table needs its delimiter on the SECOND line; anything else is not a
    // table trying to be one, so it passes through untouched.
    if (block.length < 2 || !isSeparatorRow(block[1])) { out.push(...block); i = end; continue; }

    const rows = block.map(splitTableRow);
    const columns = Math.max(...rows.map((r) => r.length));
    if (rows.every((r) => r.length === columns)) { out.push(...block); i = end; continue; }
    out.push(...rows.map((cells, row) => tableRow(
      cells.concat(Array(columns - cells.length).fill(row === 1 ? '---' : '')),
    )));
    i = end;
  }
  return out.join('\n');
}
