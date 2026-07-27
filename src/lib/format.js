// src/lib/format.js
// Pure selection-formatting logic behind the editor's format bar. No DOM, no
// chrome APIs (same purity contract as tidy-markdown.js). Every function takes
// the whole body plus a selection [start, end) and returns an EDIT:
//   { replaceStart, replaceEnd, insert, selStart, selEnd }
// meaning: replace body.slice(replaceStart, replaceEnd) with `insert`, then
// select [selStart, selEnd). The caller applies it (editor.js routes it through
// its undo-preserving insertText) — nothing here mutates anything. The list
// toggles (toggleLinePrefix('bullet', ...), toggleOrderedList) may return
// null when the selection has nothing a list can apply to (e.g. a
// heading-only selection) — callers must treat null as a no-op. insertLink
// may also return null: pressing it inside an image/attachment ref
// (![name](owl-img:…)) is a deliberate no-op, not an unwrap.

// Clamp a selection into [0, body.length] and normalize start <= end.
function clamp(body, start, end) {
  const len = body.length;
  let s = Math.max(0, Math.min(start ?? 0, len));
  let e = Math.max(0, Math.min(end ?? s, len));
  if (e < s) [s, e] = [e, s];
  return [s, e];
}

// Shrink [s, e) so it doesn't start/end on whitespace: `** word**` doesn't
// parse as bold, so edge whitespace stays OUTSIDE the markers.
function trimEdges(body, s, e) {
  while (s < e && /\s/.test(body[s])) s++;
  while (e > s && /\s/.test(body[e - 1])) e--;
  return [s, e];
}

// Find a marker span that encloses [s, e) on the caret's line, for the
// Word-style toggle: caret INSIDE bold + Bold button should unbold, not
// inject a fresh empty pair. Symmetric markers (**, *, ~~) are matched as
// RUNS — a run counts only when its length equals the marker's — so an
// italic scan never pairs with half of a bold's '**'. Asymmetric HTML
// markers (<u>, <mark>) pair unambiguously left-to-right. Inline markdown
// never spans lines, so the search is line-bounded. Returns
// { openStart, closeEnd } or null.
function enclosingSpan(body, s, e, left, right) {
  const lineStart = s === 0 ? 0 : body.lastIndexOf('\n', s - 1) + 1;
  let lineEnd = body.indexOf('\n', lineStart);
  if (lineEnd === -1) lineEnd = body.length;
  if (e > lineEnd) return null; // selection crosses lines
  if (left === right) {
    const esc = left[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const runs = [];
    for (const m of body.slice(lineStart, lineEnd).matchAll(new RegExp(`${esc}+`, 'g'))) {
      if (m[0].length === left.length) runs.push(lineStart + m.index);
    }
    for (let i = 0; i + 1 < runs.length; i += 2) {
      if (runs[i] + left.length <= s && e <= runs[i + 1]) {
        return { openStart: runs[i], closeEnd: runs[i + 1] + right.length };
      }
    }
    return null;
  }
  let from = lineStart;
  for (;;) {
    const open = body.indexOf(left, from);
    if (open === -1 || open >= lineEnd) return null;
    const close = body.indexOf(right, open + left.length);
    if (close === -1 || close >= lineEnd) return null;
    if (open + left.length <= s && e <= close) return { openStart: open, closeEnd: close + right.length };
    from = close + right.length;
  }
}

export function toggleInline(body, start, end, { left, right }) {
  let [s, e] = clamp(body, start, end);
  [s, e] = trimEdges(body, s, e);
  const sel = body.slice(s, e);
  // Markers immediately OUTSIDE the selection -> unwrap. (Also catches the
  // empty `**|**` pair right after a collapsed insert, so toggling twice undoes.)
  if (body.slice(Math.max(0, s - left.length), s) === left && body.slice(e, e + right.length) === right) {
    return { replaceStart: s - left.length, replaceEnd: e + right.length, insert: sel, selStart: s - left.length, selEnd: s - left.length + sel.length };
  }
  // Markers INSIDE the selection (user selected them too) -> unwrap.
  if (sel.length >= left.length + right.length && sel.startsWith(left) && sel.endsWith(right)) {
    const inner = sel.slice(left.length, sel.length - right.length);
    return { replaceStart: s, replaceEnd: e, insert: inner, selStart: s, selEnd: s + inner.length };
  }
  // Caret or selection strictly INSIDE a marked span -> unwrap the whole
  // span (Word-style toggle). Positions inside the content shift left by
  // the removed opening marker.
  const span = enclosingSpan(body, s, e, left, right);
  if (span) {
    const inner = body.slice(span.openStart + left.length, span.closeEnd - right.length);
    return {
      replaceStart: span.openStart,
      replaceEnd: span.closeEnd,
      insert: inner,
      selStart: s - left.length,
      selEnd: e - left.length,
    };
  }
  // Collapsed caret -> insert the pair, caret between the markers.
  if (s === e) {
    return { replaceStart: s, replaceEnd: e, insert: left + right, selStart: s + left.length, selEnd: s + left.length };
  }
  return { replaceStart: s, replaceEnd: e, insert: left + sel + right, selStart: s + left.length, selEnd: s + left.length + sel.length };
}

const HEADING_PREFIXES = ['', '# ', '## ', '### '];

// A line's structure prefix: indent, quote run, optional list marker. The
// heading cycles AFTER it, so H on '1. item' yields '1. # item' — heading
// inside the item — never '# 1. item' (which destroys the list).
const STRUCT_RE = /^(\s*(?:> )*(?:[-*+] |\d+[.)] )?)/;

