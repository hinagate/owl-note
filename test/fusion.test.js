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
