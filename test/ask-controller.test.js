import { describe, it, expect } from 'vitest';
import { createAskIndex } from '../src/lib/ask-index.js';
import { createFusion } from '../src/lib/fusion.js';
import { createAskController } from '../src/lib/ask-controller.js';
import { AskError } from '../src/lib/providers/provider.js';

// ---------------------------------------------------------------------------
// Fixtures. We use a REAL index + REAL fusion over a few notes so fusion returns
// genuine chunks (honest citation mapping), and INJECT a configurable fake
// provider + fake registry — that dependency-injection seam is the whole design
// exhibit the controller is built around.
// ---------------------------------------------------------------------------

function realIndex() {
  const idx = createAskIndex();
  idx.build([
    { id: 'n1', title: 'Espresso', body: 'Tamp the coffee grounds evenly before pulling a shot.', hash: 'h1' },
    { id: 'n2', title: 'Kubernetes', body: 'A pod is the smallest deployable unit in a cluster.', hash: 'h2' },
    { id: 'n3', title: 'Sourdough', body: 'Feed the starter with flour and water each morning.', hash: 'h3' },
  ]);
  return idx;
}

// Each behavior is overridable; call counts are recorded so a test can assert the
// model was (or was NOT) invoked.
function fakeProvider(cfg = {}) {
  const calls = { availability: 0, answer: [], ensureReady: [] };
  return {
    id: cfg.id || 'fake',
    label: cfg.label || 'Fake',
    capabilities: () => cfg.capabilities || { streaming: false, jsonSchema: false },
    availability: () => {
      calls.availability += 1;
      if (cfg.availabilityThrows) return Promise.reject(cfg.availabilityThrows);
      return Promise.resolve(cfg.availability ?? 'available');
    },
    answer: (req) => {
      calls.answer.push(req);
      return cfg.answer ? cfg.answer(req) : Promise.resolve({ answer: 'A', citations: [], grounded: true });
    },
    ensureReady: (onProgress) => {
      calls.ensureReady.push(onProgress);
      return cfg.ensureReady ? cfg.ensureReady(onProgress) : Promise.resolve();
    },
    _calls: calls,
  };
}

const fakeRegistry = (provider) => ({ getActiveProvider: () => provider });

function recorder() {
  const states = [];
  return { states, onState: (s) => states.push(s) };
}

const kinds = (states) => states.map((s) => s.kind);
const last = (states) => states[states.length - 1];
// Flush both micro- and macro-task queues so async controller steps settle.
const flush = () => new Promise((r) => setTimeout(r));

function makeController(idx, provider) {
  const rec = recorder();
  const ctrl = createAskController({
    index: idx,
    fusion: createFusion(idx),
    registry: fakeRegistry(provider),
    onState: rec.onState,
  });
  return { ctrl, ...rec };
}

// ---------------------------------------------------------------------------

describe('createAskController — happy path', () => {
  it('available → searching → generating → answered, citations mapped to Chunk objects', async () => {
    const idx = realIndex();
    const hits = idx.query('coffee', 8);
    const citedId = hits[0].id;
    const provider = fakeProvider({
      id: 'builtin',
      availability: 'available',
      answer: () => Promise.resolve({ answer: 'Answer text', citations: [citedId], grounded: true }),
    });
    const { ctrl, states } = makeController(idx, provider);

    await ctrl.ask('coffee');

    expect(kinds(states)).toEqual(['searching', 'generating', 'answered']);
    const ans = last(states);
    expect(ans.usedModel).toBe(true);
    expect(ans.provider).toBe('builtin');
    expect(ans.grounded).toBe(true);
    expect(ans.answer).toBe('Answer text');
    // Citations are Chunk objects (subset of what was sent), NOT raw id strings.
    expect(ans.citations.length).toBe(1);
    expect(typeof ans.citations[0]).toBe('object');
    expect(ans.citations[0].id).toBe(citedId);
    expect(ans.citations[0].text).toBe(hits[0].text);

    // The provider received { question, chunks, signal }.
    expect(provider._calls.answer.length).toBe(1);
    const req = provider._calls.answer[0];
    expect(req.question).toBe('coffee');
    expect(req.chunks.length).toBeGreaterThan(0);
    expect(req.signal).toBeInstanceOf(AbortSignal);
  });

  it('drops a cited id that is not among the sent chunks', async () => {
    const idx = realIndex();
    const goodId = idx.query('pod', 8)[0].id;
    const provider = fakeProvider({
      availability: 'available',
      answer: () => Promise.resolve({ answer: 'A', citations: [goodId, 'bogus::99'], grounded: true }),
    });
    const { ctrl, states } = makeController(idx, provider);

    await ctrl.ask('pod');

    expect(last(states).citations.map((c) => c.id)).toEqual([goodId]);
  });
});

