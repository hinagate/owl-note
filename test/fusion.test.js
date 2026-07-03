import { describe, it, expect } from 'vitest';
import { createAskIndex } from '../src/lib/ask-index.js';
import { createFusion, rrfFuse, FUSION_WEIGHTS, RRF_K } from '../src/lib/fusion.js';

const note = (o) => ({ id: 'x', title: 'T', body: '', hash: 'h', ...o });

// Fusion is a thin, dependency-injected passthrough in P1: the controller depends
// on `fusion`, not the index, so P3 can swap vector+RRF behind the same shape. So
// the honest test is a REAL index over a couple of notes — assert fusion returns
// exactly what the index does.
describe('createFusion — lexical passthrough over a real index', () => {
  it('returns the same ranked chunks the underlying index returns', async () => {
    const idx = createAskIndex();
    idx.build([
      note({ id: 'a', title: 'Gardening', body: 'Compost improves the soil health of a bed.' }),
      note({ id: 'b', title: 'Cooking', body: 'Fresh basil pairs well with ripe tomato.' }),
    ]);
    const fusion = createFusion(idx);

    const viaIndex = idx.query('compost', 8);
    const viaFusion = await fusion.query('compost', 8);

    expect(viaFusion.length).toBeGreaterThan(0);
    expect(viaFusion[0].noteId).toBe('a');
    // Same chunk contents, in the same order, with the same scores.
    expect(viaFusion).toEqual(viaIndex);
  });

  it('respects k', async () => {
    const idx = createAskIndex();
    idx.build([
      note({ id: 'm', body: '# One\n\nwidget one text\n\n# Two\n\nwidget two text\n\n# Three\n\nwidget three text' }),
    ]);
    const fusion = createFusion(idx);

    expect((await fusion.query('widget', 8)).length).toBe(3);
    expect((await fusion.query('widget', 2)).length).toBe(2);
  });

  it('defaults k to 8 when not supplied (proven by spying on the index)', async () => {
    const calls = [];
    const fakeIndex = { query: (q, k) => { calls.push([q, k]); return []; } };
    const fusion = createFusion(fakeIndex);

    await fusion.query('anything');

    expect(calls).toEqual([['anything', 8]]);
  });

  it('returns [] for an empty or whitespace-only query', async () => {
    const idx = createAskIndex();
    idx.build([note({ id: 'a', body: 'some content here' })]);
    const fusion = createFusion(idx);

    expect(await fusion.query('')).toEqual([]);
    expect(await fusion.query('   ')).toEqual([]);
  });

  it('exposes query as an async method (returns a promise)', () => {
    const idx = createAskIndex();
    idx.build([note({ id: 'a', body: 'promise content' })]);
    const fusion = createFusion(idx);

    // P3's fusion awaits an embedder, so query must stay async even in P1.
    expect(fusion.query('promise')).toBeInstanceOf(Promise);
  });
});

