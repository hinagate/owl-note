// Tests for the minimal provider registry (T8/M3). The registry is the single
// indirection app.js uses to reach a model backend: in M3 it defaults to the
// built-in on-device provider, and it lets tests inject a fake provider. M7 will
// extend it with openai-compat registration + persisted config; those are NOT
// exercised here.
import { describe, it, expect } from 'vitest';
import { createRegistry } from '../src/lib/providers/registry.js';

// A minimal Provider-contract-shaped fake for the injection test.
const fakeProvider = (id = 'fake') => ({
  id,
  label: 'Fake',
  capabilities: () => ({ streaming: false, jsonSchema: false }),
  availability: async () => 'unavailable',
  ensureReady: async () => {},
  answer: async () => ({ answer: '', citations: [], grounded: false }),
});

describe('provider registry', () => {
  it('getActiveProvider() defaults to the built-in provider', () => {
    const active = createRegistry().getActiveProvider();
    expect(active).toBeTruthy();
    expect(active.id).toBe('builtin');
  });

  it('listProviders() includes the built-in provider by default', () => {
    const ids = createRegistry().listProviders().map((p) => p.id);
    expect(ids).toContain('builtin');
  });

  it('the default active provider satisfies the Provider contract shape', () => {
    const active = createRegistry().getActiveProvider();
    expect(typeof active.capabilities).toBe('function');
    expect(typeof active.availability).toBe('function');
    expect(typeof active.ensureReady).toBe('function');
    expect(typeof active.answer).toBe('function');
  });

  it('injected providers override the default (active = first injected)', () => {
    const reg = createRegistry({ providers: [fakeProvider('fake'), fakeProvider('second')] });
    expect(reg.getActiveProvider().id).toBe('fake');
    expect(reg.listProviders().map((p) => p.id)).toEqual(['fake', 'second']);
  });

  it('an empty/absent providers option falls back to the built-in default', () => {
    expect(createRegistry({ providers: [] }).getActiveProvider().id).toBe('builtin');
    expect(createRegistry({}).getActiveProvider().id).toBe('builtin');
  });

  it('listProviders() returns a copy — mutating it does not affect the registry', () => {
    const reg = createRegistry();
    const list = reg.listProviders();
    list.length = 0;
    expect(reg.listProviders().length).toBeGreaterThan(0);
  });
});