// [Task E3] The generation path enriches what the MODEL sees with neighbor chunks
// (answers often straddle a chunk boundary), while generating/error states and the
// snippet cards keep the PRIMARY chunks. A neighbor the model cites must still
// resolve back to a real Chunk.
describe('createAskController — neighbor-expanded model context', () => {
  // A single note that chunks into three sections; querying 'beta' hits only the
  // middle chunk, so expansion appends its two real neighbors (prev + next).
  function multiChunkIndex() {
    const idx = createAskIndex();
    idx.build([
      { id: 'doc', title: 'Doc', body: '# One\n\nalpha uno\n\n# Two\n\nbeta solo\n\n# Three\n\ngamma tres', hash: 'h' },
    ]);
    return idx;
  }

  it('sends the EXPANDED context to the model while generating/answered keep primaries; a cited neighbor resolves to a Chunk', async () => {
    const idx = multiChunkIndex();
    const primaries = idx.query('beta', 8);
    expect(primaries.length).toBe(1); // sanity: lone middle-chunk hit
    const neighborIds = idx.neighbors(primaries[0].id).map((c) => c.id);
    expect(neighborIds.length).toBe(2);
    const citedNeighbor = neighborIds[0]; // model cites a NEIGHBOR, not the primary

    const provider = fakeProvider({
      id: 'builtin',
      availability: 'available',
      answer: () => Promise.resolve({ answer: 'A', citations: [citedNeighbor], grounded: true }),
    });
    const { ctrl, states } = makeController(idx, provider);

    await ctrl.ask('beta');

    // generating state carries ONLY the primaries (snippet cards stay one-per-hit).
    const gen = states.find((s) => s.kind === 'generating');
    expect(gen.chunks.map((c) => c.id)).toEqual(primaries.map((c) => c.id));

    // The provider received the EXPANDED set: primary + its two neighbors.
    expect(provider._calls.answer.length).toBe(1);
    const sent = provider._calls.answer[0].chunks;
    expect(sent.map((c) => c.id)).toEqual([primaries[0].id, ...neighborIds]);

    // A citation belonging to a NEIGHBOR resolves to a real Chunk object.
    const ans = last(states);
    expect(ans.citations.length).toBe(1);
    expect(typeof ans.citations[0]).toBe('object');
    expect(ans.citations[0].id).toBe(citedNeighbor);
    expect(neighborIds).toContain(ans.citations[0].id); // it was NOT a primary
  });

  it('error on the generation path keeps the PRIMARY chunks, not the expanded set', async () => {
    const idx = multiChunkIndex();
    const primaries = idx.query('beta', 8);
    const provider = fakeProvider({
      availability: 'available',
      answer: () => Promise.reject(new AskError('network', 'offline')),
    });
    const { ctrl, states } = makeController(idx, provider);

    await ctrl.ask('beta');

    const err = last(states);
    expect(err.kind).toBe('error');
    expect(err.chunks.map((c) => c.id)).toEqual(primaries.map((c) => c.id));
  });

  it('snippets path does NOT expand: snippet cards stay the primary hits', async () => {
    const idx = multiChunkIndex();
    const primaries = idx.query('beta', 8);
    const provider = fakeProvider({ availability: 'unavailable' });
    const { ctrl, states } = makeController(idx, provider);

    await ctrl.ask('beta');

    const snip = last(states);
    expect(snip.kind).toBe('snippets');
    expect(snip.chunks.map((c) => c.id)).toEqual(primaries.map((c) => c.id));
    expect(provider._calls.answer.length).toBe(0);
  });
});

