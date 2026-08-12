// src/lib/source-map.js — find the exact source text behind a preview selection.
//
// The preview is generated FROM the Markdown, so the text you select in it exists
// verbatim in the source. That is the whole basis of this module: locate the
// selection by exact string match, or report nothing. No approximate matching —
// a highlight that lands on merely similar text is worse than no highlight,
// because you cannot tell the difference by looking.
//
// Two things make the match reliable rather than a guess:
//
//   1. A search WINDOW. Every top-level block's source offsets are known exactly
//      (marked's tokens each carry their own source in `.raw`, and those
//      concatenate back to the input byte for byte), so the search runs inside the
//      block that was selected, not across the whole note. In a document that
//      repeats "注音ㄙ（絲）" in twenty table rows, that is the difference between
//      right and wrong.
//   2. A MINIMUM length. Two or three characters match everywhere and mean
//      nothing. Below the threshold the answer is "not enough to go on" rather
//      than a coin flip.
import { lexBlocks } from './markdown.js';

// Below this, a selection is too common to place: "the", "普", "/s/" occur all
// over a note. VS Code's preview sidesteps this with line numbers baked into the
// HTML; matching on text has to earn the same confidence from length instead.
export const MIN_SELECTION_CHARS = 4;

// [{ start, end, type }] for each source block that produces a rendered element.
export function blockRanges(markdown) {
  const src = String(markdown ?? '');
  if (!src) return [];
  let tokens;
  try { tokens = lexBlocks(src); } catch { return []; } // malformed input must never break selecting
  const out = [];
  let offset = 0;
  for (const token of tokens) {
    const len = (token && typeof token.raw === 'string') ? token.raw.length : 0;
    if (token && token.type !== 'space' && len > 0) out.push({ start: offset, end: offset + len, type: token.type });
    offset += len;
  }
  return out;
}

// Which rendered block was selected: the ancestor that is a direct child of `root`.
export function blockIndexOf(root, target) {
  if (!root || !target || !root.contains(target)) return -1;
  let node = target;
  while (node && node.parentElement !== root) node = node.parentElement;
  if (!node) return -1;
  return [...root.children].indexOf(node);
}

// The rendered text and the source disagree about whitespace in ways that are not
// the reader's fault: a `<br>` inside a table cell arrives in the selection as a
// newline, and the browser collapses runs of spaces. So the comparison runs over a
// whitespace-collapsed copy, while an index map carries every position back to a
// real offset in the original text. Still exact — no characters are ignored, only
// the width of the gaps between them.
// A `<br>` is markup in the source but a line break in the selection, so it has to
// read as a gap on both sides for the two to line up. It is skipped HERE, during the
// walk, rather than substituted beforehand: replacing 4 characters with 1 first would
// shift every later index by 3 and the map would point at the wrong place.
const BR_AT = /<br\s*\/?>/iy;

function collapse(text) {
  const chars = [];
  const index = [];
  let pendingGap = false;
  let i = 0;
  while (i < text.length) {
    BR_AT.lastIndex = i;
    const br = BR_AT.exec(text);
    if (br) { pendingGap = chars.length > 0; i += br[0].length; continue; }
    if (/\s/.test(text[i])) { pendingGap = chars.length > 0; i += 1; continue; }
    if (pendingGap) { chars.push(' '); index.push(i); pendingGap = false; }
    chars.push(text[i]);
    index.push(i);
    i += 1;
  }
  return { text: chars.join(''), index };
}

// The exact source range for `selected`, or null. Null is a real answer: it means
// "cannot place this with certainty", and the caller should highlight nothing.
export function locateSelection(source, block, selected) {
  const src = String(source ?? '');
  const needleRaw = String(selected ?? '').trim();
  if (needleRaw.length < MIN_SELECTION_CHARS) return null; // not enough to go on

  const from = block ? block.start : 0;
  const to = block ? block.end : src.length;
  const window = src.slice(from, to);

  // Fast path: the selection appears verbatim, which is the common case for prose.
  const direct = window.indexOf(needleRaw);
  if (direct >= 0) return { start: from + direct, end: from + direct + needleRaw.length };

  // Otherwise compare with whitespace collapsed, treating <br> as a gap.
  const haystack = collapse(window);
  const needle = collapse(needleRaw).text;
  if (needle.length < MIN_SELECTION_CHARS) return null;
  const at = haystack.text.indexOf(needle);
  if (at < 0) return null; // not found — say so rather than approximate

  const start = haystack.index[at];
  const lastChar = haystack.index[at + needle.length - 1];
  if (start === undefined || lastChar === undefined) return null;
  return { start: from + start, end: from + lastChar + 1 };
}
