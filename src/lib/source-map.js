// src/lib/source-map.js — find the exact source text behind a preview selection, and
// the exact preview text behind a source selection.
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
import { lexBlocks, renderMarkdown } from './markdown.js';
import { findKeyword } from './search.js';

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

// Text in the preview that is not the note's own words: pronunciation readings, code
// block buttons, image placeholders, and drawings whose text is laid out as glyphs.
const NOT_NOTE_TEXT = 'rt, rp, button, svg, .katex, .owl-image-placeholder';

// The other direction: a DOM Range over the first place `query` reads in `root`, or null.
// It may span several text nodes, since "<b>pas</b>ta" and a word split across <ruby>
// runs both read as one word.
export function keywordRange(root, query) {
  if (!root) return null;
  const nodes = [];
  let text = '';
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest(NOT_NOTE_TEXT)) continue;
    nodes.push({ node, start: text.length });
    text += node.data;
  }
  const spot = findKeyword(text, query);
  if (!spot) return null;
  const startAt = nodes.findLast((n) => n.start <= spot.start);
  const endAt = nodes.findLast((n) => n.start < spot.end);
  const range = root.ownerDocument.createRange();
  range.setStart(startAt.node, spot.start - startAt.start);
  range.setEnd(endAt.node, spot.end - endAt.start);
  return range;
}

// ── A selection in the source, found in the preview ──────────────────────────────────
//
// The same promise the other way round: the characters selected in the Markdown, lit
// where they read in the preview, or nothing. The block is known exactly from the
// offsets, so only the place inside it has to be found.

// Elements whose text stands apart from what came before: a new line or a new cell.
const SEPARATE = 'p, div, li, tr, td, th, dt, dd, h1, h2, h3, h4, h5, h6, pre, blockquote, summary, caption, figcaption';

// The note's own words under `root`, whitespace collapsed as `collapse` does it, with
// where each character sits: spots[i] is [text node, offset].
function renderedText(root) {
  const chars = [];
  const spots = [];
  let gap = false;
  let gapAt = null; // the gap's own first space, when it has one: a <br> has none
  let home;
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.nodeType === 1 && node.matches(NOT_NOTE_TEXT) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === 1) {
      if (node.localName === 'br') gap = chars.length > 0;
      continue;
    }
    const within = node.parentElement?.closest(SEPARATE) ?? null;
    if (within !== home) { home = within; gap = chars.length > 0; }
    for (let i = 0; i < node.data.length; i += 1) {
      if (/\s/.test(node.data[i])) {
        if (chars.length && !gap) { gap = true; gapAt = [node, i]; }
        continue;
      }
      if (gap) { chars.push(' '); spots.push(gapAt ?? [node, i]); gap = false; gapAt = null; }
      chars.push(node.data[i]);
      spots.push([node, i]);
    }
  }
  return { text: chars.join(''), spots };
}

// What a piece of Markdown reads as once it is rendered.
function visibleText(doc, markdown) {
  const holder = doc.createElement('template');
  try { holder.innerHTML = renderMarkdown(markdown); } catch { return ''; }
  return renderedText(holder.content).text;
}

function occurrences(text, needle) {
  const found = [];
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) found.push(at);
  return found;
}

// A table's pipes and its row of dashes are markup in the source; in the preview they
// are the edges of cells. Blanked rather than removed, so every offset still holds.
const TABLE_RULE = /^[ \t|:-]*-[ \t|:-]*$/gm;
const withoutTableMarkup = (source) => source.replace(TABLE_RULE, (row) => ' '.repeat(row.length)).replace(/\|/g, ' ');

// Where in `shown`, the block's rendered text, the source selection [start, end) reads:
// { at, length }, or null when that is not certain.
function placePart(shown, doc, type, blockSource, start, end) {
  const source = type === 'table' ? withoutTableMarkup(blockSource) : blockSource;
  const part = collapse(source.slice(start, end));
  const needle = part.text;
  if (needle.length >= MIN_SELECTION_CHARS) {
    const found = occurrences(shown, needle);
    if (found.length === 1) return { at: found[0], length: needle.length };
    if (found.length > 1) {
      // The same words several times in one block. Which of them is known only when the
      // source and the preview hold them the same number of times, and so in the same order.
      const all = collapse(source);
      const inSource = occurrences(all.text, needle);
      const nth = inSource.findIndex((at) => all.index[at] === start + part.index[0]);
      return nth >= 0 && inSource.length === found.length ? { at: found[nth], length: needle.length } : null;
    }
  }
  // Not there as typed, so the selection holds markup: **bold**, a link, a heading's #.
  // What it reads as can still be placed when the block says it only once.
  const read = visibleText(doc, source.slice(start, end));
  if (read.length < MIN_SELECTION_CHARS || read === needle) return null;
  const found = occurrences(shown, read);
  return found.length === 1 ? { at: found[0], length: read.length } : null;
}

// Ranges over the same characters in `blockEl`, the rendered element of `block`, for the
// part of `selection` ({ start, end } in `source`) that lies in that block. One Range per
// text node, so whatever stands between two of them (a pronunciation reading) stays unlit.
// Null is a real answer here too: this part cannot be placed, so nothing is lit for it.
export function locateRendered(blockEl, source, block, selection) {
  if (!blockEl || !block || !selection) return null;
  const src = String(source ?? '');
  const start = Math.max(selection.start, block.start);
  const end = Math.min(selection.end, block.end);
  if (!(end > start)) return null;
  const shown = renderedText(blockEl);
  if (!shown.text) return null;
  // Everything the block says is selected, with or without its markup: all of it is lit.
  const whole = !src.slice(block.start, start).trim() && !src.slice(end, block.end).trim();
  const span = whole
    ? { at: 0, length: shown.text.length }
    : placePart(shown.text, blockEl.ownerDocument, block.type, src.slice(block.start, block.end), start - block.start, end - block.start);
  if (!span) return null;
  const runs = [];
  for (let i = span.at; i < span.at + span.length; i += 1) {
    const [node, offset] = shown.spots[i];
    const last = runs[runs.length - 1];
    if (last && last.node === node) last.end = offset + 1;
    else runs.push({ node, start: offset, end: offset + 1 });
  }
  return runs.map((run) => {
    const range = blockEl.ownerDocument.createRange();
    range.setStart(run.node, run.start);
    range.setEnd(run.node, run.end);
    return range;
  });
}
