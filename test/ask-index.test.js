import { describe, it, expect, beforeEach } from 'vitest';
import { createAskIndex } from '../src/lib/ask-index.js';

const note = (overrides = {}) => ({
  id: 'n1',
  title: 'Note One',
  body: 'body text',
  hash: 'h1',
  bookmarkId: 'bm1',
  localOnly: false,
  folderId: 'f1',
  ...overrides,
});

describe('createAskIndex — relevance and ranking', () => {
  it('ranks a term found in one note\'s title above the same term in another note\'s body', () => {
    const idx = createAskIndex();
    const titled = note({
      id: 'a',
      title: 'Gorgonzola Guide',
      body: 'Nothing about that food is mentioned here.',
    });
    const bodied = note({
      id: 'b',
      title: 'Cooking Tips',
      body: 'Gorgonzola cheese is delicious on pizza.',
    });
    idx.build([titled, bodied]);

    const results = idx.query('gorgonzola');
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[0].noteId).toBe('a');
  });

  it('returns chunks with .score, at most k results, and allows multiple chunks from one note', () => {
    const idx = createAskIndex();
    const body = '# One\n\nwidget one text\n\n# Two\n\nwidget two text\n\n# Three\n\nwidget three text';
    idx.build([note({ id: 'multi', body })]);

    const all = idx.query('widget');
    expect(all.length).toBe(3);
    for (const r of all) {
      expect(typeof r.score).toBe('number');
      expect(r.noteId).toBe('multi');
    }

    const limited = idx.query('widget', 2);
    expect(limited.length).toBe(2);
  });

  it('falls back from AND to OR when the AND query yields zero results', () => {
    const idx = createAskIndex();
    idx.build([note({ id: 'a', body: 'alpha appears here alone.' })]);

    // 'zzznomatchtermxyz' matches nothing, so a strict AND search finds
    // nothing even though 'alpha' alone would match.
    const results = idx.query('alpha zzznomatchtermxyz');
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.noteId === 'a')).toBe(true);
    // OR-retry results are tagged weak — the UI uses this to avoid presenting
    // stopword-noise matches as meaningful "Related notes" under ungrounded answers.
    expect(results.every((r) => r.weak === true)).toBe(true);
  });

  it('does NOT tag precise AND matches as weak', () => {
    const idx = createAskIndex();
    idx.build([note({ id: 'a', body: 'alpha appears here alone.' })]);
    const results = idx.query('alpha');
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.weak === undefined)).toBe(true);
  });

  it('supports prefix search ("recip" finds "recipes")', () => {
    const idx = createAskIndex();
    idx.build([note({ id: 'a', body: 'Try these recipes for dinner.' })]);

    const results = idx.query('recip');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].text).toContain('recipes');
  });
});

// [T10/M4.5 Part 2a] CJK bigram tokenizer. MiniSearch's default splits on
// whitespace/punctuation and can't tokenize unspaced CJK, so a CJK note would be
// unfindable. The custom tokenizer emits overlapping character bigrams for CJK runs
// (a SUPERSET — latin tokenization is byte-identical to the default, proven by the
// unchanged tests above/below all staying green).
describe('createAskIndex — CJK retrieval (bigram tokenizer)', () => {
  it('retrieves a Japanese-only note via a same-language query (bigram overlap)', () => {
    const idx = createAskIndex();
    idx.build([note({ id: 'jp', title: '日本語ノート', body: '猫が大好きです。犬も好きです。' })]);
    const results = idx.query('大好き');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].noteId).toBe('jp');
  });

  it('retrieves a Chinese-only note by an unspaced query substring', () => {
    const idx = createAskIndex();
    idx.build([note({ id: 'zh', title: '笔记', body: '我喜欢喝咖啡和茶。' })]);
    const results = idx.query('咖啡');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].noteId).toBe('zh');
  });

  it('still matches latin terms in a mixed latin+CJK note (superset, latin unchanged)', () => {
    const idx = createAskIndex();
    idx.build([note({ id: 'mix', title: 'Recipe レシピ', body: 'espresso コーヒー tips' })]);
    expect(idx.query('espresso').some((r) => r.noteId === 'mix')).toBe(true);
    expect(idx.query('コーヒー').some((r) => r.noteId === 'mix')).toBe(true);
  });
});

