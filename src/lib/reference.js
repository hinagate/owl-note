// src/lib/reference.js
//
// Numbered references, Word-style. Select the text you want to cite, press the
// button, and a marker goes in at the selection while a matching APA skeleton is
// appended under a References heading at the foot of the note, ready to fill in.
//
// Everything happens in the note's own text: no lookup, no network, no metadata.
//
// MARKER SYNTAX. `[^1]` is not an option — the renderer has no footnote extension
// and shows it literally. `[1]` renders as plain text, which is what we want, but
// its cousin `[1]: https://…` is a Markdown reference-LINK definition: written that
// way, the marker silently turns into a hyperlink and the entry disappears from the
// note. Entries are therefore `[1] Author…` with no colon, and the marker scan skips
// anything followed by `(` or `:` so real links are never renumbered.
import { EMPTY_REFERENCE } from './citation.js';


// The blank entry and a fully-typed one come from the same formatter, so the skeleton
// can never drift out of step with what the popup produces.
export const REFERENCE_TEMPLATE = EMPTY_REFERENCE;
const REFS_HEADING = 'References';
const HEADING_RE = /^(#{1,6})\s+References\s*$/i;
// `[12]` not followed by `(` or `:` — i.e. a marker, never a link or a definition.
const MARKER_RE = /\[(\d+)\](?![(:])/g;
const ENTRY_RE = /^\[(\d+)\]\s?([\s\S]*)$/;

function clamp(body, start, end) {
  const len = body.length;
  let s = Math.max(0, Math.min(start ?? 0, len));
  let e = Math.max(0, Math.min(end ?? s, len));
  if (e < s) [s, e] = [e, s];
  return [s, e];
}

// Ranges covered by fenced code blocks. A `[1]` inside a snippet is sample text, not
// a citation, and renumbering it would corrupt the code being shown.
function fenceRanges(text) {
  const ranges = [];
  const fence = /^[ \t]*(?:```|~~~).*$/gm;
  let open = null;
  let m;
  while ((m = fence.exec(text)) !== null) {
    if (open === null) open = m.index;
    else { ranges.push([open, m.index + m[0].length]); open = null; }
  }
  if (open !== null) ranges.push([open, text.length]); // unclosed fence runs to the end
  return ranges;
}

const inAnyRange = (ranges, index) => ranges.some(([a, b]) => index >= a && index < b);

/** Split a note into its prose and its existing References section. */
export function splitReferences(body) {
  const lines = body.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!HEADING_RE.test(lines[i])) continue;
    const before = lines.slice(0, i).join('\n');
    return { content: before, heading: lines[i], refsText: lines.slice(i + 1).join('\n'), hasSection: true };
  }
  return { content: body, heading: `## ${REFS_HEADING}`, refsText: '', hasSection: false };
}

/**
 * Existing entries as a Map of number -> text. Entries may wrap onto continuation
 * lines, so a line that does not start a new `[n]` belongs to the previous entry.
 */
export function parseEntries(refsText) {
  const entries = new Map();
  let current = null;
  for (const line of refsText.split('\n')) {
    const match = ENTRY_RE.exec(line.trim());
    if (match) {
      current = Number(match[1]);
      entries.set(current, match[2].trim());
    } else if (current !== null && line.trim() !== '') {
      entries.set(current, `${entries.get(current)} ${line.trim()}`.trim());
    }
  }
  return entries;
}

function scanMarkers(content) {
  const fences = fenceRanges(content);
  const found = [];
  MARKER_RE.lastIndex = 0;
  let m;
  while ((m = MARKER_RE.exec(content)) !== null) {
    if (inAnyRange(fences, m.index)) continue;
    found.push({ index: m.index, length: m[0].length, number: Number(m[1]) });
  }
  return found;
}

/**
 * Insert a reference marker at the selection and add its entry at the foot of the
 * note. Markers are renumbered in document order and the entry list is reordered to
 * match, so citing something mid-note pushes everything after it along — the
 * behaviour a word processor gives you.
 *
 * `entryText` is the finished reference from the popup; without one the entry is the
 * blank APA skeleton, so the button still works if the popup is dismissed.
 *
 * Returns the same edit shape as the other format actions. The edit spans the WHOLE
 * body because a mid-note insert can renumber the foot of the document, and one
 * replacement keeps it to a single undo step.
 */
export function insertReference(body, start, end, entryText = REFERENCE_TEMPLATE) {
  const source = String(body ?? '');
  const [, selEnd] = clamp(source, start, end);
  const { content, heading, refsText } = splitReferences(source);

  // A caret parked inside the References section still cites the prose above it.
  const insertAt = Math.min(selEnd, content.length);
  const existing = parseEntries(refsText);
  const markers = scanMarkers(content);

  // Document order with the new marker slotted in. `null` marks the new one, so the
  // old number of every other marker survives the reshuffle and keeps its entry.
  const order = [];
  let placed = false;
  for (const marker of markers) {
    if (!placed && marker.index >= insertAt) { order.push(null); placed = true; }
    order.push(marker.number);
  }
  if (!placed) order.push(null);
  const newOrdinal = order.indexOf(null) + 1;

  // Rebuild the prose, rewriting every marker to its new ordinal.
  let out = '';
  let cursor = 0;
  let ordinal = 0;
  let newMarkerOffset = -1;
  for (const marker of markers) {
    if (ordinal + 1 === newOrdinal && marker.index >= insertAt) {
      out += content.slice(cursor, insertAt);
      newMarkerOffset = out.length;
      out += `[${newOrdinal}]`;
      cursor = insertAt;
      ordinal += 1;
    }
    out += content.slice(cursor, marker.index);
    ordinal += 1;
    out += `[${ordinal}]`;
    cursor = marker.index + marker.length;
  }
  out += content.slice(cursor);
  if (newMarkerOffset === -1) {
    // The new marker belongs after every existing one.
    newMarkerOffset = insertAt + (out.length - content.length);
    out = `${out.slice(0, newMarkerOffset)}[${newOrdinal}]${out.slice(newMarkerOffset)}`;
  }

  const newEntry = String(entryText || '').trim() || REFERENCE_TEMPLATE;
  const entries = order.map((oldNumber, i) => {
    const text = oldNumber === null ? newEntry : (existing.get(oldNumber) || REFERENCE_TEMPLATE);
    return `[${i + 1}] ${text}`;
  });

  const prose = out.replace(/\s+$/, '');
  const list = entries.join('\n\n');
  const insert = `${prose}\n\n${heading}\n\n${list}\n`;

  // Land the caret on the new entry. When it is still the blank skeleton that means
  // "type over this"; when the popup supplied a finished reference it just shows the
  // user where it landed.
  const entryStart = insert.indexOf(`[${newOrdinal}] `, insert.indexOf(heading));
  const templateStart = entryStart === -1 ? insert.length : entryStart + `[${newOrdinal}] `.length;
  const templateEnd = templateStart + newEntry.length;

  return {
    replaceStart: 0,
    replaceEnd: source.length,
    insert,
    selStart: templateStart,
    selEnd: Math.min(templateEnd, insert.length),
    markerOffset: newMarkerOffset,
    ordinal: newOrdinal,
  };
}
