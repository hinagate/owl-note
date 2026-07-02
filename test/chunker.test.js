import { describe, it, expect } from 'vitest';
import { chunkNote, MAX_CHUNK_CHARS } from '../src/lib/chunker.js';

const note = (overrides = {}) => ({ id: 'n1', title: 'My Note', body: '', ...overrides });

describe('chunkNote — empty/edge input', () => {
  it('returns [] for empty body', () => {
    expect(chunkNote(note({ body: '' }))).toEqual([]);
  });

  it('returns [] for whitespace-only body', () => {
    expect(chunkNote(note({ body: '   \n\n  \n' }))).toEqual([]);
  });

  it('returns [] for null body', () => {
    expect(chunkNote(note({ body: null }))).toEqual([]);
  });

  it('returns [] for undefined body', () => {
    expect(chunkNote(note({ body: undefined }))).toEqual([]);
  });
});

describe('chunkNote — heading splitting', () => {
  it('splits body on headings into separate chunks with breadcrumbs', () => {
    const body = '# Setup\n\nDo the setup thing.\n\n## Install\n\nRun npm install.';
    const chunks = chunkNote(note({ body }));
    const headings = chunks.map((c) => c.heading);
    expect(headings).toContain('Setup');
    expect(headings).toContain('Setup > Install');
  });

  it('gives text before any heading an empty heading breadcrumb', () => {
    const body = 'Intro paragraph with no heading above it.';
    const chunks = chunkNote(note({ body }));
    expect(chunks).toHaveLength(1);
    expect(chunks[0].heading).toBe('');
  });

  it('handles a body with no headings at all as a single section', () => {
    const body = 'Just some prose.\n\nAnd another paragraph.';
    const chunks = chunkNote(note({ body }));
    expect(chunks.every((c) => c.heading === '')).toBe(true);
  });

  it('builds a nested breadcrumb joined with " > "', () => {
    const body = '# Setup\n\nfoo\n\n## Install\n\nbar\n\n### Deps\n\nbaz';
    const chunks = chunkNote(note({ body }));
    const bazChunk = chunks.find((c) => c.raw.includes('baz'));
    expect(bazChunk.heading).toBe('Setup > Install > Deps');
  });

  it('resets deeper levels when a shallower heading follows', () => {
    const body = '# A\n\n## B\n\ntext-b\n\n# C\n\ntext-c';
    const chunks = chunkNote(note({ body }));
    const cChunk = chunks.find((c) => c.raw.includes('text-c'));
    expect(cChunk.heading).toBe('C');
  });

  it('emits a chunk for a heading-only section (no body before next heading)', () => {
    const body = '# Empty Section\n\n# Next Section\n\nsome text';
    const chunks = chunkNote(note({ body }));
    const emptySectionChunk = chunks.find((c) => c.heading === 'Empty Section');
    expect(emptySectionChunk).toBeDefined();
    expect(emptySectionChunk.raw).toContain('Empty Section');
    expect(emptySectionChunk.text).toContain('Empty Section');
  });

  it('includes the heading line itself in that section\'s first chunk raw', () => {
    const body = '## Install\n\nRun npm install.';
    const chunks = chunkNote(note({ body }));
    expect(chunks[0].raw).toContain('## Install');
    expect(chunks[0].raw).toContain('Run npm install.');
  });
});

describe('chunkNote — paragraph packing', () => {
  it('packs multiple small paragraphs under the cap into one chunk', () => {
    const body = 'Para one.\n\nPara two.\n\nPara three.';
    const chunks = chunkNote(note({ body }));
    expect(chunks).toHaveLength(1);
    expect(chunks[0].raw).toContain('Para one.');
    expect(chunks[0].raw).toContain('Para two.');
    expect(chunks[0].raw).toContain('Para three.');
  });

  it('starts a new chunk once the running total would exceed the cap', () => {
    // Two paragraphs, each under the cap alone, but together over it.
    const p1 = 'a'.repeat(1000);
    const p2 = 'b'.repeat(1000);
    const chunks = chunkNote(note({ body: `${p1}\n\n${p2}` }));
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.raw.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    }
  });

  it('hard-splits a single oversized paragraph at the cap', () => {
    const bigParagraph = 'x'.repeat(3000);
    const chunks = chunkNote(note({ body: bigParagraph }));
    expect(chunks.length).toBe(Math.ceil(3000 / MAX_CHUNK_CHARS));
    for (const c of chunks) {
      expect(c.raw.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    }
    // Reassembling the pieces recovers the original text.
    expect(chunks.map((c) => c.raw).join('')).toBe(bigParagraph);
  });
});

