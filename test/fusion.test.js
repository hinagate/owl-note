import { describe, it, expect } from 'vitest';
import { createAskIndex } from '../src/lib/ask-index.js';
import { createFusion } from '../src/lib/fusion.js';

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