// [Task E3] expand(chunks): primaries first (order unchanged), then neighbors
// APPENDED after ALL primaries in parent-rank order (dedup by id, per-note cap 3,
// total cap 12). Neighbors are speculative context that only consumes leftover
// packing budget — they never displace a direct query hit.
describe('createFusion — expand (neighbor enrichment)', () => {
  // Minimal chunk fixture matching the retrieval shape.
  const ch = (id, noteId, extra = {}) =>
    ({ id, noteId, noteTitle: 'T', heading: '', text: id, raw: id, ...extra });

  // A fake index whose neighbors() is a lookup table keyed by chunk id.
  const fakeIndex = (neighborMap = {}) => ({
    query: () => [],
    neighbors: (id) => neighborMap[id] || [],
  });

  it('appends neighbors after ALL primaries, in parent-rank order', async () => {
    const primaries = [ch('A::0', 'A', { score: 2 }), ch('B::0', 'B', { score: 1 })];
    const fusion = createFusion(fakeIndex({
      'A::0': [ch('A::1', 'A')],
      'B::0': [ch('B::1', 'B')],
    }));

    const out = await fusion.expand(primaries);
    // Primaries first (in rank order), then each primary's neighbors in rank order.
    expect(out.map((c) => c.id)).toEqual(['A::0', 'B::0', 'A::1', 'B::1']);
  });

  it('keeps primary order/scores unchanged and does not add a score to neighbors', async () => {
    const primaries = [ch('A::0', 'A', { score: 9 })];
    const fusion = createFusion(fakeIndex({ 'A::0': [ch('A::1', 'A')] }));

    const out = await fusion.expand(primaries);
    expect(out[0]).toBe(primaries[0]); // same primary object, untouched
    expect(out[0].score).toBe(9);
    expect(out[1].id).toBe('A::1');
    expect(out[1].score).toBeUndefined(); // neighbors carry no score (speculative context)
  });

  it('dedups: a neighbor that is already a primary (or earlier neighbor) is skipped', async () => {
    const primaries = [ch('A::0', 'A'), ch('B::0', 'B')];
    const fusion = createFusion(fakeIndex({
      'A::0': [ch('B::0', 'B'), ch('A::1', 'A')], // B::0 is already a primary
      'B::0': [ch('B::1', 'B')],
    }));

    const out = await fusion.expand(primaries);
    expect(out.map((c) => c.id)).toEqual(['A::0', 'B::0', 'A::1', 'B::1']);
    // B::0 appears exactly once (not re-added as a neighbor).
    expect(out.filter((c) => c.id === 'B::0').length).toBe(1);
  });

  it('per-note cap 3: drops excess neighbors, never a primary', async () => {
    const primaries = [ch('A::0', 'A'), ch('A::1', 'A')]; // 2 primaries of note A
    const fusion = createFusion(fakeIndex({
      'A::0': [ch('A::5', 'A'), ch('A::6', 'A')],
      'A::1': [ch('A::7', 'A')],
    }));

    const out = await fusion.expand(primaries);
    // Note A caps at 3: the 2 primaries + exactly ONE neighbor (A::5, first in
    // parent-rank order); A::6 and A::7 are dropped. Both primaries survive.
    expect(out.map((c) => c.id)).toEqual(['A::0', 'A::1', 'A::5']);
  });

  it('per-note cap: a note already at 3 primaries gains NO neighbors (primaries all kept)', async () => {
    const primaries = [ch('A::0', 'A'), ch('A::1', 'A'), ch('A::2', 'A')];
    const fusion = createFusion(fakeIndex({
      'A::0': [ch('A::8', 'A')],
      'A::1': [ch('A::9', 'A')],
      'A::2': [ch('A::10', 'A')],
    }));

    const out = await fusion.expand(primaries);
    expect(out.map((c) => c.id)).toEqual(['A::0', 'A::1', 'A::2']);
  });

  it('total cap 12: never exceeds 12 chunks, primaries first', async () => {
    // 10 primaries across 10 distinct notes, each with one neighbor -> 20 candidates.
    const primaries = Array.from({ length: 10 }, (_, i) => ch(`P${i}`, `N${i}`));
    const neighborMap = {};
    for (let i = 0; i < 10; i += 1) neighborMap[`P${i}`] = [ch(`Q${i}`, `N${i}`)];
    const fusion = createFusion(fakeIndex(neighborMap));

    const out = await fusion.expand(primaries);
    expect(out.length).toBe(12);
    // The first 10 are the primaries (never displaced); only 2 neighbors fit.
    expect(out.slice(0, 10).map((c) => c.id)).toEqual(primaries.map((c) => c.id));
    expect(out.slice(10).map((c) => c.id)).toEqual(['Q0', 'Q1']);
  });

  it('chunks without neighbors pass through unchanged', async () => {
    const primaries = [ch('A::0', 'A'), ch('B::0', 'B')];
    const fusion = createFusion(fakeIndex({})); // no neighbors for anyone

    const out = await fusion.expand(primaries);
    expect(out.map((c) => c.id)).toEqual(['A::0', 'B::0']);
  });

  it('empty / non-array input -> []', async () => {
    const fusion = createFusion(fakeIndex({}));
    expect(await fusion.expand([])).toEqual([]);
    expect(await fusion.expand(undefined)).toEqual([]);
    expect(await fusion.expand(null)).toEqual([]);
  });

  it('over a REAL index: expands a lone hit with its actual note neighbors', async () => {
    const idx = createAskIndex();
    idx.build([
      note({ id: 'doc', body: '# One\n\nalpha uno\n\n# Two\n\nbeta solo\n\n# Three\n\ngamma tres' }),
    ]);
    const fusion = createFusion(idx);

    const primaries = await fusion.query('beta', 8);
    expect(primaries.map((c) => c.id).length).toBe(1); // only the middle chunk hits

    const out = await fusion.expand(primaries);
    const neighborIds = idx.neighbors(primaries[0].id).map((c) => c.id);
    expect(neighborIds.length).toBe(2); // prev + next
    // Primary first, then its two real neighbors appended.
    expect(out.map((c) => c.id)).toEqual([primaries[0].id, ...neighborIds]);
  });
});

