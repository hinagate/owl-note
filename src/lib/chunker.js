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

  const chunks = [];
  let n = 0;
  for (const section of parseSections(body)) {
    const content = body.slice(section.start, section.end);
    for (const built of sectionToChunks(section, content)) {
      chunks.push({
        id: `${note.id}::${n}`,
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
// with the heading line (if any) folded into the first chunk.
function sectionToChunks(section, content) {
  const blocks = splitBlocks(content);
  let built = packBlocks(blocks).map(buildChunk);

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
// paragraphs are hard-split; oversized fences stay whole (atomicity wins).
function packBlocks(blocks) {
  const chunks = [];
  let current = [];

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
    if (block.type === 'para' && block.raw.length > MAX_CHUNK_CHARS) {
      flush();
      for (let i = 0; i < block.raw.length; i += MAX_CHUNK_CHARS) {
        chunks.push([{ type: 'para', raw: block.raw.slice(i, i + MAX_CHUNK_CHARS) }]);
      }
      continue;
    }
    const prospective = currentLength() + (current.length ? SEP.length : 0) + block.raw.length;
    if (current.length && prospective > MAX_CHUNK_CHARS) flush();
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
// ``` delimiter markers are dropped.
function cleanFence(str) {
  return str.replace(/^```.*$/gm, (line) => line.replace(/```/g, ''));
}
