// fake-indexeddb/auto MUST be imported before anything touches indexedDB — it
// installs the in-memory IDB globals the module (and these tests) run against.
import 'fake-indexeddb/auto';
import { describe, it, expect, vi } from 'vitest';
import { createVectorIndex } from '../src/lib/vector-index.js';
import {
  EMBEDDING_DIMENSION,
  EMBEDDING_FINGERPRINT,
  EMBEDDING_MODEL_ID,
  EMBEDDING_MODEL_REVISION,
} from '../src/lib/embedding-config.js';

// Small, hand-built vector space (dim 4) so query ordering is asserted against
// KNOWN one-hot dims — never a coincidence of the fake embedder. The module is
// dim-agnostic; production uses 384-dim e5 vectors.
const DIM = 4;
function oneHot(i, dim = DIM) {
  const v = new Float32Array(dim);
  v[i] = 1;
  return v;
}

// Deterministic fake embedder: text -> a fixed one-hot vector via a lookup, so a
// hand-built query vector's dot product is exactly known. embed: async (texts[])
// => Float32Array[] — the injected V2 worker-client contract.
const VEC = { A: oneHot(0), B: oneHot(1), C: oneHot(2), D: oneHot(3) };
const embed = async (texts) => texts.map((t) => new Float32Array(VEC[t]));

// A three-note fixture; n2 carries two chunks so `chunks` != `notes` in stats.
const threeNotes = () => [
  { id: 'n1', hash: 'h1', chunks: [{ id: 'n1::0', text: 'A' }] },
  { id: 'n2', hash: 'h2', chunks: [{ id: 'n2::0', text: 'B' }, { id: 'n2::1', text: 'C' }] },
  { id: 'n3', hash: 'h3', chunks: [{ id: 'n3::0', text: 'D' }] },
];

// Fresh, unique db name per test — fake-indexeddb persists globally by name, so
// isolation demands a new name (except the persistence tests, which reuse one).
let dbSeq = 0;
const freshDb = () => `owl-test-vectors-${Date.now()}-${dbSeq++}`;
const TEST_FINGERPRINT = 'test-embedding-v1';
const makeIndex = () => makeIndexNamed(freshDb());

describe('createVectorIndex — open / lifecycle', () => {
  it('is not ready before open(); query is safe (returns [])', () => {
    const idx = makeIndex();
    expect(idx.stats()).toEqual({ notes: 0, chunks: 0, ready: false });
    expect(idx.query(oneHot(0))).toEqual([]);
  });

  it('open() makes it ready with empty stats and is safe to call twice', async () => {
    const idx = makeIndex();
    await idx.open();
    await idx.open(); // idempotent
    expect(idx.stats()).toEqual({ notes: 0, chunks: 0, ready: true });
  });

  it('writes the complete pinned embedding contract to metadata', async () => {
    const name = freshDb();
    await createVectorIndex({ dbName: name }).open();
    const row = await rawMetaGet(name, 'embedding');
    expect(row).toMatchObject({
      fingerprint: EMBEDDING_FINGERPRINT,
      model: EMBEDDING_MODEL_ID,
      revision: EMBEDDING_MODEL_REVISION,
      dimension: EMBEDDING_DIMENSION,
    });
  });

  it('clears persisted vectors and records the new fingerprint on mismatch', async () => {
    const name = freshDb();
    const old = makeIndexNamed(name, { embeddingFingerprint: 'old-space' });
    await old.open();
    await old.upsertMissing(threeNotes(), embed);
    expect(old.stats().chunks).toBe(4);

    const current = makeIndexNamed(name, { embeddingFingerprint: 'new-space' });
    await current.open();

    expect(current.stats()).toEqual({ notes: 0, chunks: 0, ready: true });
    expect((await rawMetaGet(name, 'embedding')).fingerprint).toBe('new-space');
  });

  it('treats a legacy database with no fingerprint as stale', async () => {
    const name = freshDb();
    const old = makeIndexNamed(name);
    await old.open();
    await old.upsertMissing(threeNotes(), embed);
    await rawMetaDelete(name, 'embedding');

    const reopened = makeIndexNamed(name);
    await reopened.open();

    expect(reopened.stats()).toEqual({ notes: 0, chunks: 0, ready: true });
    expect((await rawMetaGet(name, 'embedding')).fingerprint).toBe(TEST_FINGERPRINT);
  });
});