describe('createAskController — retrieval-only paths (model never called)', () => {
  it('unavailable → searching → snippets(model-unavailable)', async () => {
    const idx = realIndex();
    const provider = fakeProvider({ availability: 'unavailable' });
    const { ctrl, states } = makeController(idx, provider);

    await ctrl.ask('coffee');

    expect(kinds(states)).toEqual(['searching', 'snippets']);
    const snip = last(states);
    expect(snip.reason).toBe('model-unavailable');
    expect(snip.chunks.length).toBeGreaterThan(0);
    expect(provider._calls.answer.length).toBe(0);
  });

  it('downloadable → searching → snippets(model-downloadable)', async () => {
    const idx = realIndex();
    const provider = fakeProvider({ availability: 'downloadable' });
    const { ctrl, states } = makeController(idx, provider);

    await ctrl.ask('coffee');

    expect(kinds(states)).toEqual(['searching', 'snippets']);
    expect(last(states).reason).toBe('model-downloadable');
    expect(provider._calls.answer.length).toBe(0);
  });

  it('downloading (already in progress) → snippets(model-downloadable)', async () => {
    const idx = realIndex();
    const provider = fakeProvider({ availability: 'downloading' });
    const { ctrl, states } = makeController(idx, provider);

    await ctrl.ask('coffee');

    expect(last(states).kind).toBe('snippets');
    expect(last(states).reason).toBe('model-downloadable');
    expect(provider._calls.answer.length).toBe(0);
  });
});

describe('createAskController — zero hits vs empty index (distinct!)', () => {
  it('zero hits on a NON-empty index → answered grounded:false, model skipped', async () => {
    const idx = realIndex();
    const provider = fakeProvider({ id: 'builtin', availability: 'available' });
    const { ctrl, states } = makeController(idx, provider);

    await ctrl.ask('zzqwxyzblorptfnord'); // matches nothing in the corpus

    expect(kinds(states)).toEqual(['searching', 'answered']);
    const ans = last(states);
    expect(ans.grounded).toBe(false);
    expect(ans.usedModel).toBe(false);
    expect(ans.citations).toEqual([]);
    expect(ans.provider).toBe('builtin'); // active provider id still reported
    expect(provider._calls.answer.length).toBe(0);
    expect(provider._calls.availability).toBe(0); // model path skipped entirely
  });

  it('empty index → no-index, with NO fusion or provider call', async () => {
    const idx = createAskIndex();
    idx.build([]);
    let fusionCalls = 0;
    const fusion = { query: async () => { fusionCalls += 1; return []; } };
    const provider = fakeProvider({ availability: 'available' });
    const { states, onState } = recorder();
    const ctrl = createAskController({ index: idx, fusion, registry: fakeRegistry(provider), onState });

    await ctrl.ask('anything');

    expect(kinds(states)).toEqual(['no-index']);
    expect(fusionCalls).toBe(0);
    expect(provider._calls.availability).toBe(0);
    expect(provider._calls.answer.length).toBe(0);
  });
});

describe('createAskController — errors keep chunks', () => {
  it('provider answer throws AskError(network) → error{code:network} with chunks preserved', async () => {
    const idx = realIndex();
    const expected = idx.query('coffee', 8);
    const provider = fakeProvider({
      availability: 'available',
      answer: () => Promise.reject(new AskError('network', 'offline')),
    });
    const { ctrl, states } = makeController(idx, provider);

    await ctrl.ask('coffee');

    expect(kinds(states)).toEqual(['searching', 'generating', 'error']);
    const err = last(states);
    expect(err.code).toBe('network');
    expect(err.message).toBe('offline');
    expect(err.chunks.map((c) => c.id)).toEqual(expected.map((c) => c.id));
  });

  it('availability throws → error (before generating) with chunks preserved', async () => {
    const idx = realIndex();
    const expected = idx.query('coffee', 8);
    const provider = fakeProvider({ availabilityThrows: new AskError('unavailable', 'gone') });
    const { ctrl, states } = makeController(idx, provider);

    await ctrl.ask('coffee');

    expect(kinds(states)).toEqual(['searching', 'error']);
    const err = last(states);
    expect(err.code).toBe('unavailable');
    expect(err.chunks.map((c) => c.id)).toEqual(expected.map((c) => c.id));
  });

  it('a generic (non-AskError) throw → error{code:model-error}', async () => {
    const idx = realIndex();
    const provider = fakeProvider({
      availability: 'available',
      answer: () => Promise.reject(new Error('boom')),
    });
    const { ctrl, states } = makeController(idx, provider);

    await ctrl.ask('coffee');

    expect(last(states).kind).toBe('error');
    expect(last(states).code).toBe('model-error');
  });
});