// Cycle the caret line's heading: none -> # -> ## -> ### -> none, applied
// AFTER any indent/quote/list-marker prefix so the button composes with
// structure instead of fighting it. `#tag` (no space after the hashes) is
// NOT a heading — same rule as tidy-markdown.
export function cycleHeading(body, start) {
  const [s] = clamp(body, start, start);
  const lineStart = s === 0 ? 0 : body.lastIndexOf('\n', s - 1) + 1;
  let lineEnd = body.indexOf('\n', lineStart);
  if (lineEnd === -1) lineEnd = body.length;
  const line = body.slice(lineStart, lineEnd);
  const struct = STRUCT_RE.exec(line)[1];
  const rest0 = line.slice(struct.length);
  const m = /^(#{1,6})\s/.exec(rest0);
  const depth = m ? Math.min(m[1].length, 3) : 0; // ####+ cycles back to none
  const rest = m ? rest0.slice(m[0].length) : rest0;
  const next = HEADING_PREFIXES[(depth + 1) % HEADING_PREFIXES.length];
  const insert = struct + next + rest;
  // Keep the caret at the same offset within the text after the markers.
  const offsetInRest = Math.max(0, s - lineStart - struct.length - (m ? m[0].length : 0));
  const caret = Math.min(lineStart + struct.length + next.length + offsetInRest, lineStart + insert.length);
  return { replaceStart: lineStart, replaceEnd: lineEnd, insert, selStart: caret, selEnd: caret };
}

// The full lines touched by [s, e): from the start of s's line to the end of
// e's line. A selection ending exactly at a line start (just past a \n) does
// NOT pull the next line in.
function lineBlock(body, s, e) {
  // s === 0 guard: lastIndexOf('\n', -1) clamps fromIndex to 0 and can still
  // match a newline AT index 0, which would skip an empty first line.
  const blockStart = s === 0 ? 0 : body.lastIndexOf('\n', s - 1) + 1;
  const effEnd = e > s && (e === body.length || body[e - 1] === '\n') ? e - 1 : e;
  let blockEnd = body.indexOf('\n', Math.max(effEnd, blockStart));
  if (blockEnd === -1) blockEnd = body.length;
  return [blockStart, blockEnd];
}

// The quote run at the start of a line (after indent) — the slot where list
// markers insert, so buttons compose in markdown's own order.
const QUOTES_RE = /^(\s*(?:> )*)/;

// Heading directly after the quote run (no list marker in front). '#tag'
// (no space after the hashes) is content, not a heading — tidy parity.
function isHeadingAfterQuotes(line) {
  return /^#{1,6}\s/.test(line.slice(QUOTES_RE.exec(line)[0].length));
}

const LIST_KINDS = {
  bullet: { has: /^(\s*(?:> )*)- /, add: () => '- ' },
  ordered: { has: /^(\s*(?:> )*)\d+\. /, add: (n) => `${n}. ` },
};

// Shared engine for the two LIST buttons. Skips blank lines AND heading
// lines (maintainer decision: headings are structure, not list content —
// numbering a whole note keeps its title a title), inserts markers after
// any quote run, and returns null when the selection has nothing a list
// can apply to (the editor treats null as a no-op).
function toggleListMarker(body, start, end, kind) {
  const { has, add } = LIST_KINDS[kind];
  const [s, e] = clamp(body, start, end);
  const [blockStart, blockEnd] = lineBlock(body, s, e);
  const lines = body.slice(blockStart, blockEnd).split('\n');
  const blank = (l) => l.trim() === '';
  const eligibleLine = (l) => !blank(l) && !isHeadingAfterQuotes(l);
  let targets = lines.filter(eligibleLine);
  let allBlankMode = false;
  if (!targets.length) {
    if (!lines.every(blank)) return null; // headings only — list buttons never touch headings
    targets = lines; // caret on an empty line: start a list there
    allBlankMode = true;
  }
  const isTarget = (l) => allBlankMode || eligibleLine(l);
  const allHave = targets.every((l) => has.test(l));
  let n = 0;
  const out = lines.map((l) => {
    if (!isTarget(l)) return l;
    if (allHave) return l.replace(has, '$1');
    if (kind === 'bullet' && has.test(l)) return l; // mixed: keep existing bullets
    const stripped = kind === 'ordered' ? l.replace(has, '$1') : l;
    return stripped.replace(QUOTES_RE, (q) => q + add(++n));
  });
  const insert = out.join('\n');
  return { replaceStart: blockStart, replaceEnd: blockEnd, insert, selStart: blockStart, selEnd: blockStart + insert.length };
}

const QUOTE_PREFIX = { has: /^(\s*)> /, add: '> ' };

// Toggle the quote prefix over every selected line. If ALL non-blank lines
// already carry it, remove it; otherwise add it to the lines missing it (after
// any indent). Blank lines inside a block are skipped — no trailing-space
// lines (Tidy would strip them anyway). The whole rewritten block is selected,
// so pressing the button twice round-trips. Quoting a heading is legitimate
// (unlike the list buttons) so headings are not skipped here.
function toggleQuotePrefix(body, start, end) {
  const { has, add } = QUOTE_PREFIX;
  const [s, e] = clamp(body, start, end);
  const [blockStart, blockEnd] = lineBlock(body, s, e);
  const lines = body.slice(blockStart, blockEnd).split('\n');
  const nonBlank = lines.filter((l) => l.trim() !== '');
  const allHave = nonBlank.length > 0 && nonBlank.every((l) => has.test(l));
  const out = lines.map((l) => {
    if (l.trim() === '' && nonBlank.length > 0) return l; // skip blanks in a block
    if (allHave) return l.replace(has, '$1');
    if (has.test(l)) return l;                            // mixed: already prefixed
    return l.replace(/^(\s*)/, `$1${add}`);
  });
  const insert = out.join('\n');
  return { replaceStart: blockStart, replaceEnd: blockEnd, insert, selStart: blockStart, selEnd: blockStart + insert.length };
}

// Toggle a per-line prefix ('bullet' or 'quote') over the selection. Bullet
// routes through the shared list engine (heading-skip rule); quote keeps its
// own, unrelated logic — quoting a heading is legitimate.
export function toggleLinePrefix(body, start, end, kind) {
  if (kind === 'bullet') return toggleListMarker(body, start, end, 'bullet');
  return toggleQuotePrefix(body, start, end);
}

// Same toggle shape as toggleLinePrefix, but numbering is SEQUENTIAL: adding
// renumbers every non-blank, non-heading line 1..n (stripping any stale
// number first), so a mixed or misnumbered block always comes out clean.
export function toggleOrderedList(body, start, end) {
  return toggleListMarker(body, start, end, 'ordered');
}

/* ------------------------------------------------------------------ tables */

// A GFM cell cannot contain a raw '|' (it would open a new column) and cannot
// span lines, so every cell is flattened: whitespace runs collapse to one space
// and pipes are escaped. This is also why a multi-line note block has to become
// SEPARATE cells rather than one cell with line breaks.
function tableCell(text) {
  return String(text).trim().replace(/\s+/g, ' ').replace(/\|/g, '\\|');
}

function tableRow(cells) {
  return `| ${cells.join(' | ')} |`;
}

// Placeholder headings, meant to be typed over. Two columns is the common case
// (a note beside its sketch), so it gets names rather than 'Column 1'.
const PAIR_HEADERS = ['Step', 'Sketch'];

function tableHeader(columns) {
  if (columns === 2) return PAIR_HEADERS.slice();
  return Array.from({ length: columns }, (_, i) => `Column ${i + 1}`);
}

// Turn the selected lines into a GFM table, or drop in a starter table when
// nothing is selected.
//
// The grouping rule: consecutive non-blank lines are the CELLS OF ONE ROW, and
// a blank line starts the next row. That matches how these notes are actually
// written — a line of text followed by its sketch is one logical entry — and it
// scales: text/image, blank, text/image gives two rows without any extra markup.
// Returns null when the selection holds nothing to tabulate.
export function insertTable(body, start, end) {
  const [s, e] = clamp(body, start, end);

  if (s === e) {
    // A table must begin at the start of a line and be its own block, so pad
    // with newlines only where the surrounding text does not already supply them.
    const before = s === 0 || body[s - 1] === '\n' ? '' : '\n';
    const after = s === body.length || body[s] === '\n' ? '' : '\n';
    const rows = [tableRow(PAIR_HEADERS), tableRow(['---', '---']), tableRow(['', ''])];
    const insert = `${before}${rows.join('\n')}\n${after}`;
    const caret = s + before.length + 2; // just past the opening '| '
    return { replaceStart: s, replaceEnd: e, insert, selStart: caret, selEnd: caret + PAIR_HEADERS[0].length };
  }

  const [blockStart, blockEnd] = lineBlock(body, s, e);
  const rows = [];
  let row = [];
  for (const line of body.slice(blockStart, blockEnd).split('\n')) {
    if (line.trim() === '') {
      if (row.length) rows.push(row);
      row = [];
      continue;
    }
    row.push(tableCell(line));
  }
  if (row.length) rows.push(row);
  if (!rows.length) return null; // selection was entirely blank

  const columns = Math.max(...rows.map((r) => r.length));
  const insert = [
    tableRow(tableHeader(columns)),
    tableRow(Array(columns).fill('---')),
    ...rows.map((r) => tableRow(r.concat(Array(columns - r.length).fill('')))),
  ].join('\n');
  return { replaceStart: blockStart, replaceEnd: blockEnd, insert, selStart: blockStart, selEnd: blockStart + insert.length };
}

// A markdown link (or image) on one line: [text](target) with optional
// leading '!'. Bounded to one line — link syntax never spans lines here.
const MD_LINK_RE = /(!?)\[([^\]\n]*)\]\(([^)\n]*)\)/g;

