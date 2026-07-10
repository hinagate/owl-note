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
  const lineStart = body.lastIndexOf('\n', s - 1) + 1;
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
