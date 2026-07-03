import { describe, it, expect, afterEach } from 'vitest';
import { suggestTitle, TITLE_SCHEMA, TITLE_SYSTEM_PROMPT } from '../src/lib/providers/title.js';
import { AskError } from '../src/lib/providers/provider.js';
import { installFakeLanguageModel, uninstallLanguageModel } from './helpers/fake-language-model.js';

// The fake sets a global (globalThis.LanguageModel); a leaked fake corrupts
// unrelated suites, so every test registers its restore here.
let cleanup = null;
afterEach(() => {
  if (cleanup) { cleanup(); cleanup = null; }
});

describe('suggestTitle', () => {
  it('returns a cleaned title from a valid { title } response, constrains output, and destroys the session', async () => {
    const fake = installFakeLanguageModel({ promptResult: JSON.stringify({ title: 'Grocery run notes' }) });
    cleanup = fake.uninstall;

    const out = await suggestTitle('Milk, eggs, bread. Pick up at 5pm from the market.');

    expect(out).toBe('Grocery run notes');
    // A throwaway session with the TITLE system prompt was created and constrained.
    expect(fake.createCalls).toHaveLength(1);
    expect(fake.createCalls[0].initialPrompts[0].content).toBe(TITLE_SYSTEM_PROMPT);
    const call = fake.lastSession.promptCalls[0];
    expect(call.opts.responseConstraint).toBe(TITLE_SCHEMA);
    // destroy-in-finally on the happy path.
    expect(fake.lastSession.destroyCount).toBe(1);
  });

  it('returns null WITHOUT creating a session when the model is downloadable (never triggers a download)', async () => {
    const fake = installFakeLanguageModel({ availability: 'downloadable' });
    cleanup = fake.uninstall;

    const out = await suggestTitle('Some note body worth titling.');

    expect(out).toBeNull();
    expect(fake.createCalls).toHaveLength(0); // the model download opt-in lives only in the Ask panel
  });

  it('returns null WITHOUT creating a session when availability is unavailable', async () => {
    const fake = installFakeLanguageModel({ availability: 'unavailable' });
    cleanup = fake.uninstall;

    const out = await suggestTitle('body');

    expect(out).toBeNull();
    expect(fake.createCalls).toHaveLength(0);
  });

  it('returns null when the Prompt API global is missing', async () => {
    cleanup = uninstallLanguageModel();

    const out = await suggestTitle('body');

    expect(out).toBeNull();
  });

  it('falls back to the cleaned first line of raw text when the JSON is malformed (never throws)', async () => {
    const fake = installFakeLanguageModel({ promptResult: 'Weekend hiking plan\nnot valid json at all' });
    cleanup = fake.uninstall;

    const out = await suggestTitle('body');

    expect(out).toBe('Weekend hiking plan');
    expect(fake.lastSession.destroyCount).toBe(1);
  });

  // The user hit this: an on-device model that TRUNCATES mid-JSON leaked the raw
  // `{"title":"...` first line into the field. Salvage the title value instead of
  // ever emitting JSON-shaped garbage.
  it('salvages the title value from JSON truncated mid-string', async () => {
    const fake = installFakeLanguageModel({ promptResult: '{"title":"Grocery run' });
    cleanup = fake.uninstall;

    expect(await suggestTitle('body')).toBe('Grocery run');
  });

  it('unescapes an escaped quote/backslash while salvaging a truncated title', async () => {
    const fake = installFakeLanguageModel({ promptResult: '{"title":"He said \\"hi\\" to a path C:\\\\tmp' });
    cleanup = fake.uninstall;

    expect(await suggestTitle('body')).toBe('He said "hi" to a path C:\\tmp');
  });

  it('returns null (never JSON garbage) when the raw looks like JSON but has no salvageable title', async () => {
    const fake = installFakeLanguageModel({ promptResult: '{"garbled' });
    cleanup = fake.uninstall;

    expect(await suggestTitle('body')).toBeNull();
  });

  it('returns null when JSON parses but the title field is not a string (no first-line leak)', async () => {
    const fake = installFakeLanguageModel({ promptResult: '{"title": 42}' });
    cleanup = fake.uninstall;

    expect(await suggestTitle('body')).toBeNull();
  });

  it('returns null (no throw) when session.prompt fails generically, and still destroys the session', async () => {
    const fake = installFakeLanguageModel({ promptThrows: new Error('model blew up') });
    cleanup = fake.uninstall;

    const out = await suggestTitle('body');

    expect(out).toBeNull();
    expect(fake.lastSession.destroyCount).toBe(1); // destroy-in-finally even on throw
  });

  it('rethrows AskError(aborted) when the signal is aborted, and destroys the session', async () => {
    const fake = installFakeLanguageModel();
    cleanup = fake.uninstall;
    const ctrl = new AbortController();
    ctrl.abort();

    await expect(suggestTitle('body', { signal: ctrl.signal })).rejects.toMatchObject({
      name: 'AskError',
      code: 'aborted',
    });
    // A real aborted-run still created a session (create ignores the signal) — free it.
    expect(fake.lastSession.destroyCount).toBe(1);
  });

  it('truncates a very long body before sending it to the model', async () => {
    const fake = installFakeLanguageModel({ promptResult: JSON.stringify({ title: 'ok' }) });
    cleanup = fake.uninstall;

    await suggestTitle('x'.repeat(10000));

    // NOTE:\n + 4,000 body chars ≈ 4,006; a title needs only the gist.
    const sent = fake.lastSession.promptCalls[0].input;
    expect(sent.length).toBeLessThanOrEqual(4100);
  });

  it('strips wrapping quotes, collapses whitespace, and clips to 120 chars', async () => {
    const long = 'Q'.repeat(200);
    const fake = installFakeLanguageModel({ promptResult: JSON.stringify({ title: `"${long}"` }) });
    cleanup = fake.uninstall;

    const out = await suggestTitle('body');

    expect(out.startsWith('"')).toBe(false);
    expect(out.endsWith('"')).toBe(false);
    expect(out.length).toBe(120);
  });

  it('collapses internal whitespace/newlines in the title', async () => {
    const fake = installFakeLanguageModel({ promptResult: JSON.stringify({ title: '  Trip   plan\nfor  spring  ' }) });
    cleanup = fake.uninstall;

    expect(await suggestTitle('body')).toBe('Trip plan for spring');
  });

  it('returns null when the model yields an empty title', async () => {
    const fake = installFakeLanguageModel({ promptResult: JSON.stringify({ title: '   ' }) });
    cleanup = fake.uninstall;

    expect(await suggestTitle('body')).toBeNull();
  });
});
