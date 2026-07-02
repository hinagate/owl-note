// Splits a note body into retrieval chunks: heading-aware sections, each packed
// with whole paragraphs up to a char cap, never splitting inside a fenced code
// block. Pure module — no imports, no DOM/chrome APIs.

export const MAX_CHUNK_CHARS = 1400; // ~350 tokens

const HEADING_LINE = /^#{1,4}\s+(.*)$/;
const FENCE_MARKER = /^```.*$/gm;
const SEP = '\n\n';

/**
 * Split a note into retrieval chunks.
 * Rules:
 *  - Split body on markdown headings (lines matching /^#{1,4}\s/).
 *  - Within a section, greedily pack whole paragraphs (split on /\n{2,}/)
 *    up to MAX_CHUNK_CHARS = 1400 (~350 tokens). A single oversized
 *    paragraph is hard-split at MAX_CHUNK_CHARS.
 *  - Fenced code blocks (``` ... ```) are atomic; never split inside a fence.
 *  - Each chunk records the heading breadcrumb ("Setup > Install") and note title.
 *  - Indexable text = raw markdown lightly cleaned (strip link/image URL targets
 *    keeping link text; strip #, *, _, ` marks; KEEP code content — people search
 *    identifiers). Keep the ORIGINAL markdown separately for prompting.
 *
 * @param {{id:string,title:string,body:string}} note
 * @returns {Chunk[]}  Chunk = {
 *   id: `${note.id}::${n}`, noteId, noteTitle,
 *   heading: string,   // breadcrumb, '' if none
 *   text: string,      // cleaned, for indexing/embedding
 *   raw: string        // original markdown slice, for the prompt
 * }
 */
export function chunkNote(note) {
  const body = normalize(note.body);
  if (!body.trim()) return [];

  // A stored note id is untrusted: notes imported by older app versions (or synced
  // bookmark payloads crafted elsewhere) can carry any string, and the id is the one
  // field of the Ask prompt's <<<NOTE c:id>>> marker that CANNOT be neutralized at
  // prompt-build time — it must round-trip verbatim through the model's citations.
  // So sanitize it here, once, where chunk ids are minted: index docs, prompt marker,
  // and citation resolution all use this same id and stay in agreement. Angle
  // brackets become lookalikes (‹ ›) rather than being deleted so distinct ids stay
  // distinct. chunk.noteId keeps the ORIGINAL id — noteMeta()/citation-open key on it.
  const safeId = String(note.id).replace(/</g, '‹').replace(/>/g, '›');

  const chunks = [];
  let n = 0;
  for (const section of parseSections(body)) {
    const content = body.slice(section.start, section.end);
    for (const built of sectionToChunks(section, content)) {
      chunks.push({
        id: `${safeId}::${n}`,
        noteId: note.id,
        noteTitle: note.title,
        heading: section.breadcrumb,
        text: built.text,
        raw: built.raw,
      });
      n++;
    }
  }
  return chunks;
}

function normalize(body) {
  if (body == null) return '';
  return body.replace(/\r\n/g, '\n');
}

// Fenced code blocks are atomic even across what would otherwise look like a
// heading line inside them (e.g. a "# comment" in a shell snippet) — so
// heading detection must skip anything inside a fence span.
function findFenceSpans(text) {
  const markers = [];
  let m;
  FENCE_MARKER.lastIndex = 0;
  while ((m = FENCE_MARKER.exec(text))) {
    markers.push({ start: m.index, end: m.index + m[0].length });
  }
  const spans = [];
  for (let i = 0; i < markers.length; i += 2) {
    const open = markers[i];
    const close = markers[i + 1];
    spans.push({ start: open.start, end: close ? close.end : text.length });
  }
  return spans;
}

function inFence(spans, pos) {
  return spans.some((s) => pos >= s.start && pos < s.end);
}

