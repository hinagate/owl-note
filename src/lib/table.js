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
    // Off the end of the row: fall into the row below. The delimiter row is
    // structure, not data — nobody wants to Tab into '---', so it is skipped.
    let tail = lineEnd;
    while (tail < body.length) {
      const [nextStart, nextEnd] = lineBoundsAt(body, tail + 1);
      const next = body.slice(nextStart, nextEnd);
      if (!isTableRowLine(next)) break;
      tail = nextEnd;
      if (isSeparatorRow(next)) continue;
      const nextSpans = tableCellSpans(next);
      if (nextSpans.length) return select(nextStart, nextSpans[0]);
    }
    // Nothing below: open a fresh row after the table's LAST line.
    const insert = `\n${tableRow(Array(spans.length).fill(''))}`;
    const caret = tail + 3; // past the new row's '| '
    return { replaceStart: tail, replaceEnd: tail, insert, selStart: caret, selEnd: caret };
  }

  if (index > 0) return select(lineStart, spans[index - 1]);
  let head = lineStart;
  while (head > 0) {
    const [prevStart, prevEnd] = lineBoundsAt(body, head - 1);
    const prev = body.slice(prevStart, prevEnd);
    if (!isTableRowLine(prev)) return null;
    head = prevStart;
    if (isSeparatorRow(prev)) continue; // skip back over the delimiter row
    const prevSpans = tableCellSpans(prev);
    if (prevSpans.length) return select(prevStart, prevSpans[prevSpans.length - 1]);
  }
  return null; // first cell of the first row — let Tab move focus out
}

// The run of consecutive table rows around `pos`, or null when the caret is not
// on one.
export function tableBlockAt(body, pos) {
  const [lineStart, lineEnd] = lineBoundsAt(body, pos);
  if (!isTableRowLine(body.slice(lineStart, lineEnd))) return null;
  let blockStart = lineStart;
  while (blockStart > 0) {
    const [prevStart, prevEnd] = lineBoundsAt(body, blockStart - 1);
    if (!isTableRowLine(body.slice(prevStart, prevEnd))) break;
    blockStart = prevStart;
  }
  let blockEnd = lineEnd;
  while (blockEnd < body.length) {
    const [nextStart, nextEnd] = lineBoundsAt(body, blockEnd + 1);
    if (!isTableRowLine(body.slice(nextStart, nextEnd))) break;
    blockEnd = nextEnd;
  }
  return { blockStart, blockEnd, lineStart, lineEnd };
}

// Bring the table the caret is in into line with its HEADER, rewriting the
// note's own text. Used while typing: adding a header cell fills the new cells
// into the rows below, and REMOVING one takes them away again, so a column can
// actually be deleted.
//
// Only whole trailing cells are added or removed, so nothing before the caret on
// its own line ever moves and the caret remap below stays exact.
// Returns null when the table already matches its header.
export function alignTableAt(body, pos) {
  const found = tableBlockAt(body, pos);
  if (!found) return null;
  const { blockStart, blockEnd } = found;
  const lines = body.slice(blockStart, blockEnd).split('\n');
  // Same conservative rule as normalizeTables: a delimiter row in second
  // position is what marks this block as a table someone is building.
  if (lines.length < 2 || !isSeparatorRow(lines[1])) return null;
  const widened = alignTableLines(lines);
  const insert = widened.join('\n');
  if (insert === lines.join('\n')) return null;

  // Remap the caret: it keeps its offset within its own line, shifted by the
  // growth of every line above it.
  const offsetInBlock = pos - blockStart;
  let consumed = 0;
  let caret = blockStart + insert.length;
  for (let i = 0; i < lines.length; i++) {
    const lineOffset = offsetInBlock - consumed;
    if (lineOffset <= lines[i].length) {
      const before = widened.slice(0, i).reduce((sum, l) => sum + l.length + 1, 0);
      caret = blockStart + before + Math.min(lineOffset, widened[i].length);
      break;
    }
    consumed += lines[i].length + 1;
  }
  return { replaceStart: blockStart, replaceEnd: blockEnd, insert, selStart: caret, selEnd: caret };
}

// GFM's actual constraint, verified against the parser: ONLY the delimiter row
// has to match the header. Body rows may be ragged — short ones get padded and
// extra cells are ignored. So the HEADER defines the column count.
//
// Body rows are still filled out, because seeing the new empty cells is what
// people expect after adding a column. But trailing EMPTY cells beyond the
// header are TRIMMED, and that is what makes DELETING a column possible: sizing
// to max() across all rows meant the body instantly re-widened the header, so a
// deletion undid itself. Cells holding content are never dropped.
export function alignTableLines(lines) {
  const rows = lines.map(splitTableRow);
  const columns = rows[0].length;
  return rows.map((cells, i) => {
    if (i === 1) {
      const delimiter = cells.slice(0, columns); // :--- / ---: alignment survives
      while (delimiter.length < columns) delimiter.push('---');
      return tableRow(delimiter);
    }
    const out = cells.slice();
    while (out.length > columns && out[out.length - 1] === '') out.pop();
    while (out.length < columns) out.push('');
    return tableRow(out);
  });
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
    out.push(...alignTableLines(block));
    i = end;
  }
  return out.join('\n');
}