describe('createAskIndex — upsertNote', () => {
  it('is a no-op on chunks when the hash is unchanged, but still refreshes meta', () => {
    const idx = createAskIndex();
    const original = note({ id: 'a', body: 'a lighthouse on the cliff', hash: 'h1', folderId: 'f1' });
    idx.build([original]);
    const before = idx.query('lighthouse');
    expect(before.length).toBe(1);

    idx.upsertNote({ ...original, folderId: 'f2', body: 'completely different text now', hash: 'h1' });

    // Chunks untouched: old term still matches, new body was never indexed.
    const after = idx.query('lighthouse');
    expect(after.length).toBe(1);
    expect(after[0].id).toBe(before[0].id);
    expect(idx.query('completely')).toEqual([]);

    // Meta refreshed despite the unchanged hash.
    expect(idx.noteMeta('a').folderId).toBe('f2');
  });

  it('replaces chunks when the hash changes: old terms stop matching, new terms match', () => {
    const idx = createAskIndex();
    const original = note({ id: 'a', body: 'lighthouse keeper', hash: 'h1' });
    idx.build([original]);
    expect(idx.query('lighthouse').length).toBe(1);

    idx.upsertNote({ ...original, body: 'brand new harbor content', hash: 'h2' });

    expect(idx.query('lighthouse')).toEqual([]);
    const after = idx.query('harbor');
    expect(after.length).toBeGreaterThan(0);
    expect(after[0].noteId).toBe('a');
  });

  it('treats a missing hash as always-changed, reindexing on every upsert', () => {
    const idx = createAskIndex();
    idx.build([]);
    // Terms chosen far apart (not within fuzzy edit-distance of each other),
    // so a leftover match would signal a real bug, not fuzzy-search noise.
    const withoutHash = note({ id: 'x', body: 'first version firstmarker', hash: undefined });
    idx.upsertNote(withoutHash);
    expect(idx.query('firstmarker').length).toBe(1);

    idx.upsertNote({ ...withoutHash, body: 'second version secondtoken' });
    expect(idx.query('firstmarker')).toEqual([]);
    expect(idx.query('secondtoken').length).toBe(1);
  });
});

describe('createAskIndex — removeNote', () => {
  it('removes a note\'s chunks, drops it from stats, and no-ops for an unknown id', () => {
    const idx = createAskIndex();
    const a = note({ id: 'a', body: 'aardvark facts' });
    const b = note({ id: 'b', body: 'bumblebee facts' });
    idx.build([a, b]);

    idx.removeNote('a');
    expect(idx.query('aardvark')).toEqual([]);
    expect(idx.query('bumblebee').length).toBeGreaterThan(0);
    expect(idx.stats().notes).toBe(1);

    // Unknown id: no-op, no throw.
    expect(() => idx.removeNote('does-not-exist')).not.toThrow();
    expect(idx.stats().notes).toBe(1);
  });
});

describe('createAskIndex — noteMeta', () => {
  it('returns { bookmarkId, localOnly, folderId, title } captured at index time', () => {
    const idx = createAskIndex();
    idx.build([note({ id: 'a', title: 'My Title', bookmarkId: 'bm9', localOnly: true, folderId: 'f9' })]);

    expect(idx.noteMeta('a')).toEqual({
      bookmarkId: 'bm9',
      localOnly: true,
      folderId: 'f9',
      title: 'My Title',
    });
  });

  it('returns null/undefined for an unknown note id', () => {
    const idx = createAskIndex();
    idx.build([note({ id: 'a' })]);
    expect(idx.noteMeta('unknown')).toBeFalsy();
  });
});

describe('createAskIndex — stats', () => {
  it('reports accurate { notes, chunks } across build, upsert, and remove', () => {
    const idx = createAskIndex();
    const multi = note({
      id: 'a',
      body: '# One\n\ntext one\n\n# Two\n\ntext two\n\n# Three\n\ntext three',
    });
    const single = note({ id: 'b', body: 'just one chunk here' });
    idx.build([multi, single]);
    expect(idx.stats()).toEqual({ notes: 2, chunks: 4 });

    idx.upsertNote({ ...single, body: 'still one chunk', hash: 'h2' });
    expect(idx.stats()).toEqual({ notes: 2, chunks: 4 });

    idx.removeNote('a');
    expect(idx.stats()).toEqual({ notes: 1, chunks: 1 });
  });
});

describe('createAskIndex — empty input', () => {
  it('returns [] for an empty or whitespace-only query', () => {
    const idx = createAskIndex();
    idx.build([note({ id: 'a', body: 'some content here' })]);
    expect(idx.query('')).toEqual([]);
    expect(idx.query('   ')).toEqual([]);
  });

  it('build([]) resets to empty stats and query returns []', () => {
    const idx = createAskIndex();
    idx.build([note({ id: 'a', body: 'some content here' })]);
    idx.build([]);
    expect(idx.stats()).toEqual({ notes: 0, chunks: 0 });
    expect(idx.query('anything')).toEqual([]);
  });
});