describe('createVectorIndex — upsertMissing + query', () => {
  it('embeds all notes, reports stats, and ranks the nearest chunk first (one-hot query)', async () => {
    const idx = makeIndex();
    await idx.open();
    await idx.upsertMissing(threeNotes(), embed);

    expect(idx.stats()).toEqual({ notes: 3, chunks: 4, ready: true });

    // query near n2's SECOND chunk (dim 2) -> that exact chunk first, score ~1.
    const hits = idx.query(oneHot(2));
    expect(hits[0].chunkId).toBe('n2::1');
    expect(hits[0].noteId).toBe('n2');
    expect(hits[0].score).toBeCloseTo(1, 6);
    // descending order: the top score is >= every following score.
    for (let i = 1; i < hits.length; i += 1) {
      expect(hits[0].score).toBeGreaterThanOrEqual(hits[i].score);
    }
  });

  it('honors k and returns [] for empty/absent query vectors', async () => {
    const idx = makeIndex();
    await idx.open();
    await idx.upsertMissing(threeNotes(), embed);
    expect(idx.query(oneHot(0), 2)).toHaveLength(2);
    expect(idx.query(new Float32Array(DIM), 0)).toEqual([]);
    expect(idx.query(undefined)).toEqual([]);
  });

  it('rejects query and document vectors from a different dimension', async () => {
    const idx = makeIndex();
    await idx.open();
    await idx.upsertMissing(threeNotes(), embed);

    expect(() => idx.query(oneHot(0, DIM - 1))).toThrow(/query dimension 3.*expected 4/);
    await expect(idx.upsertMissing([
      { id: 'bad', hash: 'bad', chunks: [{ id: 'bad::0', text: 'bad' }] },
    ], async () => [oneHot(0, DIM - 1)])).rejects.toThrow(/embedding dimension 3.*expected 4/);
    expect(idx.stats()).toEqual({ notes: 3, chunks: 4, ready: true });
  });

  it('breaks score ties deterministically by chunkId (ascending)', async () => {
    const idx = makeIndex();
    await idx.open();
    // Two notes whose only chunks share the SAME vector -> equal scores.
    await idx.upsertMissing([
      { id: 'b', hash: 'hb', chunks: [{ id: 'b::0', text: 'A' }] },
      { id: 'a', hash: 'ha', chunks: [{ id: 'a::0', text: 'A' }] },
    ], embed);
    const hits = idx.query(oneHot(0));
    expect(hits.map((h) => h.chunkId)).toEqual(['a::0', 'b::0']);
  });

  it('calls onProgress(done,total) once per EMBEDDED note', async () => {
    const idx = makeIndex();
    await idx.open();
    const onProgress = vi.fn();
    await idx.upsertMissing(threeNotes(), embed, { onProgress });
    expect(onProgress.mock.calls).toEqual([[1, 3], [2, 3], [3, 3]]);
  });
});

