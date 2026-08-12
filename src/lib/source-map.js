// src/lib/source-map.js — map a rendered preview block back to its source offset.
//
// The preview is HTML; the editor is the Markdown that produced it. To jump from
// one to the other you need to know which characters of the source produced which
// rendered block. markdown-it hands that out directly (`token.map`), which is how
// VS Code's preview does it; marked has no such field, but it does guarantee
// something equivalent: every top-level token carries the exact source text that
// produced it in `.raw`, and concatenating those in order reproduces the input
// byte for byte. So a running sum of `raw.length` IS the offset table.
//
// `space` tokens are dropped because they render nothing — after that, the tokens
// correspond one-for-one, in order, with the top-level children of the rendered
// body, which is what makes a plain index lookup enough.
import { lexBlocks } from './markdown.js';

// [{ start, end, type }] for each source block that produces a rendered element.
export function blockRanges(markdown) {
  const src = String(markdown ?? '');
  if (!src) return [];
  let tokens;
  try { tokens = lexBlocks(src); } catch { return []; } // malformed input must never break clicking
  const out = [];
  let offset = 0;
  for (const token of tokens) {
    const len = (token && typeof token.raw === 'string') ? token.raw.length : 0;
    if (token && token.type !== 'space' && len > 0) out.push({ start: offset, end: offset + len, type: token.type });
    offset += len;
  }
  return out;
}

// Narrow a block down to the text the reader actually clicked. The rendered text
// has lost its markup ("**bold**" arrives as "bold"), so an exact search usually
// fails; walking the words from the front finds the longest run that still matches
// and lands the caret near the click rather than at the top of the block.
export function refineOffset(markdown, range, clickedText) {
  if (!range) return null;
  const block = String(markdown ?? '').slice(range.start, range.end);
  const needle = String(clickedText ?? '').trim();
  if (!needle) return { start: range.start, end: range.start };

  const exact = block.indexOf(needle);
  if (exact >= 0) return { start: range.start + exact, end: range.start + exact + needle.length };

  // Longest leading word-run that appears verbatim in the source.
  const words = needle.split(/\s+/).filter(Boolean);
  for (let take = Math.min(words.length, 12); take > 0; take--) {
    const probe = words.slice(0, take).join(' ');
    if (probe.length < 3) break; // too short to be a trustworthy anchor
    const at = block.indexOf(probe);
    if (at >= 0) return { start: range.start + at, end: range.start + at + probe.length };
  }
  // Nothing matched (heavy inline markup, or an image) — the block start is still
  // a useful answer, and far better than not moving at all.
  return { start: range.start, end: range.start };
}

// Which rendered block was clicked: the ancestor that is a direct child of `root`.
// Returns its index among element children, or -1 when the click was on the root
// itself or outside it.
export function blockIndexOf(root, target) {
  if (!root || !target || !root.contains(target)) return -1;
  let node = target;
  while (node && node.parentElement !== root) node = node.parentElement;
  if (!node) return -1;
  return [...root.children].indexOf(node);
}