describe('chunkNote — fenced code blocks are atomic', () => {
  it('keeps a fence intact alongside surrounding paragraphs', () => {
    const body = 'Intro text.\n\n```js\nconst a = 1;\n```\n\nOutro text.';
    const chunks = chunkNote(note({ body }));
    const fenceChunk = chunks.find((c) => c.raw.includes('```'));
    expect(fenceChunk.raw).toContain('```js');
    expect(fenceChunk.raw).toContain('const a = 1;');
    expect(fenceChunk.raw).toContain('```');
    // Fence markers appear exactly twice (open + close), never split apart.
    expect(fenceChunk.raw.match(/```/g).length).toBe(2);
  });

  it('keeps an oversized fence as one whole chunk, exceeding the cap', () => {
    const bigCode = 'y = 1;\n'.repeat(400); // well over MAX_CHUNK_CHARS
    const body = `intro\n\n\`\`\`js\n${bigCode}\`\`\`\n\nend`;
    const chunks = chunkNote(note({ body }));
    const fenceChunk = chunks.find((c) => c.raw.includes('```js'));
    expect(fenceChunk).toBeDefined();
    expect(fenceChunk.raw.length).toBeGreaterThan(MAX_CHUNK_CHARS);
    expect(fenceChunk.raw.trim().endsWith('```')).toBe(true);
    // The fence was not merged with the neighboring paragraphs.
    expect(fenceChunk.raw).not.toContain('intro');
    expect(fenceChunk.raw).not.toContain('end');
  });

  it('treats an unclosed fence as running to the end of the body', () => {
    const body = 'before\n\n```js\nconst a = 1;\nno closing fence here';
    const chunks = chunkNote(note({ body }));
    const fenceChunk = chunks.find((c) => c.raw.includes('```js'));
    expect(fenceChunk.raw).toContain('const a = 1;');
    expect(fenceChunk.raw).toContain('no closing fence here');
  });
});

describe('chunkNote — CRLF normalization', () => {
  it('normalizes \\r\\n to \\n at entry and still splits correctly', () => {
    const body = '# Setup\r\n\r\nDo setup.\r\n\r\n## Install\r\n\r\nRun install.';
    const chunks = chunkNote(note({ body }));
    const headings = chunks.map((c) => c.heading);
    expect(headings).toContain('Setup');
    expect(headings).toContain('Setup > Install');
    for (const c of chunks) {
      expect(c.raw).not.toContain('\r');
    }
  });
});

describe('chunkNote — cleaned text', () => {
  it('collapses links to link text and drops the URL', () => {
    const body = 'See the [docs](https://example.com/path) for more.';
    const chunks = chunkNote(note({ body }));
    expect(chunks[0].text).toContain('docs');
    expect(chunks[0].text).not.toContain('https://example.com/path');
    // Original markdown link syntax is preserved in raw for prompting.
    expect(chunks[0].raw).toContain('[docs](https://example.com/path)');
  });

  it('collapses images to alt text and drops the URL', () => {
    const body = 'Look: ![a diagram](https://example.com/img.png) done.';
    const chunks = chunkNote(note({ body }));
    expect(chunks[0].text).toContain('a diagram');
    expect(chunks[0].text).not.toContain('https://example.com/img.png');
  });

  it('strips #, *, _, and backtick marks from prose text', () => {
    const body = '# Title\n\nThis is *bold* and _italic_ and `inline code`.';
    const chunks = chunkNote(note({ body }));
    const chunk = chunks.find((c) => c.text.includes('bold'));
    expect(chunk.text).not.toMatch(/[#*_`]/);
    expect(chunk.text).toContain('bold');
    expect(chunk.text).toContain('italic');
    expect(chunk.text).toContain('inline code');
  });

  it('keeps code content (identifiers) in cleaned text for search, without the fence marks', () => {
    const body = '```js\nfunction myUniqueIdentifier() { return 1; }\n```';
    const chunks = chunkNote(note({ body }));
    expect(chunks[0].text).toContain('myUniqueIdentifier');
    expect(chunks[0].text).not.toContain('```');
  });
});

describe('chunkNote — chunk ids and note metadata', () => {
  it('numbers chunk ids 0-based in document order as `${note.id}::${n}`', () => {
    const body = '# A\n\ntext a\n\n# B\n\ntext b\n\n# C\n\ntext c';
    const chunks = chunkNote(note({ id: 'abc123', body }));
    chunks.forEach((c, i) => {
      expect(c.id).toBe(`abc123::${i}`);
    });
    expect(chunks.length).toBeGreaterThanOrEqual(3);
  });

  it('stamps noteId and noteTitle on every chunk', () => {
    const body = 'one\n\ntwo';
    const chunks = chunkNote(note({ id: 'n42', title: 'Cool Note', body }));
    for (const c of chunks) {
      expect(c.noteId).toBe('n42');
      expect(c.noteTitle).toBe('Cool Note');
    }
  });
});

describe('MAX_CHUNK_CHARS export', () => {
  it('is 1400', () => {
    expect(MAX_CHUNK_CHARS).toBe(1400);
  });
});