describe('createVectorIndex — incremental diff by hash', () => {
  it('skips unchanged notes entirely (embed NOT called for them)', async () => {
    const idx = makeIndex();
    await idx.open();
    const spy = vi.fn(embed);
    await idx.upsertMissing(threeNotes(), spy);
    expect(spy).toHaveBeenCalledTimes(3);

    spy.mockClear();
    await idx.upsertMissing(threeNotes(), spy); // same hashes
    expect(spy).not.toHaveBeenCalled();
    expect(idx.stats()).toEqual({ notes: 3, chunks: 4, ready: true });
  });

  it('replaces a changed note\'s chunk rows; a shrunk note\'s stale chunk does not linger', async () => {
    const idx = makeIndex();
    await idx.open();
    await idx.upsertMissing(threeNotes(), embed);
    // n2 had chunks at dims 1 and 2; confirm dim-2 chunk is present.
    expect(idx.query(oneHot(2))[0].chunkId).toBe('n2::1');

    // n2 changes hash and SHRINKS to a single chunk (drops n2::1). Re-embed n2::0
    // to dim 1 ('B') — a dim no other note occupies, so its rank is unambiguous.
    await idx.upsertMissing([
      { id: 'n2', hash: 'h2b', chunks: [{ id: 'n2::0', text: 'B' }] },
    ], embed);

    expect(idx.stats().chunks).toBe(3); // 4 -> 3, the stale row is gone
    expect(idx.query(oneHot(2)).some((h) => h.chunkId === 'n2::1')).toBe(false);
    // n2::0 was re-embedded to dim 1 now.
    expect(idx.query(oneHot(1))[0].chunkId).toBe('n2::0');
  });

  it('leaves notes absent from the input untouched', async () => {
    const idx = makeIndex();
    await idx.open();
    await idx.upsertMissing(threeNotes(), embed);
    // Upsert only n1 (changed) — n2/n3 are absent from the list.
    await idx.upsertMissing([
      { id: 'n1', hash: 'h1b', chunks: [{ id: 'n1::0', text: 'D' }] },
    ], embed);
    expect(idx.stats()).toEqual({ notes: 3, chunks: 4, ready: true });
    expect(idx.query(oneHot(1))[0].chunkId).toBe('n2::0'); // n2 still there
    expect(idx.query(oneHot(3))[0].chunkId).toBe('n1::0'); // n1 re-embedded to dim 3
  });
});

describe('createVectorIndex — removeNote', () => {
  it('deletes a note\'s chunks (query + stats) and no-ops for an unknown id', async () => {
    const idx = makeIndex();
    await idx.open();
    await idx.upsertMissing(threeNotes(), embed);

    await idx.removeNote('n2');
    expect(idx.stats()).toEqual({ notes: 2, chunks: 2, ready: true });
    expect(idx.query(oneHot(1)).some((h) => h.noteId === 'n2')).toBe(false);
    expect(idx.query(oneHot(2)).some((h) => h.noteId === 'n2')).toBe(false);

    await expect(idx.removeNote('nope')).resolves.toBeUndefined(); // no throw
    expect(idx.stats().notes).toBe(2);
  });
});

describe('createVectorIndex — persistence across instances', () => {
  it('a NEW instance on the same dbName serves identical query results (embed once, keep forever)', async () => {
    const name = freshDb();
    const a = makeIndexNamed(name);
    await a.open();
    await a.upsertMissing(threeNotes(), embed);
    const before = a.query(oneHot(2));

    const b = makeIndexNamed(name); // fresh instance, no upsert
    await b.open();
    const after = b.query(oneHot(2));

    expect(after).toEqual(before);
    expect(b.stats()).toEqual({ notes: 3, chunks: 4, ready: true });
  });

  it('round-trips fractional Float32 vectors through IndexedDB with no precision/type drift', async () => {
    const name = freshDb();
    // A normalized-ish fractional vector — exercises real float bytes, not 0/1.
    const frac = new Float32Array([0.5, -0.25, 0.125, -0.8125]);
    const fracEmbed = async (texts) => texts.map(() => new Float32Array(frac));

    const a = makeIndexNamed(name);
    await a.open();
    await a.upsertMissing([{ id: 'f', hash: 'hf', chunks: [{ id: 'f::0', text: 'x' }] }], fracEmbed);
    const before = a.query(frac);

    const b = makeIndexNamed(name);
    await b.open();
    const after = b.query(frac);

    expect(after).toEqual(before);
    // score is the exact dot(frac, frac) — proves the stored vector is bit-faithful.
    const expected = frac.reduce((s, x) => s + x * x, 0);
    expect(after[0].score).toBeCloseTo(expected, 6);
  });
});

