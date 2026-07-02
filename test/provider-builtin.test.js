import { describe, it, expect, afterEach } from 'vitest';
import { createBuiltinProvider } from '../src/lib/providers/builtin.js';
import { AskError } from '../src/lib/providers/provider.js';
import { ANSWER_SCHEMA } from '../src/lib/providers/prompting.js';
import {
  installFakeLanguageModel,
  uninstallLanguageModel,
} from './helpers/fake-language-model.js';

// Chunk fixture — matches chunker.js / provider.js shape.
const chunk = (overrides = {}) => ({
  id: 'n1::0',
  noteId: 'n1',
  noteTitle: 'My Note',
  heading: '',
  text: 'text',
  raw: 'raw content',
  ...overrides,
});

// Tracks the fake so we can guarantee it is uninstalled after EVERY test — a
// leaked globalThis.LanguageModel would corrupt unrelated suites.
let installed = null;
function install(config) {
  installed = installFakeLanguageModel(config);
  return installed;
}

afterEach(() => {
  if (installed) installed.uninstall();
  installed = null;
  // Belt-and-suspenders: make sure no fake global survives into the next suite.
  delete globalThis.LanguageModel;
});

describe('createBuiltinProvider — identity & capabilities', () => {
  it('exposes id, label, and static capabilities', () => {
    const p = createBuiltinProvider();
    expect(p.id).toBe('builtin');
    expect(p.label).toBe('Built-in AI');
    expect(p.capabilities()).toEqual({ streaming: false, jsonSchema: true });
  });
});

describe('availability() — mapping (never caches, never throws)', () => {
  const cases = [
    ['available', 'available'],
    ['readily', 'available'], // legacy vocab
    ['downloadable', 'downloadable'],
    ['after-download', 'downloadable'], // legacy vocab
    ['downloading', 'downloading'],
    ['unavailable', 'unavailable'],
    ['no', 'unavailable'], // legacy vocab
    ['something-weird', 'unavailable'], // unrecognized -> unavailable
  ];

  for (const [raw, mapped] of cases) {
    it(`maps browser '${raw}' -> '${mapped}'`, async () => {
      install({ availability: raw });
      const p = createBuiltinProvider();
      await expect(p.availability()).resolves.toBe(mapped);
    });
  }

  it("missing global -> 'unavailable'", async () => {
    const restore = uninstallLanguageModel();
    const p = createBuiltinProvider();
    await expect(p.availability()).resolves.toBe('unavailable');
    restore();
  });

  it("availability() throwing -> 'unavailable' (never throws)", async () => {
    install({ availabilityThrows: true });
    const p = createBuiltinProvider();
    await expect(p.availability()).resolves.toBe('unavailable');
  });

  it('never caches — re-probes on every call', async () => {
    const h = install({ availability: 'downloadable' });
    const p = createBuiltinProvider();
    await p.availability();
    await p.availability();
    await p.availability();
    expect(h.availabilityCalls).toBe(3);
  });
});

describe('answer() — happy path', () => {
  it('returns validated citations and calls prompt with schema + built user prompt', async () => {
    const chunks = [
      chunk({ id: 'n1::0', noteTitle: 'Espresso', heading: 'Setup', raw: 'Tamp evenly.' }),
      chunk({ id: 'n2::1', noteTitle: 'Sourdough', heading: '', raw: 'Feed daily.' }),
    ];
    const promptResult = JSON.stringify({
      answer: 'Tamp evenly and level.',
      citations: ['n1::0', 'ghost'], // ghost is not a sent id -> dropped
      grounded: true,
    });
    const h = install({ promptResult });
    const p = createBuiltinProvider();

    const result = await p.answer({ question: 'How do I tamp?', chunks, signal: undefined });

    expect(result).toEqual({
      answer: 'Tamp evenly and level.',
      citations: ['n1::0'], // validated against sent chunk ids
      grounded: true,
    });

    // Assert prompt was called with the exact schema object + a real user prompt.
    const call = h.lastSession.promptCalls[0];
    expect(call.opts.responseConstraint).toBe(ANSWER_SCHEMA);
    expect(call.input).toContain('<<<NOTE c:n1::0>>> Espresso — Setup');
    expect(call.input).toContain('<<<NOTE c:n2::1>>> Sourdough');
    expect(call.input).toContain('QUESTION: How do I tamp?');

    // create() seeded the system prompt as an initial prompt.
    expect(h.createCalls[0].initialPrompts[0].role).toBe('system');
  });

  it('uses session.measureInputUsage when present (best-effort sanity check)', async () => {
    const h = install({ measureInputUsage: 42 });
    const p = createBuiltinProvider();
    await p.answer({ question: 'Q?', chunks: [chunk()], signal: undefined });
    expect(h.lastSession.measureCalls).toHaveLength(1);
    // Measured the exact user prompt that was sent to prompt().
    expect(h.lastSession.measureCalls[0]).toBe(h.lastSession.promptCalls[0].input);
  });

  it('works when session.measureInputUsage is absent', async () => {
    install(); // no measureInputUsage knob -> session omits the method
    const p = createBuiltinProvider();
    await expect(
      p.answer({ question: 'Q?', chunks: [chunk()], signal: undefined })
    ).resolves.toMatchObject({ grounded: true });
  });
});

