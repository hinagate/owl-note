// src/lib/format.js
// Pure selection-formatting logic behind the editor's format bar. No DOM, no
// chrome APIs (same purity contract as tidy-markdown.js). Every function takes
// the whole body plus a selection [start, end) and returns an EDIT:
//   { replaceStart, replaceEnd, insert, selStart, selEnd }
// meaning: replace body.slice(replaceStart, replaceEnd) with `insert`, then
// select [selStart, selEnd). The caller applies it (editor.js routes it through
// its undo-preserving insertText) — nothing here mutates anything.

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
  // Collapsed caret -> insert the pair, caret between the markers.
  if (s === e) {
    return { replaceStart: s, replaceEnd: e, insert: left + right, selStart: s + left.length, selEnd: s + left.length };
  }
  return { replaceStart: s, replaceEnd: e, insert: left + sel + right, selStart: s + left.length, selEnd: s + left.length + sel.length };
}

const HEADING_PREFIXES = ['', '# ', '## ', '### '];

// Cycle the caret line's heading: none -> # -> ## -> ### -> none. `#tag`
// (no space after the hashes) is NOT a heading — same rule as tidy-markdown.
export function cycleHeading(body, start) {
  const [s] = clamp(body, start, start);
  const lineStart = s === 0 ? 0 : body.lastIndexOf('\n', s - 1) + 1;
  let lineEnd = body.indexOf('\n', lineStart);
  if (lineEnd === -1) lineEnd = body.length;
  const line = body.slice(lineStart, lineEnd);
  const m = /^(#{1,6})\s/.exec(line);
  const depth = m ? Math.min(m[1].length, 3) : 0; // ####+ cycles back to none
  const rest = m ? line.slice(m[0].length) : line;
  const next = HEADING_PREFIXES[(depth + 1) % HEADING_PREFIXES.length];
  const insert = next + rest;
  // Keep the caret at the same offset within the text after the prefix.
  const offsetInRest = Math.max(0, s - lineStart - (m ? m[0].length : 0));
  const caret = Math.min(lineStart + next.length + offsetInRest, lineStart + insert.length);
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

const LINE_PREFIX = {
  bullet: { has: /^(\s*)- /, add: '- ' },
  quote: { has: /^(\s*)> /, add: '> ' },
};

// Toggle a per-line prefix over every selected line. If ALL non-blank lines
// already carry it, remove it; otherwise add it to the lines missing it (after
// any indent). Blank lines inside a block are skipped — no trailing-space
// lines (Tidy would strip them anyway). The whole rewritten block is selected,
// so pressing the button twice round-trips.
export function toggleLinePrefix(body, start, end, kind) {
  const { has, add } = LINE_PREFIX[kind];
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

const ORDERED_HAS = /^(\s*)\d+\. /;

// Same toggle shape as toggleLinePrefix, but numbering is SEQUENTIAL: adding
// renumbers every non-blank line 1..n (stripping any stale number first), so a
// mixed or misnumbered block always comes out clean.
export function toggleOrderedList(body, start, end) {
  const [s, e] = clamp(body, start, end);
  const [blockStart, blockEnd] = lineBlock(body, s, e);
  const lines = body.slice(blockStart, blockEnd).split('\n');
  const nonBlank = lines.filter((l) => l.trim() !== '');
  const allHave = nonBlank.length > 0 && nonBlank.every((l) => ORDERED_HAS.test(l));
  let n = 0;
  const out = lines.map((l) => {
    if (l.trim() === '' && nonBlank.length > 0) return l;
    if (allHave) return l.replace(ORDERED_HAS, '$1');
    return l.replace(ORDERED_HAS, '$1').replace(/^(\s*)/, `$1${++n}. `);
  });
  const insert = out.join('\n');
  return { replaceStart: blockStart, replaceEnd: blockEnd, insert, selStart: blockStart, selEnd: blockStart + insert.length };
}
