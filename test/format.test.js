import { describe, it, expect, afterEach } from 'vitest';
import { formatNote, FORMAT_SCHEMA, FORMAT_SYSTEM_PROMPT } from '../src/lib/providers/format.js';
import { AskError } from '../src/lib/providers/provider.js';
import { installFakeLanguageModel, uninstallLanguageModel } from './helpers/fake-language-model.js';

// The fake sets a global (globalThis.LanguageModel); a leaked fake corrupts
// unrelated suites, so every test registers its restore here.
let cleanup = null;
afterEach(() => {
  if (cleanup) { cleanup(); cleanup = null; }
});

describe('formatNote', () => {
  it('returns the proposed markdown from a valid { markdown } response, constrains output, and destroys the session', async () => {
    const md = '# Grocery run\n\n- Milk\n- Eggs\n- Bread\n';
    const fake = installFakeLanguageModel({ promptResult: JSON.stringify({ markdown: md }) });
    cleanup = fake.uninstall;

    const out = await formatNote('Milk, eggs, bread. pick up at 5pm.');

    // Trailing whitespace only is trimmed — the document body is preserved verbatim.
    expect(out).toBe('# Grocery run\n\n- Milk\n- Eggs\n- Bread');
    // A throwaway session with the FORMAT system prompt was created and constrained.
    expect(fake.createCalls).toHaveLength(1);
    expect(fake.createCalls[0].initialPrompts[0].content).toBe(FORMAT_SYSTEM_PROMPT);
    const call = fake.lastSession.promptCalls[0];
    expect(call.opts.responseConstraint).toBe(FORMAT_SCHEMA);
    // destroy-in-finally on the happy path.
    expect(fake.lastSession.destroyCount).toBe(1);
  });

  it('returns null WITHOUT creating a session when the model is downloadable (never triggers a download)', async () => {
    const fake = installFakeLanguageModel({ availability: 'downloadable' });
    cleanup = fake.uninstall;

    const out = await formatNote('Some note body worth formatting.');

    expect(out).toBeNull();
    expect(fake.createCalls).toHaveLength(0); // the model download opt-in lives only in the Ask panel
  });

  it('returns null WITHOUT creating a session when availability is unavailable', async () => {
    const fake = installFakeLanguageModel({ availability: 'unavailable' });
    cleanup = fake.uninstall;

    const out = await formatNote('body');

    expect(out).toBeNull();
    expect(fake.createCalls).toHaveLength(0);
  });

  it('returns null when the Prompt API global is missing', async () => {
    cleanup = uninstallLanguageModel();

    const out = await formatNote('body');

    expect(out).toBeNull();
  });

  it('falls back to the raw document text when the JSON is malformed (never throws)', async () => {
    const raw = 'Weekend plan\n\n- pack bags\n- fuel the car\n';
    const fake = installFakeLanguageModel({ promptResult: raw });
    cleanup = fake.uninstall;

    const out = await formatNote('body');

    // Whole raw document is preserved (not just its first line) — only trailing ws trimmed.
    expect(out).toBe('Weekend plan\n\n- pack bags\n- fuel the car');
    expect(fake.lastSession.destroyCount).toBe(1);
  });

  it('returns null (no throw) when session.prompt fails generically, and still destroys the session', async () => {
    const fake = installFakeLanguageModel({ promptThrows: new Error('model blew up') });
    cleanup = fake.uninstall;

    const out = await formatNote('body');

    expect(out).toBeNull();
    expect(fake.lastSession.destroyCount).toBe(1); // destroy-in-finally even on throw
  });

  it('rethrows AskError(aborted) when the signal is aborted, and destroys the session', async () => {
    const fake = installFakeLanguageModel();
    cleanup = fake.uninstall;
    const ctrl = new AbortController();
    ctrl.abort();

    await expect(formatNote('body', { signal: ctrl.signal })).rejects.toMatchObject({
      name: 'AskError',
      code: 'aborted',
    });
    expect(fake.lastSession.destroyCount).toBe(1);
  });

  it('does NOT truncate the body — a very long note reaches the model intact (the gate lives in app.js)', async () => {
    const fake = installFakeLanguageModel({ promptResult: JSON.stringify({ markdown: 'ok' }) });
    cleanup = fake.uninstall;
    const body = 'x'.repeat(10000);

    await formatNote(body);

    // The full 10k-char body is sent verbatim (truncating a format would silently
    // drop the tail of the note — the caller gates on size instead).
    const sent = fake.lastSession.promptCalls[0].input;
    expect(sent).toBe(`NOTE:\n${body}`);
    expect(sent.length).toBe(10006);
  });

  it('returns null when the model yields empty/whitespace-only markdown', async () => {
    const fake = installFakeLanguageModel({ promptResult: JSON.stringify({ markdown: '   \n  ' }) });
    cleanup = fake.uninstall;

    expect(await formatNote('body')).toBeNull();
  });
});