// [Task V3] rrfFuse is the PURE weighted-RRF helper, EXPORTED so eval/run-vector.mjs
// imports the identical math the runtime uses (they can't drift). Unit-tested here
// directly so the shared contract is locked independently of createFusion.
describe('rrfFuse — pure weighted Reciprocal Rank Fusion (shared with the eval)', () => {
  const c = (id) => ({ id, noteId: id });

  it('exports the eval-tuned weights and the RRF constant', () => {
    expect(FUSION_WEIGHTS).toEqual({ lexical: 1, vector: 3 });
    expect(RRF_K).toBe(60);
  });

  it('sums per-list weighted reciprocal ranks (weights [1,3], k=60)', () => {
    const lex = [c('A'), c('C')]; // A rank1, C rank2
    const vec = [c('B'), c('C')]; // B rank1, C rank2
    const out = rrfFuse([lex, vec], [1, 3], 60);
    // A: 1/61 ; B: 3/61 ; C: 1/62 + 3/62 = 4/62 → desc: C, B, A.
    expect(out.map((x) => x.id)).toEqual(['C', 'B', 'A']);
    expect(out[0].score).toBeCloseTo(4 / 62, 12);
    expect(out[1].score).toBeCloseTo(3 / 61, 12);
    expect(out[2].score).toBeCloseTo(1 / 61, 12);
  });

  it('defaults a missing weight to 1 and k to RRF_K, tie-breaking by id ascending', () => {
    const out = rrfFuse([[c('B')], [c('A')]]); // equal weight 1, k=60 → A,B tie on score
    expect(out.map((x) => x.id)).toEqual(['A', 'B']); // deterministic id-ascending tie-break
    expect(out[0].score).toBeCloseTo(1 / (RRF_K + 1), 12);
  });

  it('dedupes by id (first-seen object wins) and returns copies carrying .score', () => {
    const weak = { id: 'C', noteId: 'C', weak: true }; // lexical (first list)
    const plain = { id: 'C', noteId: 'C' };            // vector (second list)
    const out = rrfFuse([[weak], [plain]], [1, 3], 60);
    expect(out.length).toBe(1);          // one distinct id
    expect(out[0].weak).toBe(true);      // first-seen (lexical) object preserved
    expect(out[0]).not.toBe(weak);       // a copy, not the input reference
    expect(out[0].score).toBeCloseTo(1 / 61 + 3 / 61, 12);
  });
});