describe('createVectorIndex — clear', () => {
  it('empties both the in-memory mirror and the persisted store', async () => {
    const name = freshDb();
    const a = makeIndexNamed(name);
    await a.open();
    await a.upsertMissing(threeNotes(), embed);

    await a.clear();
    expect(a.stats()).toEqual({ notes: 0, chunks: 0, ready: true });
    expect(a.query(oneHot(0))).toEqual([]);

    // A fresh instance sees the wipe too — the db really was cleared.
    const b = makeIndexNamed(name);
    await b.open();
    expect(b.stats()).toEqual({ notes: 0, chunks: 0, ready: true });
  });
});

describe('createVectorIndex — mid-upsert embed failure (atomicity)', () => {
  it('a rejection on note 2 keeps note 1 persisted, never attempts note 3, and does not corrupt', async () => {
    const name = freshDb();
    const idx = makeIndexNamed(name);
    await idx.open();

    const spy = vi.fn(async (texts) => texts.map((t) => {
      if (t === 'BOOM') throw new Error('embed failed');
      return new Float32Array(VEC[t]);
    }));
    const notes = [
      { id: 'n1', hash: 'h1', chunks: [{ id: 'n1::0', text: 'A' }] },
      { id: 'n2', hash: 'h2', chunks: [{ id: 'n2::0', text: 'BOOM' }] },
      { id: 'n3', hash: 'h3', chunks: [{ id: 'n3::0', text: 'D' }] },
    ];

    await expect(idx.upsertMissing(notes, spy)).rejects.toThrow('embed failed');

    // note 1 committed; note 3 NEVER attempted (embed called for n1 + n2 only).
    expect(spy).toHaveBeenCalledTimes(2);
    expect(idx.stats().chunks).toBe(1);
    expect(idx.query(oneHot(0))[0].chunkId).toBe('n1::0');
    expect(idx.query(oneHot(3)).some((h) => h.chunkId === 'n3::0')).toBe(false);

    // Persisted state matches memory — a fresh instance sees exactly note 1.
    const b = makeIndexNamed(name);
    await b.open();
    expect(b.stats()).toEqual({ notes: 1, chunks: 1, ready: true });
  });

  it('a rejection while re-embedding a CHANGED note leaves its OLD vector intact', async () => {
    const idx = makeIndex();
    await idx.open();
    await idx.upsertMissing(threeNotes(), embed); // n2::0 at dim 1

    const boomEmbed = async (texts) => texts.map((t) => {
      if (t === 'BOOM') throw new Error('embed failed');
      return new Float32Array(VEC[t]);
    });
    // n2 changes (new hash) but its re-embed throws; n1/n3 unchanged -> not touched.
    await expect(idx.upsertMissing([
      { id: 'n2', hash: 'h2b', chunks: [{ id: 'n2::0', text: 'BOOM' }] },
    ], boomEmbed)).rejects.toThrow('embed failed');

    // OLD n2::0 vector (dim 1) survives untouched.
    expect(idx.query(oneHot(1))[0].chunkId).toBe('n2::0');
    expect(idx.stats()).toEqual({ notes: 3, chunks: 4, ready: true });
  });
});

// --- helpers -------------------------------------------------------------
function makeIndexNamed(dbName, overrides = {}) {
  return createVectorIndex({
    dbName,
    embeddingFingerprint: TEST_FINGERPRINT,
    expectedDimension: DIM,
    ...overrides,
  });
}

// Raw IDB helpers used only to inspect/mutate migration metadata.
function rawMetaGet(dbName, key) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('meta', 'readonly');
      const g = tx.objectStore('meta').get(key);
      g.onsuccess = () => { resolve(g.result); db.close(); };
      g.onerror = () => { reject(g.error); db.close(); };
    };
    req.onerror = () => reject(req.error);
  });
}

function rawMetaDelete(dbName, key) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('meta', 'readwrite');
      tx.objectStore('meta').delete(key);
      tx.oncomplete = () => { resolve(); db.close(); };
      tx.onerror = () => { reject(tx.error); db.close(); };
      tx.onabort = () => { reject(tx.error); db.close(); };
    };
    req.onerror = () => reject(req.error);
  });
}