// Walks the body into sections: one for any text before the first heading
// (breadcrumb ''), then one per heading. A section's `end` is the start of
// the next real heading line (or end of body).
function parseSections(body) {
  const fenceSpans = findFenceSpans(body);
  const lines = body.split('\n');
  const stack = [];
  const sections = [];

  let sectionStart = 0;
  let breadcrumb = '';
  let headingLine = null;
  let idx = 0;

  for (const line of lines) {
    const lineStart = idx;
    idx += line.length + 1; // account for the '\n' this split() consumed
    const m = HEADING_LINE.exec(line);
    if (m && !inFence(fenceSpans, lineStart)) {
      sections.push({ breadcrumb, headingLine, start: sectionStart, end: lineStart });
      const level = line.match(/^#+/)[0].length;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, text: cleanProse(m[1]).trim() });
      breadcrumb = stack.map((s) => s.text).join(' > ');
      headingLine = line;
      sectionStart = idx;
    }
  }
  sections.push({ breadcrumb, headingLine, start: sectionStart, end: body.length });

  // Drop the synthetic leading section when the body starts with a heading
  // (no pre-heading text to keep) — but a real heading with empty body must
  // still surface as a heading-only chunk, handled in sectionToChunks.
  return sections.filter((s) => s.headingLine !== null || body.slice(s.start, s.end).trim() !== '');
}

// Builds the chunks for one section: paragraphs/fences packed to the cap,
// with the heading line (if any) folded into the first chunk. The fold adds
// heading + separator to the first chunk's raw, so that length is reserved
// out of the first group's packing budget to keep raw within the cap.
function sectionToChunks(section, content) {
  const blocks = splitBlocks(content);
  const reserve = section.headingLine !== null ? section.headingLine.length + SEP.length : 0;
  let built = packBlocks(blocks, reserve).map(buildChunk);

  if (section.headingLine !== null) {
    const m = HEADING_LINE.exec(section.headingLine);
    const headingText = cleanProse(m ? m[1] : '').trim();
    if (built.length === 0) {
      built = [{ raw: section.headingLine, text: headingText }];
    } else {
      built[0] = {
        raw: section.headingLine + SEP + built[0].raw,
        text: headingText + SEP + built[0].text,
      };
    }
  }
  return built;
}

// Splits section content into ordered blocks: fences (exact slice, atomic)
// and paragraphs (trimmed, split on blank lines) around them.
function splitBlocks(text) {
  const fenceSpans = findFenceSpans(text);
  const blocks = [];
  let cursor = 0;
  for (const span of fenceSpans) {
    blocks.push(...paragraphBlocks(text.slice(cursor, span.start)));
    blocks.push({ type: 'fence', raw: text.slice(span.start, span.end) });
    cursor = span.end;
  }
  blocks.push(...paragraphBlocks(text.slice(cursor)));
  return blocks;
}

function paragraphBlocks(segment) {
  return segment
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((raw) => ({ type: 'para', raw }));
}

// Greedily packs blocks into chunks up to MAX_CHUNK_CHARS. Oversized
// paragraphs are hard-split; oversized fences stay whole (atomicity wins —
// the only allowed cap overflow). `firstReserve` shrinks the first group's
// budget so a heading fold onto it cannot push raw past the cap.
function packBlocks(blocks, firstReserve = 0) {
  const chunks = [];
  let current = [];

  // Math.max guards a pathological heading longer than the cap itself.
  const capFor = (groupIndex) =>
    groupIndex === 0 ? Math.max(1, MAX_CHUNK_CHARS - firstReserve) : MAX_CHUNK_CHARS;

  const currentLength = () =>
    current.length
      ? current.reduce((sum, b) => sum + b.raw.length, 0) + (current.length - 1) * SEP.length
      : 0;

  const flush = () => {
    if (current.length) {
      chunks.push(current);
      current = [];
    }
  };

  for (const block of blocks) {
    const prospective = currentLength() + (current.length ? SEP.length : 0) + block.raw.length;
    if (current.length && prospective > capFor(chunks.length)) flush();

    const cap = capFor(chunks.length);
    if (block.type === 'para' && block.raw.length > cap) {
      // Hard-split: only the section's first slice absorbs the heading
      // reserve; later slices get the full cap.
      let sliceCap = cap;
      for (let i = 0; i < block.raw.length; i += sliceCap, sliceCap = MAX_CHUNK_CHARS) {
        chunks.push([{ type: 'para', raw: block.raw.slice(i, i + sliceCap) }]);
      }
      continue;
    }
    current.push(block);
  }
  flush();
  return chunks;
}

function buildChunk(group) {
  return {
    raw: group.map((b) => b.raw).join(SEP),
    text: group.map((b) => (b.type === 'fence' ? cleanFence(b.raw) : cleanProse(b.raw))).join(SEP),
  };
}

// Cleaning for indexable text: collapse links/images to their visible text
// (drop the URL target) and strip markdown emphasis/heading/code marks.
function cleanProse(str) {
  return str
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#*_`]/g, '');
}

// Fence content is kept verbatim (identifiers are searchable) — only the
// marker lines are dropped, whole (the language tag on the opening ``` line
// would otherwise leak into the index as an orphan token).
function cleanFence(str) {
  return str.replace(/^```[^\n]*\n?/gm, '');
}
