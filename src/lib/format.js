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

import { splitTableRow, tableRow, isSeparatorRow, isTableRowLine, tableCellSpans, tableBlockAt, alignTableLines } from './table.js';

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

export function toggleInline(body, start, end, marker) {
  const [s, e] = clamp(body, start, end);
  return applyPerSegment(body, s, e, (b, a, z) => toggleInlineOne(b, a, z, marker));
}

function toggleInlineOne(body, s, e, { left, right }) {
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

/* ------------------------------------------------------ highlight + casing */

// An inline wrapper (<mark>, a font-color <span>, **bold**) is only valid
// INSIDE one block-level container. The body is Markdown source, so a single
// pair stretched across a selection can straddle a boundary the renderer
// enforces later, and the result is silently wrong rather than loudly broken:
//   * across a table cell — `| <mark>a | b</mark> |` splits into two cells and
//     the sanitizer drops the orphaned tag, so only the first cell highlights;
//   * across a blank line — the two halves land in different <p> blocks and
//     everything after the first paragraph loses the formatting.
// So a selection is cut into the segments a wrapper may legally cover: one per
// line, and one per cell within a table row. Each is wrapped on its own and the
// pieces are stitched back into a single edit (one undo step, as before).
//
// A line's structural prefix — indent, quote markers, list marker, heading
// hashes — stays outside the segment for the same reason: `<mark>- a</mark>`
// is no longer a list item, so selecting three bullets and highlighting them
// would flatten the list into a paragraph.
const BLOCK_PREFIX_RE = /^(\s*(?:> )*(?:[-*+] |\d+[.)] )?(?:#{1,6}\s+)?)/;

function selectionSegments(body, s, e) {
  if (s === e) return [[s, e]]; // a collapsed caret is always one segment
  const segments = [];
  let lineStart = s === 0 ? 0 : body.lastIndexOf('\n', s - 1) + 1;
  while (lineStart < e || (lineStart === e && segments.length === 0)) {
    let lineEnd = body.indexOf('\n', lineStart);
    if (lineEnd === -1) lineEnd = body.length;
    const from = Math.max(s, lineStart);
    const to = Math.min(e, lineEnd);
    const line = body.slice(lineStart, lineEnd);
    if (from < to) {
      if (isTableRowLine(line)) {
        // A delimiter row carries no prose, so formatting it would only break
        // the table's cell count.
        if (!isSeparatorRow(line)) {
          for (const [cellStart, cellEnd] of tableCellSpans(line)) {
            const [a, b] = trimEdges(body, Math.max(from, lineStart + cellStart), Math.min(to, lineStart + cellEnd));
            if (a < b) segments.push([a, b]);
          }
        }
      } else {
        const prefix = BLOCK_PREFIX_RE.exec(line)?.[1].length || 0;
        const [a, b] = trimEdges(body, Math.max(from, lineStart + prefix), to);
        if (a < b) segments.push([a, b]);
      }
    }
    if (lineEnd >= body.length) break;
    lineStart = lineEnd + 1;
  }
  return segments;
}

// Run a single-span formatter over every segment of the selection and stitch
// the results into one edit. Segments run left to right and never overlap, so
// the pieces concatenate in order.
function applyPerSegment(body, s, e, applyOne) {
  const segments = selectionSegments(body, s, e);
  if (segments.length === 0) return null;
  if (segments.length === 1) return applyOne(body, segments[0][0], segments[0][1]);
  const edits = [];
  for (const [from, to] of segments) {
    const edit = applyOne(body, from, to);
    if (edit) edits.push(edit);
  }
  if (edits.length === 0) return null;
  // An unwrap reaches back to its opening tag, which can sit before the
  // selection, so the block has to cover the edits as well as the segments.
  const blockStart = Math.min(edits[0].replaceStart, segments[0][0]);
  const blockEnd = Math.max(edits[edits.length - 1].replaceEnd, segments[segments.length - 1][1]);
  let insert = '';
  let cursor = blockStart;
  for (const edit of edits) {
    if (edit.replaceStart < cursor) return null; // overlapping spans: refuse rather than corrupt
    insert += body.slice(cursor, edit.replaceStart) + edit.insert;
    cursor = edit.replaceEnd;
  }
  insert += body.slice(cursor, blockEnd);
  return { replaceStart: blockStart, replaceEnd: blockEnd, insert, selStart: blockStart, selEnd: blockStart + insert.length };
}

// Highlight colors are represented as classes rather than inline styles. That
// keeps note HTML on a small, audited palette and lets DOMPurify remain the
// authority over arbitrary pasted HTML.
const HIGHLIGHT_OPEN_RE = /<mark(?:\s[^>]*)?>/gi;
const HIGHLIGHT_CLOSE_RE = /<\/mark\s*>/gi;
const HIGHLIGHT_CLOSE = '</mark>';
const HIGHLIGHT_COLORS = new Set(['yellow', 'green', 'cyan', 'blue', 'pink', 'orange', 'purple', 'gray']);

function highlightSpanAt(body, s, e) {
  const lineStart = s === 0 ? 0 : body.lastIndexOf('\n', s - 1) + 1;
  let lineEnd = body.indexOf('\n', lineStart);
  if (lineEnd === -1) lineEnd = body.length;
  if (e > lineEnd) return null;

  HIGHLIGHT_OPEN_RE.lastIndex = lineStart;
  for (;;) {
    const open = HIGHLIGHT_OPEN_RE.exec(body);
    if (!open || open.index >= lineEnd) return null;
    const contentStart = open.index + open[0].length;
    HIGHLIGHT_CLOSE_RE.lastIndex = contentStart;
    const close = HIGHLIGHT_CLOSE_RE.exec(body);
    if (!close || close.index > lineEnd) return null;
    const closeStart = close.index;
    const closeEnd = closeStart + close[0].length;
    const selectionInside = contentStart <= s && e <= closeStart;
    const wholeSpanSelected = s === open.index && e === closeEnd;
    if (selectionInside || wholeSpanSelected) {
      return {
        openStart: open.index,
        contentStart,
        closeStart,
        closeEnd,
        color: /\bhighlight-([a-z-]+)/i.exec(open[0])?.[1]?.toLowerCase() || 'yellow',
      };
    }
    HIGHLIGHT_OPEN_RE.lastIndex = closeEnd;
  }
}

function stripHighlightTags(text) {
  return text.replace(HIGHLIGHT_OPEN_RE, '').replace(HIGHLIGHT_CLOSE_RE, '');
}

function unwrapHighlight(body, span, s, e) {
  const inner = body.slice(span.contentStart, span.closeStart);
  const wholeSpanSelected = s === span.openStart && e === span.closeEnd;
  const relativeStart = wholeSpanSelected ? 0 : s - span.contentStart;
  const relativeEnd = wholeSpanSelected ? inner.length : e - span.contentStart;
  return {
    replaceStart: span.openStart,
    replaceEnd: span.closeEnd,
    insert: inner,
    selStart: span.openStart + relativeStart,
    selEnd: span.openStart + relativeEnd,
  };
}

function setHighlightOne(body, s, e, color) {
  const safeColor = HIGHLIGHT_COLORS.has(color) ? color : 'yellow';
  // Keep the original yellow syntax byte-compatible with older notes. Other
  // palette choices carry one of the fixed classes above.
  const left = safeColor === 'yellow' ? '<mark>' : `<mark class="highlight-${safeColor}">`;
  const span = highlightSpanAt(body, s, e);
  if (span) {
    const inner = body.slice(span.contentStart, span.closeStart);
    const wholeSpanSelected = s === span.openStart && e === span.closeEnd;
    const relativeStart = wholeSpanSelected ? 0 : s - span.contentStart;
    const relativeEnd = wholeSpanSelected ? inner.length : e - span.contentStart;
    return {
      replaceStart: span.openStart,
      replaceEnd: span.closeEnd,
      insert: left + inner + HIGHLIGHT_CLOSE,
      selStart: span.openStart + left.length + relativeStart,
      selEnd: span.openStart + left.length + relativeEnd,
    };
  }

  // A broad selection can include one or more already-highlighted fragments.
  // Flatten those generated tags before wrapping so recoloring never nests marks.
  const inner = stripHighlightTags(body.slice(s, e));
  return {
    replaceStart: s,
    replaceEnd: e,
    insert: left + inner + HIGHLIGHT_CLOSE,
    selStart: s + left.length,
    selEnd: s + left.length + inner.length,
  };
}

function removeHighlightOne(body, s, e) {
  const span = highlightSpanAt(body, s, e);
  if (span) return unwrapHighlight(body, span, s, e);
  const selected = body.slice(s, e);
  const inner = stripHighlightTags(selected);
  if (inner === selected) return null;
  return { replaceStart: s, replaceEnd: e, insert: inner, selStart: s, selEnd: s + inner.length };
}

function toggleHighlightOne(body, s, e, color) {
  const span = highlightSpanAt(body, s, e);
  return span ? unwrapHighlight(body, span, s, e) : setHighlightOne(body, s, e, color);
}

// Set (or recolor) a highlight. Unlike the main toolbar toggle, choosing a
// swatch never removes the highlight when the chosen color already matches.
export function setHighlight(body, start, end, color = 'yellow') {
  const [s, e] = clamp(body, start, end);
  return applyPerSegment(body, s, e, (b, a, z) => setHighlightOne(b, a, z, color));
}

export function removeHighlight(body, start, end) {
  const [s, e] = clamp(body, start, end);
  return applyPerSegment(body, s, e, removeHighlightOne);
}

export function toggleHighlight(body, start, end, color = 'yellow') {
  const [s, e] = clamp(body, start, end);
  // A multi-segment selection reads as "highlight all of this": toggling off is
  // decided per segment, so an already-marked cell clears while its neighbours
  // gain the color, matching what each segment would do on its own.
  return applyPerSegment(body, s, e, (b, a, z) => toggleHighlightOne(b, a, z, color));
}

const TEXT_COLOR_OPEN_RE = /<span\s+class=["']text-color-([a-z-]+)["']>/gi;
const SPAN_TAG_RE = /<\/?span\b[^>]*>/gi;
// Mirrors TEXT_COLORS in src/app/format-bar.js — the allow-list that keeps a
// generated span on the audited palette. 'gold' stays accepted so notes written
// before the palette was revised keep rendering their color.
const TEXT_COLORS = new Set(['red', 'orange', 'green', 'teal', 'blue', 'purple', 'pink', 'gray', 'gold']);

function matchingSpanClose(body, contentStart, limit = body.length) {
  SPAN_TAG_RE.lastIndex = contentStart;
  let depth = 1;
  for (;;) {
    const tag = SPAN_TAG_RE.exec(body);
    if (!tag || tag.index > limit) return null;
    depth += /^<span\b/i.test(tag[0]) ? 1 : -1;
    if (depth === 0) return { start: tag.index, end: tag.index + tag[0].length };
  }
}

function textColorSpanAt(body, s, e) {
  const lineStart = s === 0 ? 0 : body.lastIndexOf('\n', s - 1) + 1;
  let lineEnd = body.indexOf('\n', lineStart);
  if (lineEnd === -1) lineEnd = body.length;
  if (e > lineEnd) return null;

  TEXT_COLOR_OPEN_RE.lastIndex = lineStart;
  for (;;) {
    const open = TEXT_COLOR_OPEN_RE.exec(body);
    if (!open || open.index >= lineEnd) return null;
    const contentStart = open.index + open[0].length;
    const close = matchingSpanClose(body, contentStart, lineEnd);
    if (!close) return null;
    const closeEnd = close.end;
    const selectionInside = contentStart <= s && e <= close.start;
    const wholeSpanSelected = s === open.index && e === closeEnd;
    if (selectionInside || wholeSpanSelected) {
      return {
        openStart: open.index,
        contentStart,
        closeStart: close.start,
        closeEnd,
      };
    }
    TEXT_COLOR_OPEN_RE.lastIndex = closeEnd;
  }
}

function stripTextColorSpans(text) {
  let out = text;
  for (;;) {
    TEXT_COLOR_OPEN_RE.lastIndex = 0;
    const open = TEXT_COLOR_OPEN_RE.exec(out);
    if (!open) return out;
    const contentStart = open.index + open[0].length;
    const close = matchingSpanClose(out, contentStart);
    if (!close) return out;
    out = out.slice(0, open.index) + out.slice(contentStart, close.start) + out.slice(close.end);
  }
}

function setTextColorOne(body, s, e, color) {
  const safeColor = TEXT_COLORS.has(color) ? color : 'red';
  const left = `<span class="text-color-${safeColor}">`;
  const right = '</span>';
  const span = textColorSpanAt(body, s, e);
  if (span) {
    const inner = body.slice(span.contentStart, span.closeStart);
    const wholeSpanSelected = s === span.openStart && e === span.closeEnd;
    const relativeStart = wholeSpanSelected ? 0 : s - span.contentStart;
    const relativeEnd = wholeSpanSelected ? inner.length : e - span.contentStart;
    return {
      replaceStart: span.openStart,
      replaceEnd: span.closeEnd,
      insert: left + inner + right,
      selStart: span.openStart + left.length + relativeStart,
      selEnd: span.openStart + left.length + relativeEnd,
    };
  }
  const inner = stripTextColorSpans(body.slice(s, e));
  return {
    replaceStart: s,
    replaceEnd: e,
    insert: left + inner + right,
    selStart: s + left.length,
    selEnd: s + left.length + inner.length,
  };
}

function removeTextColorOne(body, s, e) {
  const span = textColorSpanAt(body, s, e);
  if (span) {
    const inner = body.slice(span.contentStart, span.closeStart);
    const wholeSpanSelected = s === span.openStart && e === span.closeEnd;
    const relativeStart = wholeSpanSelected ? 0 : s - span.contentStart;
    const relativeEnd = wholeSpanSelected ? inner.length : e - span.contentStart;
    return {
      replaceStart: span.openStart,
      replaceEnd: span.closeEnd,
      insert: inner,
      selStart: span.openStart + relativeStart,
      selEnd: span.openStart + relativeEnd,
    };
  }
  const selected = body.slice(s, e);
  const inner = stripTextColorSpans(selected);
  if (selected === inner) return null;
  return { replaceStart: s, replaceEnd: e, insert: inner, selStart: s, selEnd: s + inner.length };
}

// Apply one of the fixed font colors. A palette pick is a setter rather than a
// toggle: choosing a different swatch recolors an existing generated span.
export function setTextColor(body, start, end, color = 'red') {
  const [s, e] = clamp(body, start, end);
  return applyPerSegment(body, s, e, (b, a, z) => setTextColorOne(b, a, z, color));
}

export function removeTextColor(body, start, end) {
  const [s, e] = clamp(body, start, end);
  return applyPerSegment(body, s, e, removeTextColorOne);
}

const WORD_CHAR_RE = /[\p{L}\p{M}\p{N}'’]/u;
const LETTER_RE = /\p{L}/u;

function wordAt(body, pos) {
  let at = Math.max(0, Math.min(pos, body.length));
  if (!WORD_CHAR_RE.test(body[at] || '') && at > 0 && WORD_CHAR_RE.test(body[at - 1])) at -= 1;
  if (!WORD_CHAR_RE.test(body[at] || '')) return null;
  let start = at;
  let end = at + 1;
  while (start > 0 && WORD_CHAR_RE.test(body[start - 1])) start -= 1;
  while (end < body.length && WORD_CHAR_RE.test(body[end])) end += 1;
  return [start, end];
}

// Word changes the case of what the reader sees; here the selection is Markdown
// source, where the same transform would also rewrite the markup around it. A
// re-cased tag name is harmless (HTML tag names are case-insensitive) but the
// rest is not: `class="text-color-red"` becomes `class="TEXT-COLOR-RED"`, which
// no longer matches the stylesheet, so the font color or highlight silently
// disappears. Link targets and `owl-img:` attachment ids are case-sensitive too,
// so UPPERCASE would break every link and orphan every image in the selection.
// These runs are therefore copied through untouched.
const CASE_PROTECTED_RE = /<[^>\n]*>|`+[^`]*`+|\]\([^)\n]*\)|\bhttps?:\/\/\S+|\bowl-[a-z]+:[A-Za-z0-9]+/gi;

// Split `text` into [plain, markup, plain, markup, …] runs and re-case only the
// plain ones. `transform` may be stateful (sentence case tracks whether the next
// letter opens a sentence) and is called on the plain runs in order.
function recaseAroundMarkup(text, transform) {
  let out = '';
  let last = 0;
  CASE_PROTECTED_RE.lastIndex = 0;
  for (;;) {
    const markup = CASE_PROTECTED_RE.exec(text);
    if (!markup) break;
    out += transform(text.slice(last, markup.index)) + markup[0];
    last = markup.index + markup[0].length;
  }
  return out + transform(text.slice(last));
}

function titleCase(text) {
  return text.toLowerCase().replace(/\p{L}[\p{L}\p{M}'’]*/gu, (word) => word.replace(/^\p{L}/u, (letter) => letter.toUpperCase()));
}

function toggleCase(text) {
  return Array.from(text, (char) => {
    const lower = char.toLowerCase();
    const upper = char.toUpperCase();
    return char === lower && char !== upper ? upper : lower;
  }).join('');
}

// Sentence case is the one stateful mode: it has to remember, across the markup
// runs it skips, whether the next letter still opens a sentence.
function sentenceCaser() {
  let startsSentence = true;
  return (text) => {
    let out = '';
    for (const char of text) {
      if (LETTER_RE.test(char)) {
        out += startsSentence ? char.toUpperCase() : char.toLowerCase();
        startsSentence = false;
      } else {
        out += char;
        if (/[.!?]/.test(char) || char === '\n') startsSentence = true;
      }
    }
    return out;
  };
}

const CASE_MODES = {
  sentence: sentenceCaser,
  lower: () => (text) => text.toLowerCase(),
  upper: () => (text) => text.toUpperCase(),
  title: () => titleCase,
  toggle: () => toggleCase,
};

// Word-style Change Case. With no selection, act on the word under the caret so
// the command remains useful without requiring a precise drag-selection first.
export function changeCase(body, start, end, mode) {
  const transform = CASE_MODES[mode]?.();
  if (!transform) return null;
  let [s, e] = clamp(body, start, end);
  if (s === e) {
    const word = wordAt(body, s);
    if (!word) return null;
    // The caret may be sitting inside a tag or a URL, where "the word under the
    // caret" is markup (`red` in text-color-red). Re-casing that is the bug this
    // guards against, so there is nothing safe to do.
    if (insideMarkup(body, word[0], word[1])) return null;
    [s, e] = word;
  }
  const insert = recaseAroundMarkup(body.slice(s, e), transform);
  if (insert === body.slice(s, e)) return null;
  return { replaceStart: s, replaceEnd: e, insert, selStart: s, selEnd: s + insert.length };
}

// True when [s, e) overlaps a protected markup run on its own line.
function insideMarkup(body, s, e) {
  const lineStart = s === 0 ? 0 : body.lastIndexOf('\n', s - 1) + 1;
  let lineEnd = body.indexOf('\n', lineStart);
  if (lineEnd === -1) lineEnd = body.length;
  const line = body.slice(lineStart, lineEnd);
  CASE_PROTECTED_RE.lastIndex = 0;
  for (;;) {
    const markup = CASE_PROTECTED_RE.exec(line);
    if (!markup) return false;
    const from = lineStart + markup.index;
    if (from < e && s < from + markup[0].length) return true;
  }
}

const ALIGNMENTS = new Set(['left', 'center', 'right']);
const ALIGN_CLASS_RE = /\bclass=(["'])text-align-(?:left|center|right)\1/i;
const FENCE_LINE_RE = /^\s*```/;
const THEMATIC_BREAK_RE = /^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;

// Align every selected logical line while leaving Markdown's structural prefix
// outside the generated span. That keeps headings/lists/quotes parseable; table
// rows, thematic breaks and fenced code are intentionally left byte-identical.
export function setAlignment(body, start, end, alignment) {
  if (!ALIGNMENTS.has(alignment)) return null;
  const [s, e] = clamp(body, start, end);
  const [blockStart, blockEnd] = lineBlock(body, s, e);
  const lines = body.slice(blockStart, blockEnd).split('\n');
  let fenced = false;
  for (const line of body.slice(0, blockStart).split('\n')) {
    if (FENCE_LINE_RE.test(line)) fenced = !fenced;
  }
  const out = lines.map((line) => {
    if (FENCE_LINE_RE.test(line)) { fenced = !fenced; return line; }
    if (fenced || !line.trim() || isTableRowLine(line) || THEMATIC_BREAK_RE.test(line)) return line;
    const prefix = BLOCK_PREFIX_RE.exec(line)?.[1] || '';
    const content = line.slice(prefix.length);
    if (ALIGN_CLASS_RE.test(content)) {
      return prefix + content.replace(
        ALIGN_CLASS_RE,
        (_match, quote) => `class=${quote}text-align-${alignment}${quote}`,
      );
    }
    return `${prefix}<span class="text-align-${alignment}">${content}</span>`;
  });
  const insert = out.join('\n');
  if (insert === body.slice(blockStart, blockEnd)) return null;
  return {
    replaceStart: blockStart,
    replaceEnd: blockEnd,
    insert,
    selStart: blockStart,
    selEnd: blockStart + insert.length,
  };
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

// A GFM table cannot exist without a header row — without one it parses as a
// plain paragraph, not a table. So the header is structural, and these are
// deliberately meaningless placeholders to be typed over rather than words that
// look like they mean something.
const HEADER_PLACEHOLDER = (i) => `title ${i + 1}`;

function tableHeader(columns) {
  return Array.from({ length: columns }, (_, i) => HEADER_PLACEHOLDER(i));
}

// Array-shaped view of table.js's block finder, for the destructuring below.
function tableBlock(body, pos) {
  const found = tableBlockAt(body, pos);
  return found ? [found.blockStart, found.blockEnd, found.lineStart, found.lineEnd] : null;
}

// Which column the caret sits in: count the unescaped pipes before it, less the
// row's leading pipe (which opens no column).
function columnAt(line, offset) {
  let pipes = 0;
  for (let i = 0; i < Math.min(offset, line.length); i++) {
    if (line[i] === '\\') { i += 1; continue; }
    if (line[i] === '|') pipes += 1;
  }
  return Math.max(0, pipes - 1);
}

// GFM demands that the delimiter row match the header's cell count. Add a header
// cell by hand and the block silently stops being a table altogether — it renders
// as a paragraph of pipes, with nothing to indicate why. This widens every row to
// the widest one and supplies a delimiter row if none exists, which is exactly the
// content-preserving, structure-only repair tidy-markdown.js performs elsewhere.
// Returns null when the table is already well-formed, so the caller can fall
// through to adding a column.
function repairTable(body, pos) {
  const found = tableBlock(body, pos);
  if (!found) return null;
  const [blockStart, blockEnd] = found;
  const lines = body.slice(blockStart, blockEnd).split('\n');
  // A block of pipe rows with no delimiter at all isn't a table yet: the first
  // row becomes the header and the delimiter it was missing is inserted.
  const withDelimiter = isSeparatorRow(lines[1] ?? '')
    ? lines
    : [lines[0], tableRow(Array(splitTableRow(lines[0]).length).fill('---')), ...lines.slice(1)];
  const aligned = alignTableLines(withDelimiter);
  const insert = aligned.join('\n');
  if (insert === lines.join('\n')) return null; // already agrees with its header
  return { replaceStart: blockStart, replaceEnd: blockEnd, insert, selStart: blockStart, selEnd: blockStart + insert.length };
}

// Add a column to EVERY row of the table the caret is in, immediately after the
// caret's own column — the "insert column right" every table editor offers.
// Returns null when the caret is not in a table.
function addTableColumn(body, pos) {
  const found = tableBlock(body, pos);
  if (!found) return null;
  const [blockStart, blockEnd, lineStart] = found;
  const at = columnAt(body.slice(lineStart, blockEnd), pos - lineStart);
  const out = body.slice(blockStart, blockEnd).split('\n').map((line) => {
    const cells = splitTableRow(line);
    const index = Math.min(at + 1, cells.length);
    cells.splice(index, 0, isSeparatorRow(line) ? '---' : '');
    return tableRow(cells);
  }).join('\n');
  return { replaceStart: blockStart, replaceEnd: blockEnd, insert: out, selStart: blockStart, selEnd: blockStart + out.length };
}

// Enter inside a table: open the next row, matching the current row's column
// count and dropping the caret in its first cell. On an ALREADY-EMPTY row it
// clears that row instead, so Enter twice walks out of the table rather than
// trapping the caret in it. Returns null anywhere else, leaving Enter alone.
export function nextTableRow(body, start, end) {
  const [s, e] = clamp(body, start, end);
  if (s !== e) return null; // a selection means "replace", not "extend the table"
  const found = tableBlock(body, s);
  if (!found) return null;
  const [, , lineStart, lineEnd] = found;
  const line = body.slice(lineStart, lineEnd);
  const cells = splitTableRow(line);

  if (!isSeparatorRow(line) && cells.every((c) => c === '')) {
    // Empty row -> leave the table, putting the caret on the now-blank line.
    return { replaceStart: lineStart, replaceEnd: lineEnd, insert: '', selStart: lineStart, selEnd: lineStart };
  }
  const insert = `\n${tableRow(Array(cells.length).fill(''))}`;
  const caret = lineEnd + 1 + 2; // past the new row's '| '
  return { replaceStart: lineEnd, replaceEnd: lineEnd, insert, selStart: caret, selEnd: caret };
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
    // Inside a table already? A broken one wants repairing before anything else —
    // adding a column to a table that no longer parses helps nobody. Otherwise the
    // useful move is a new column, not a nested table nobody could want.
    const repair = repairTable(body, s);
    if (repair) return repair;
    const column = addTableColumn(body, s);
    if (column) return column;
    // A table must begin at the start of a line and be its own block, so pad
    // with newlines only where the surrounding text does not already supply them.
    const before = s === 0 || body[s - 1] === '\n' ? '' : '\n';
    const after = s === body.length || body[s] === '\n' ? '' : '\n';
    const header = tableHeader(2); // a starter table is two columns
    const rows = [tableRow(header), tableRow(['---', '---']), tableRow(['', ''])];
    const insert = `${before}${rows.join('\n')}\n${after}`;
    const caret = s + before.length + 2; // just past the opening '| '
    return { replaceStart: s, replaceEnd: e, insert, selStart: caret, selEnd: caret + header[0].length };
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

// The full line ending at `pos` (or the one `pos` sits inside), and the line
// starting at `pos` — the neighbours a freshly inserted block has to clear.
function lineBefore(body, pos) {
  if (pos === 0) return '';
  const end = body[pos - 1] === '\n' ? pos - 1 : pos;
  const start = end === 0 ? 0 : body.lastIndexOf('\n', end - 1) + 1;
  return body.slice(start, end);
}

function lineAfter(body, pos) {
  const start = body[pos] === '\n' ? pos + 1 : pos;
  let end = body.indexOf('\n', start);
  if (end === -1) end = body.length;
  return body.slice(start, end);
}

// A table pasted straight under one of these is absorbed by it.
function needsBlankLine(line) {
  return isTableRowLine(line) || /^\s*(?:[-*+]|\d+[.)])\s/.test(line) || /^\s*>/.test(line);
}

// Insert a blank table with an explicit Word-style grid size. `rows` counts
// visible rows (the Markdown delimiter is structural and does not count), so a
// 3 × 2 choice produces a three-cell header plus one editable body row.
//
// The size picker is an INSERT command rather than Convert Text to Table: if
// text is selected, keep it intact and place the table immediately after it.
// The main Table button remains the fast way to convert selected lines.
export function insertSizedTable(body, start, end, columns, rows) {
  const [s, e] = clamp(body, start, end);
  const columnCount = Math.max(1, Math.min(20, Math.trunc(Number(columns)) || 1));
  const rowCount = Math.max(1, Math.min(20, Math.trunc(Number(rows)) || 1));
  let pos = e > s ? e : s;

  // A table cannot be nested inside a GFM cell. If the caret is already in one,
  // insert the new table after that block; the main button handles repair and
  // adding a column to the existing table.
  const existing = tableBlockAt(body, pos);
  if (existing) pos = existing.blockEnd;

  // Two table blocks that touch are ONE table to GFM: the new header becomes a
  // body row of the old table and the new delimiter row renders as a row of
  // literal '---' cells. A list or quote line directly above swallows the table
  // the same way, through lazy continuation. A blank line keeps the blocks apart.
  const previous = lineBefore(body, pos);
  const next = lineAfter(body, pos);
  let before = pos === 0 || body[pos - 1] === '\n' ? '' : '\n';
  if (previous.trim() && needsBlankLine(previous)) before += '\n';
  let after = pos === body.length || body[pos] === '\n' ? '' : '\n';
  if (next.trim() && isTableRowLine(next)) after += '\n';
  const emptyRow = () => tableRow(Array(columnCount).fill(''));
  const lines = [
    tableRow(tableHeader(columnCount)),
    tableRow(Array(columnCount).fill('---')),
    ...Array.from({ length: rowCount - 1 }, emptyRow),
  ];
  const insert = `${before}${lines.join('\n')}\n${after}`;
  const selectionStart = pos + before.length + 2;
  return {
    replaceStart: pos,
    replaceEnd: pos,
    insert,
    selStart: selectionStart,
    selEnd: selectionStart + HEADER_PLACEHOLDER(0).length,
  };
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