// [Task V3] Hybrid retrieval: weighted RRF over the lexical list + a vector list,
// with the lexical result as a never-fail fallback. FUSION_WEIGHTS = { lexical: 1,
// vector: 3 } (tuned in eval/RESULTS.md's sweep). These use a REAL ask-index (so
// query/chunkById are the shipped code) with a FAKE vector index + embedQuery, so the
// two rank lists — and thus the hand-computed RRF math — are fully deterministic.
describe('createFusion — hybrid (weighted RRF) retrieval', () => {
  // A real index whose lexical query('widget') returns note A (title match → rank 1)
  // then note C (body match → rank 2). Note B does NOT contain 'widget', so it is
  // lexical-invisible yet still indexed (chunkById resolves it) — it reaches the
  // result ONLY through the vector list.
  function realIndexABC() {
    const idx = createAskIndex();
    idx.build([
      note({ id: 'A', title: 'Widget Guide', body: 'alpha content here' }),
      note({ id: 'C', title: 'Cee', body: 'a widget lives in this body' }),
      note({ id: 'B', title: 'Bee', body: 'entirely unrelated material' }),
    ]);
    const id = {};
    for (const ch of idx.allChunks()) id[ch.noteId] = ch.id;
    return { idx, id };
  }

  const readyVector = (hits) => ({
    stats: () => ({ notes: 3, chunks: 3, ready: true }),
    query: () => hits,
  });
  const embedOK = async () => new Float32Array([1, 0, 0]);

  it('orders results by hand-computed weighted RRF (A lex-only, B vec-only, C in both)', async () => {
    const { idx, id } = realIndexABC();
    // sanity: the lexical list really is [A, C].
    expect(idx.query('widget', 8).map((ch) => ch.noteId)).toEqual(['A', 'C']);

    const vector = readyVector([
      { chunkId: id.B, noteId: 'B', score: 0.9 }, // vector rank 1
      { chunkId: id.C, noteId: 'C', score: 0.8 }, // vector rank 2
    ]);
    const fusion = createFusion(idx, { vector, embedQuery: embedOK });

    const out = await fusion.query('widget', 8);

    // Hand math — weights [lexical 1, vector 3], k = 60, 1-based ranks:
    //   A: lex r1          = 1/61          = 0.016393
    //   B: vec r1          = 3/61          = 0.049180
    //   C: lex r2 + vec r2 = 1/62 + 3/62   = 4/62 = 0.064516
    // descending → C, B, A.
    expect(out.map((ch) => ch.noteId)).toEqual(['C', 'B', 'A']);
    expect(out[0].score).toBeCloseTo(4 / 62, 10);
    expect(out[1].score).toBeCloseTo(3 / 61, 10);
    expect(out[2].score).toBeCloseTo(1 / 61, 10);
    // C is in BOTH lists but appears exactly once (deduped).
    expect(out.filter((ch) => ch.noteId === 'C').length).toBe(1);
  });

  it('resolves vector-only chunks via chunkById and drops a stale id (no ghost chunk)', async () => {
    const { idx, id } = realIndexABC();
    const vector = readyVector([
      { chunkId: 'ghost::404', noteId: 'GONE', score: 0.99 }, // NOT in the lexical index
      { chunkId: id.A, noteId: 'A', score: 0.80 },
    ]);
    const fusion = createFusion(idx, { vector, embedQuery: embedOK });

    const out = await fusion.query('widget', 8);
    // The stale id never surfaces...
    expect(out.map((ch) => ch.id)).not.toContain('ghost::404');
    expect(out.every((ch) => ch.noteId !== 'GONE')).toBe(true);
    // ...only the real chunks do (A from both lists, C from the lexical list).
    expect(out.map((ch) => ch.noteId).sort()).toEqual(['A', 'C']);
  });

  it('falls back to the lexical result when embedQuery rejects — vector.query is never consulted', async () => {
    const { idx } = realIndexABC();
    let vectorQueried = 0;
    const vector = {
      stats: () => ({ notes: 3, chunks: 3, ready: true }),
      query: () => { vectorQueried += 1; return []; },
    };
    const embedQuery = async () => { throw new Error('embedder unavailable'); };
    const fusion = createFusion(idx, { vector, embedQuery });

    const out = await fusion.query('widget', 8);
    // Identical to a pure lexical query — an ask never fails because vectors hiccup.
    expect(out).toEqual(idx.query('widget', 8));
    // embedQuery rejected BEFORE vector.query could be reached.
    expect(vectorQueried).toBe(0);
  });

  it('short-circuits to lexical when the vector index is not ready — embedQuery is never called', async () => {
    const { idx } = realIndexABC();
    let embedCalls = 0;
    const embedQuery = async () => { embedCalls += 1; return new Float32Array([1]); };
    const throwingQuery = () => { throw new Error('vector.query must not be called'); };

    // Both not-ready signals: ready:false, and ready but chunks:0.
    for (const stats of [{ notes: 0, chunks: 0, ready: false }, { notes: 3, chunks: 0, ready: true }]) {
      const vector = { stats: () => stats, query: throwingQuery };
      const fusion = createFusion(idx, { vector, embedQuery });
      const out = await fusion.query('widget', 8);
      expect(out).toEqual(idx.query('widget', 8));
    }
    expect(embedCalls).toBe(0);
  });

  it('preserves a lexical weak flag through fusion; vector-only chunks carry none', async () => {
    const idx = createAskIndex();
    idx.build([
      note({ id: 'A', body: 'alpha lonely word' }),
      note({ id: 'B', body: 'beta distinct material' }),
    ]);
    const id = {};
    for (const ch of idx.allChunks()) id[ch.noteId] = ch.id;

    // 'alpha zzznope' has no AND match (zzznope matches nothing) → OR retry → weak.
    const weakLex = idx.query('alpha zzznope', 8);
    expect(weakLex.length).toBe(1);
    expect(weakLex[0].noteId).toBe('A');
    expect(weakLex[0].weak).toBe(true);

    const vector = readyVector([{ chunkId: id.B, noteId: 'B', score: 0.9 }]);
    const fusion = createFusion(idx, { vector, embedQuery: embedOK });

    const out = await fusion.query('alpha zzznope', 8);
    const a = out.find((ch) => ch.noteId === 'A');
    const b = out.find((ch) => ch.noteId === 'B');
    expect(a.weak).toBe(true);       // lexical weak flag survives fusion
    expect(b.weak).toBeUndefined();  // vector-only chunk was never weak-tagged
  });

  it('respects k, cutting the fused list to the requested size', async () => {
    const { idx, id } = realIndexABC();
    const vector = readyVector([
      { chunkId: id.B, noteId: 'B', score: 0.9 },
      { chunkId: id.C, noteId: 'C', score: 0.8 },
    ]);
    const fusion = createFusion(idx, { vector, embedQuery: embedOK });

    expect((await fusion.query('widget', 8)).length).toBe(3); // C, B, A
    const top2 = await fusion.query('widget', 2);
    expect(top2.map((ch) => ch.noteId)).toEqual(['C', 'B']); // top-2 of the fused order
  });
});
