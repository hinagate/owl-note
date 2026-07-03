// Deterministic, rule-based markdown TIDY — the replacement for the on-device
// "Format" action. WHY it exists: the model-based Format (a) truncated mid-JSON so
// raw `{"markdown":"...` leaked into the output, and (b) rewrote content and added
// chatbot commentary. Users asked for "just a function" that tidies the preview.
// So this module is content-preserving BY CONSTRUCTION: it only ever touches
// structural whitespace and list/heading markers — never a note's words — and it is
// idempotent, so applying it twice is the same as once.
//
// FENCE-AWARE (same fence semantics as chunker.js's findFenceSpans): every rule is
// applied ONLY outside ``` fenced blocks. Fenced content — including its blank lines
// and trailing spaces — is preserved verbatim; an unclosed fence runs to the end of
// the document. Pure module: no imports, no DOM/chrome APIs.

// A fence marker is a line that STARTS with three backticks (optional language tag),
// mirroring the chunker. Marker lines pair up open/close; an unclosed fence protects
// everything after it. ~~~ tilde fences are deliberately not handled (chunker parity).
const FENCE_MARKER = /^```/;

// Heading = 1–6 hashes followed by WHITESPACE only. `#Title` (no space) is
// deliberately NOT treated as a heading and never "fixed": the same shape is a
// hashtag line (`#tag #another`), a shebang (`#!/bin/bash`), or `#1 issue` — all
// common note content that inserting a space would corrupt into a heading. A rare
// unspaced heading typo is the user's to fix; misclassifying prose is worse.
// (E11-review finding — the original /^#{1,6}(?=\s|[^#\s])/ hit all three.)
const HEADING_RE = /^#{1,6}\s/;
// List item: optional indent, then a `-`/`*`/`+` bullet or an ordered `1.`/`1)`
// marker, then whitespace. Used to space list blocks and to know when NOT to.
const LIST_ITEM_RE = /^\s*([-*+]|\d+[.)])\s/;
// Unicode bullets we normalize to `- ` (leading whitespace, incl. a fullwidth space,
// is preserved). Conservative set — ASCII `*`/`+`/`-` are intentionally left alone.
const UNICODE_BULLET_RE = /^(\s*)[•●▪‣◦・][ \t　]?/;

/**
 * Tidy a note body's markdown structure. Deterministic and idempotent:
 * tidyMarkdown(tidyMarkdown(x)) === tidyMarkdown(x).
 *
 * Rules (outside fenced code only):
 *  1. CRLF/CR → LF.
 *  2. Strip per-line trailing whitespace, preserving an exactly-two-space soft break
 *     (≥2 trailing spaces → 2; a single trailing space or trailing tabs → stripped).
 *  3. Collapse 3+ consecutive blank lines → 1.
 *  4. Headings: insert the missing `#Title` → `# Title` space; ensure exactly one
 *     blank line before and after a heading (never a leading blank at document start).
 *  5. Ensure a blank line before the first item of a list block when the previous
 *     line is non-empty and not itself a list item.
 *  6. Unicode bullets at line start (•●▪‣◦・, leading whitespace preserved) → `- `.
 *  7. Exactly one trailing newline on a non-empty result.
 *
 * Deliberately does NOT: reflow paragraphs, change emphasis markers, renumber lists,
 * touch tables, convert `*`/`+` bullets to `-`, or alter link/image syntax.
 *
 * @param {string} body
 * @returns {string}
 */
export function tidyMarkdown(body) {
  // Rule 1: normalize line endings across the whole document (chunker parity —
  // normalize() does the same). This is the one normalization allowed to reach a
  // fence, since a line ending is not code content.
  const normalized = String(body ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');

  // Fence map: mark which lines are protected (inside a fence, marker lines
  // included). Detection runs on the raw lines — the transforms below never create
  // or destroy a `^```` line, so pre- vs post-transform detection is equivalent.
  const protectedFlags = markFences(lines);

  // Per-line transforms (rules 2, 4a-space, 6). Protected lines are left verbatim.
  const items = lines.map((line, i) => {
    if (protectedFlags[i]) {
      return { text: line, protected: true, blank: false, heading: false, list: false };
    }
    let text = line;
    text = text.replace(UNICODE_BULLET_RE, '$1- ');          // rule 6 (before list/heading classify)
    // rule 4a (`#Title` → `# Title`) was REMOVED: it corrupted hashtags/shebangs/
    // `#1 issue` into headings (see HEADING_RE comment). Only already-valid
    // headings get the rule-4b blank-line spacing below.
    text = stripTrailing(text);                              // rule 2
    return {
      text,
      protected: false,
      blank: text === '',
      heading: HEADING_RE.test(text),
      list: LIST_ITEM_RE.test(text),
    };
  });

  // Rebuild pass (rules 3, 4b-spacing, 5, and leading/trailing blank handling).
  const out = [];
  let pending = 0;   // buffered consecutive non-protected blank lines (a "gap")
  let prev = null;   // last item actually pushed (a content or protected line)

  for (const item of items) {
    if (!item.protected && item.blank) { pending += 1; continue; }

    if (out.length === 0) {
      pending = 0; // drop leading blank lines
    } else {
      let gap = pending;
      if (gap >= 3) gap = 1;                                  // rule 3
      const headingAdjacent = (prev && prev.heading) || item.heading; // rule 4b (non-fence only — protected items are never headings)
      if (headingAdjacent) gap = 1;
      if (gap === 0 && firstListItem(item, prev)) gap = 1;    // rule 5
      for (let k = 0; k < gap; k += 1) out.push('');
      pending = 0;
    }
    out.push(item.text);
    prev = item;
  }

  if (out.length === 0) return ''; // empty / whitespace-only body

  // Rule 7: exactly one trailing newline. Trailing non-protected blanks were never
  // flushed (dropped above); append a terminating newline unless the tail already
  // ends in one (an unclosed fence whose content ends in a newline stays verbatim).
  const result = out.join('\n');
  return result.endsWith('\n') ? result : result + '\n';
}

// Walk the lines once, flipping an in-fence flag on each `^```` marker. Marker lines
// are themselves protected (never transformed); content lines are protected while
// the flag is set. An unclosed fence leaves the flag set to the end.
function markFences(lines) {
  const flags = new Array(lines.length);
  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (FENCE_MARKER.test(lines[i])) {
      flags[i] = true;   // the marker line itself is untouched
      inFence = !inFence;
    } else {
      flags[i] = inFence;
    }
  }
  return flags;
}

// Rule 2: strip trailing whitespace, preserving a markdown soft break — i.e. keep
// exactly two trailing spaces when the line ends in ≥2 spaces and has real content;
// otherwise strip the whole trailing run (tabs never form a soft break).
function stripTrailing(line) {
  const trimmed = line.replace(/[ \t]+$/, '');
  if (trimmed === line) return line; // no trailing whitespace
  return (trimmed.length > 0 && / {2}$/.test(line)) ? trimmed + '  ' : trimmed;
}

// Rule 5 predicate: `item` is the FIRST item of a list block — it is a list item,
// and the preceding pushed line is real prose/structure (non-empty, not a list
// item). A protected fence line counts as prose here, so a list hugging a code
// fence still gets its blank.
function firstListItem(item, prev) {
  return item.list && !!prev && !prev.list && prev.text !== '';
}