describe('answer() — degraded parse is NOT an error', () => {
  it('malformed model JSON resolves to raw text, no citations, grounded:false', async () => {
    const raw = 'this is not { valid json';
    install({ promptResult: raw });
    const p = createBuiltinProvider();

    const result = await p.answer({ question: 'Q?', chunks: [chunk({ id: 'a' })], signal: undefined });
    expect(result).toEqual({ answer: raw, citations: [], grounded: false });
  });
});

describe('answer() — destroy() is ALWAYS called (finally path)', () => {
  it('destroys the session on the happy path', async () => {
    const h = install();
    const p = createBuiltinProvider();
    await p.answer({ question: 'Q?', chunks: [chunk()], signal: undefined });
    expect(h.lastSession.destroyCount).toBe(1);
  });

  it('destroys the session even when session.prompt throws', async () => {
    const h = install({ promptThrows: new Error('model exploded') });
    const p = createBuiltinProvider();
    await expect(
      p.answer({ question: 'Q?', chunks: [chunk()], signal: undefined })
    ).rejects.toBeInstanceOf(AskError);
    expect(h.lastSession.destroyCount).toBe(1);
  });
});

describe('answer() — error mapping', () => {
  it("missing global -> AskError('unavailable')", async () => {
    const restore = uninstallLanguageModel();
    const p = createBuiltinProvider();
    await expect(
      p.answer({ question: 'Q?', chunks: [chunk()], signal: undefined })
    ).rejects.toMatchObject({ name: 'AskError', code: 'unavailable' });
    restore();
  });

  it("aborted signal -> AskError('aborted')", async () => {
    install();
    const p = createBuiltinProvider();
    const controller = new AbortController();
    controller.abort();

    const err = await p
      .answer({ question: 'Q?', chunks: [chunk()], signal: controller.signal })
      .catch((e) => e);
    expect(err).toBeInstanceOf(AskError);
    expect(err.code).toBe('aborted');
  });

  it("generic prompt throw -> AskError('model-error')", async () => {
    install({ promptThrows: new Error('boom') });
    const p = createBuiltinProvider();
    const err = await p
      .answer({ question: 'Q?', chunks: [chunk()], signal: undefined })
      .catch((e) => e);
    expect(err).toBeInstanceOf(AskError);
    expect(err.code).toBe('model-error');
  });

  it('a thrown AskError passes through unchanged', async () => {
    const passthrough = new AskError('context-overflow', 'too big');
    install({ promptThrows: passthrough });
    const p = createBuiltinProvider();
    const err = await p
      .answer({ question: 'Q?', chunks: [chunk()], signal: undefined })
      .catch((e) => e);
    expect(err).toBe(passthrough);
    expect(err.code).toBe('context-overflow');
  });
});

describe('ensureReady()', () => {
  it('forwards downloadprogress e.loaded values to onProgress and destroys the session', async () => {
    const h = install({ downloadProgress: [0.25, 0.5, 1] });
    const p = createBuiltinProvider();
    const seen = [];
    await p.ensureReady((f) => seen.push(f));
    expect(seen).toEqual([0.25, 0.5, 1]);
    // The throwaway download session is freed afterward.
    expect(h.lastSession.destroyCount).toBe(1);
  });

  it('is safe when onProgress is not a function', async () => {
    install({ downloadProgress: [0.5, 1] });
    const p = createBuiltinProvider();
    await expect(p.ensureReady(undefined)).resolves.toBeUndefined();
  });

  it("createThrows -> rejects with AskError('model-error')", async () => {
    install({ createThrows: new Error('nope') });
    const p = createBuiltinProvider();
    const err = await p.ensureReady(() => {}).catch((e) => e);
    expect(err).toBeInstanceOf(AskError);
    expect(err.code).toBe('model-error');
  });

  it("missing global -> rejects with AskError('unavailable')", async () => {
    const restore = uninstallLanguageModel();
    const p = createBuiltinProvider();
    const err = await p.ensureReady(() => {}).catch((e) => e);
    expect(err).toBeInstanceOf(AskError);
    expect(err.code).toBe('unavailable');
    restore();
  });
});