describe('createAskController — supersede / abort guard', () => {
  it('a superseded ask does NOT emit a terminal state over the newer ask', async () => {
    const idx = realIndex();
    let resolve1;
    const deferred1 = new Promise((res) => { resolve1 = res; });
    let answerCall = 0;
    const provider = fakeProvider({
      availability: 'available',
      answer: () => {
        answerCall += 1;
        if (answerCall === 1) return deferred1; // ask #1 parks here
        return Promise.resolve({ answer: 'SECOND', citations: [], grounded: true });
      },
    });
    const { ctrl, states } = makeController(idx, provider);

    const p1 = ctrl.ask('coffee');
    await flush(); // let ask #1 advance to generating and park on the deferred answer
    expect(last(states).kind).toBe('generating');

    const p2 = ctrl.ask('pod'); // supersedes #1 (aborts its controller)
    await p2; // #2 runs to completion → answered 'SECOND'

    // Now ask #1's answer resolves LATE — it must be ignored (its signal is aborted).
    resolve1({ answer: 'FIRST', citations: [], grounded: true });
    await p1; // must not throw
    await flush();

    const answered = states.filter((s) => s.kind === 'answered');
    expect(answered.length).toBe(1);
    expect(answered[0].answer).toBe('SECOND');
    expect(last(states).answer).toBe('SECOND');
    expect(states.some((s) => s.kind === 'answered' && s.answer === 'FIRST')).toBe(false);
  });

  it('a superseded ask whose answer REJECTS late emits no error and leaks no unhandled rejection', async () => {
    const idx = realIndex();
    let reject1;
    const deferred1 = new Promise((_res, rej) => { reject1 = rej; });
    let answerCall = 0;
    const provider = fakeProvider({
      availability: 'available',
      answer: () => {
        answerCall += 1;
        if (answerCall === 1) return deferred1;
        return Promise.resolve({ answer: 'SECOND', citations: [], grounded: true });
      },
    });
    const { ctrl, states } = makeController(idx, provider);

    const p1 = ctrl.ask('coffee');
    await flush();
    const p2 = ctrl.ask('pod');
    await p2;

    reject1(new AskError('network', 'late failure'));
    await p1; // ask() swallows the aborted rejection → resolves, does not throw
    await flush();

    expect(states.some((s) => s.kind === 'error')).toBe(false);
    expect(last(states).answer).toBe('SECOND');
  });
});

describe('createAskController — enableModel', () => {
  it('drives a downloading{progress} state then resolves on success', async () => {
    const idx = realIndex();
    const provider = fakeProvider({
      ensureReady: (onProgress) => { onProgress(0.5); return Promise.resolve(); },
    });
    const { ctrl, states } = makeController(idx, provider);

    await ctrl.enableModel();

    const downloading = states.filter((s) => s.kind === 'downloading');
    expect(downloading.length).toBeGreaterThan(0);
    expect(downloading[0].progress).toBe(0.5);
    expect(states.some((s) => s.kind === 'error')).toBe(false);
  });

  it('surfaces error{code} when ensureReady throws', async () => {
    const idx = realIndex();
    const provider = fakeProvider({
      ensureReady: () => Promise.reject(new AskError('model-error', 'nope')),
    });
    const { ctrl, states } = makeController(idx, provider);

    await ctrl.enableModel();

    const err = last(states);
    expect(err.kind).toBe('error');
    expect(err.code).toBe('model-error');
  });
});

describe('createAskController — getState', () => {
  it('starts in the idle state before any ask', () => {
    const idx = realIndex();
    const { ctrl } = makeController(idx, fakeProvider());
    expect(ctrl.getState().kind).toBe('idle');
  });
});
