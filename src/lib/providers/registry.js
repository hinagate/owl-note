// Minimal provider registry — the single indirection app.js uses to reach a model
// backend, so the rest of the app never imports a concrete provider. In M3 it
// defaults to the built-in on-device provider (builtin.js) and lets tests inject a
// fake. Pure module: NO storage reads and NO DOM here — the default is always the
// built-in, so nothing async is needed. Plan §5.7.
//
// [M7] setConfig / openai-compat registration + storage.local persistence: M7 adds
// a settable active provider (BYOK openai-compat) and persists the choice; that is
// deliberately NOT built here — M3 only needs the built-in default.

import { createBuiltinProvider } from './builtin.js';

/**
 * @param {Object} [opts]
 * @param {import('./provider.js').Provider[]} [opts.providers]  Injected providers
 *        (tests). When absent/empty, the registry falls back to the built-in provider.
 * @returns {{ getActiveProvider: () => import('./provider.js').Provider|null, listProviders: () => import('./provider.js').Provider[] }}
 */
export function createRegistry(opts = {}) {
  const providers = Array.isArray(opts.providers) && opts.providers.length
    ? opts.providers.slice()
    : [createBuiltinProvider()];

  // Active = first provider. Injected providers therefore override the built-in
  // default; with no injection the built-in is the sole (and active) provider.
  const active = providers[0] || null;

  return {
    getActiveProvider() { return active; },
    // Return a COPY so callers can't mutate the registry's provider list.
    listProviders() { return providers.slice(); },
  };
}