// Wrap the selection as a markdown link — or, when the caret/selection
// already sits inside a link on this line, UNWRAP it back to its text
// (same toggle model as every other button). Image/attachment refs
// (![name](owl-img:…)) are never unwrapped: breaking one would orphan the
// attachment and pruneAttachments would drop its bytes on save — inside
// one, the button is a deliberate no-op (returns null).
export function insertLink(body, start, end) {
  let [s, e] = clamp(body, start, end);
  const lineStart = s === 0 ? 0 : body.lastIndexOf('\n', s - 1) + 1;
  let lineEnd = body.indexOf('\n', lineStart);
  if (lineEnd === -1) lineEnd = body.length;
  if (e <= lineEnd) {
    for (const m of body.slice(lineStart, lineEnd).matchAll(MD_LINK_RE)) {
      const mStart = lineStart + m.index;
      const mEnd = mStart + m[0].length;
      if (mStart > s || e > mEnd) continue; // selection not inside this match
      if (m[1]) return null;                // image/attachment ref — hands off
      const text = m[2];
      // Content shifts left by the removed '['; clamp marker/url positions in.
      const mapPos = (p) => Math.max(mStart, Math.min(p - 1, mStart + text.length));
      return { replaceStart: mStart, replaceEnd: mEnd, insert: text, selStart: mapPos(s), selEnd: mapPos(e) };
    }
  }
  [s, e] = trimEdges(body, s, e);
  if (s === e) {
    return { replaceStart: s, replaceEnd: e, insert: '[text](url)', selStart: s + 1, selEnd: s + 5 };
  }
  const sel = body.slice(s, e);
  return { replaceStart: s, replaceEnd: e, insert: `[${sel}](url)`, selStart: s + sel.length + 3, selEnd: s + sel.length + 6 };
}