// [Task E3] neighbors(chunkId): the adjacent stored chunks of the same note, by
// POSITION in the note's ordered chunkIds (never by string-parsing the ::n suffix,
// since note ids may contain '::'). Feeds fusion.expand's context enrichment.
describe('createAskIndex — neighbors', () => {
  // Three heading sections -> three ordered chunks (a::0, a::1, a::2).
  const multiBody = '# One\n\ntext one\n\n# Two\n\ntext two\n\n# Three\n\ntext three';

  it('middle chunk -> [prev, next] in that order', () => {
    const idx = createAskIndex();
    idx.build([note({ id: 'a', body: multiBody })]);
    const ids = idx.allChunks().map((c) => c.id);
    expect(ids.length).toBe(3);
    expect(idx.neighbors(ids[1]).map((c) => c.id)).toEqual([ids[0], ids[2]]);
  });

  it('first chunk -> [next] only', () => {
    const idx = createAskIndex();
    idx.build([note({ id: 'a', body: multiBody })]);
    const ids = idx.allChunks().map((c) => c.id);
    expect(idx.neighbors(ids[0]).map((c) => c.id)).toEqual([ids[1]]);
  });

  it('last chunk -> [prev] only', () => {
    const idx = createAskIndex();
    idx.build([note({ id: 'a', body: multiBody })]);
    const ids = idx.allChunks().map((c) => c.id);
    expect(idx.neighbors(ids[2]).map((c) => c.id)).toEqual([ids[1]]);
  });

  it('single-chunk note -> []', () => {
    const idx = createAskIndex();
    idx.build([note({ id: 's', body: 'just one chunk here' })]);
    const only = idx.allChunks()[0].id;
    expect(idx.neighbors(only)).toEqual([]);
  });

  it('unknown / malformed id -> [] (never throws)', () => {
    const idx = createAskIndex();
    idx.build([note({ id: 'a', body: multiBody })]);
    expect(() => idx.neighbors('nope::99')).not.toThrow();
    expect(idx.neighbors('nope::99')).toEqual([]);
    expect(idx.neighbors(undefined)).toEqual([]);
    expect(idx.neighbors(null)).toEqual([]);
    expect(idx.neighbors('')).toEqual([]);
  });

  it('returns full stored chunk objects (noteId + text + raw), not bare ids', () => {
    const idx = createAskIndex();
    idx.build([note({ id: 'a', body: multiBody })]);
    const ids = idx.allChunks().map((c) => c.id);
    const [prev, next] = idx.neighbors(ids[1]);
    for (const nb of [prev, next]) {
      expect(nb.noteId).toBe('a');
      expect(typeof nb.text).toBe('string');
      expect(typeof nb.raw).toBe('string');
    }
    expect(prev.id).toBe(ids[0]);
    expect(next.id).toBe(ids[2]);
  });

  it('locates position by chunkIds even when the note id itself contains "::"', () => {
    const idx = createAskIndex();
    idx.build([note({ id: 'weird::note::id', body: multiBody })]);
    const ids = idx.allChunks().map((c) => c.id); // e.g. weird::note::id::0, ::1, ::2
    expect(ids.length).toBe(3);
    expect(idx.neighbors(ids[1]).map((c) => c.id)).toEqual([ids[0], ids[2]]);
  });
});

// [Task E7] chunksOf(noteId): the ordered stored chunks of a note (its full chunk
// set, in document order) — used to pin the currently-open note into the model
// context. Same notes-Map → getStoredFields pattern as neighbors(); unknown id → [].
describe('createAskIndex — chunksOf', () => {
  const multiBody = '# One\n\ntext one\n\n# Two\n\ntext two\n\n# Three\n\ntext three';

  it('returns every stored chunk of the note in document order', () => {
    const idx = createAskIndex();
    idx.build([note({ id: 'a', body: multiBody })]);
    const allIds = idx.allChunks().map((c) => c.id);
    expect(allIds.length).toBe(3);
    expect(idx.chunksOf('a').map((c) => c.id)).toEqual(allIds);
  });

  it('returns full stored chunk objects (noteId + text + raw), not bare ids', () => {
    const idx = createAskIndex();
    idx.build([note({ id: 'a', body: multiBody })]);
    for (const c of idx.chunksOf('a')) {
      expect(c.noteId).toBe('a');
      expect(typeof c.text).toBe('string');
      expect(typeof c.raw).toBe('string');
    }
  });

  it('unknown / undefined id → [] (never throws)', () => {
    const idx = createAskIndex();
    idx.build([note({ id: 'a', body: multiBody })]);
    expect(() => idx.chunksOf('nope')).not.toThrow();
    expect(idx.chunksOf('nope')).toEqual([]);
    expect(idx.chunksOf(undefined)).toEqual([]);
    expect(idx.chunksOf(null)).toEqual([]);
  });

  it('reflects only the CURRENT chunk set after a content change', () => {
    const idx = createAskIndex();
    idx.build([note({ id: 'a', body: multiBody, hash: 'h1' })]);
    expect(idx.chunksOf('a').length).toBe(3);
    idx.upsertNote(note({ id: 'a', body: 'just one chunk now', hash: 'h2' }));
    expect(idx.chunksOf('a').length).toBe(1);
  });
});

describe('createAskIndex — allChunks', () => {
  it('returns every stored chunk currently indexed', () => {
    const idx = createAskIndex();
    const multi = note({
      id: 'a',
      body: '# One\n\ntext one\n\n# Two\n\ntext two',
    });
    idx.build([multi]);
    const chunks = idx.allChunks();
    expect(chunks.length).toBe(2);
    expect(chunks.every((c) => c.noteId === 'a')).toBe(true);
    expect(chunks.every((c) => typeof c.text === 'string')).toBe(true);
  });
});
