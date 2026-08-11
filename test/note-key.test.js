import { describe, it, expect, beforeEach } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import {
  activeKey,
  keyById,
  rawKeys,
  hasAnyKey,
  ensureDistributed,
  exportKeyring,
  importKeyring,
  isMissingKeyError,
  MissingKeyError,
  _resetCache,
} from '../src/lib/note-key.js';

beforeEach(() => { installFakeChrome(); _resetCache(); });

// A device is a (localStore, syncStore) pair. Swapping stores and clearing the
// module cache is exactly what "the same extension on another machine" means.
function useDevice({ local = new Map(), sync = new Map(), syncEnabled = true } = {}) {
  installFakeChrome({ localStore: local, syncStore: sync, syncEnabled });
  _resetCache();
  return { local, sync };
}

describe('note-key', () => {
  it('mints a key on first use and writes it to both storage areas', async () => {
    const { local, sync } = useDevice();
    expect(await hasAnyKey()).toBe(false);
    const { id, key } = await activeKey();
    expect(id).toMatch(/^[A-Za-z0-9_-]{8}$/);
    expect(key).toBeTruthy();
    expect(local.get(`owl:key:${id}`)).toBeTypeOf('string');
    expect(sync.get(`owl:key:${id}`)).toBe(local.get(`owl:key:${id}`)); // durable + distributed
  });

  it('the key id never contains the payload separator', async () => {
    for (let i = 0; i < 25; i++) {
      useDevice();
      expect((await activeKey()).id).not.toContain('.');
    }
  });

  it('returns the same key on repeat calls, and after the in-memory cache is dropped', async () => {
    const device = useDevice();
    const first = await activeKey();
    expect((await activeKey()).id).toBe(first.id);
    useDevice(device); // same storage, fresh module state — a new tab
    expect((await activeKey()).id).toBe(first.id);
  });

  it('concurrent first-use callers share one key instead of minting two', async () => {
    useDevice();
    const ids = (await Promise.all([activeKey(), activeKey(), activeKey()])).map((r) => r.id);
    expect(new Set(ids).size).toBe(1);
    expect(Object.keys(await rawKeys())).toHaveLength(1);
  });

  it('a second device adopts the synced key rather than minting its own', async () => {
    const sync = new Map();
    useDevice({ sync });
    const first = await activeKey();
    useDevice({ sync, local: new Map() }); // new machine, same account
    expect((await activeKey()).id).toBe(first.id);
    expect(Object.keys(await rawKeys())).toHaveLength(1);
  });

  // The failure this whole storage layout exists to prevent: a single shared
  // keyring object would be last-writer-wins, orphaning one key and every note
  // written under it. Distinct item names cannot collide.
  it('two devices that mint keys offline both survive coming online', async () => {
    const localA = new Map();
    const localB = new Map();
    useDevice({ local: localA, syncEnabled: false });
    const a = await activeKey();
    useDevice({ local: localB, syncEnabled: false });
    const b = await activeKey();
    expect(a.id).not.toBe(b.id);

    const sync = new Map();
    useDevice({ local: localA, sync });
    await ensureDistributed();
    useDevice({ local: localB, sync });
    await ensureDistributed();

    const ring = await rawKeys();
    expect(Object.keys(ring).sort()).toEqual([a.id, b.id].sort());
    await expect(keyById(a.id)).resolves.toBeTruthy();
    await expect(keyById(b.id)).resolves.toBeTruthy();
  });

  it('each device keeps writing with its own key after the rings merge', async () => {
    const localA = new Map();
    const sync = new Map();
    useDevice({ local: localA, syncEnabled: false });
    const a = await activeKey();
    useDevice({ local: localA, sync });
    await importKeyring({ keys: { zzzzzzzz: 'A'.repeat(43) } }); // another device's key arrives
    expect((await activeKey()).id).toBe(a.id);
  });

  it('keyById throws a MissingKeyError, distinguishable from a corrupt payload', async () => {
    useDevice();
    const err = await keyById('nosuchid').catch((e) => e);
    expect(err).toBeInstanceOf(MissingKeyError);
    expect(isMissingKeyError(err)).toBe(true);
    expect(err.keyId).toBe('nosuchid');
    expect(isMissingKeyError(new Error('boom'))).toBe(false);
    expect(isMissingKeyError(null)).toBe(false);
  });

  it('works with extension sync switched off, keeping the key local-only', async () => {
    const { local } = useDevice({ syncEnabled: false });
    const { id } = await activeKey();
    expect(local.get(`owl:key:${id}`)).toBeTypeOf('string');
    expect(await ensureDistributed()).toBe(0); // nowhere to distribute to; must not throw
    await expect(keyById(id)).resolves.toBeTruthy();
  });

  it('ensureDistributed re-uploads a key minted while sync was unavailable', async () => {
    const local = new Map();
    useDevice({ local, syncEnabled: false });
    const { id } = await activeKey();
    const sync = new Map();
    useDevice({ local, sync });
    expect(await ensureDistributed()).toBe(1);
    expect(sync.get(`owl:key:${id}`)).toBe(local.get(`owl:key:${id}`));
    expect(await ensureDistributed()).toBe(0); // idempotent
  });

  it('survives a Chrome sync reset, because the local copy is authoritative', async () => {
    const local = new Map();
    const sync = new Map();
    useDevice({ local, sync });
    const { id } = await activeKey();
    sync.clear(); // "Reset Sync" wipes server-side extension data
    useDevice({ local, sync });
    await expect(keyById(id)).resolves.toBeTruthy();
  });

  it('finds a key present in local storage but missing from the index', async () => {
    const local = new Map();
    useDevice({ local });
    const { id } = await activeKey();
    local.delete('owl:keyIds'); // torn write / partially restored profile
    useDevice({ local, sync: new Map() });
    await expect(keyById(id)).resolves.toBeTruthy(); // deep-scan fallback
    expect(local.get('owl:keyIds')).toContain(id); // and repairs the index
  });

  it('importKeyring merges without ever overwriting a key it already holds', async () => {
    const { local } = useDevice();
    const { id } = await activeKey();
    const mine = local.get(`owl:key:${id}`);
    const added = await importKeyring({ keys: { [id]: 'D'.repeat(43), fresh123: 'E'.repeat(43) } });
    expect(added).toBe(1);
    expect(local.get(`owl:key:${id}`)).toBe(mine); // untouched — clobbering would strand notes
    expect((await rawKeys()).fresh123).toBe('E'.repeat(43));
  });

  it('exportKeyring round-trips into a device that has no keys at all', async () => {
    useDevice();
    const { id } = await activeKey();
    const backup = await exportKeyring();
    expect(backup.keys[id]).toBeTypeOf('string');

    useDevice(); // fresh profile: bookmarks survived a reinstall, storage did not
    await expect(keyById(id)).rejects.toThrow(MissingKeyError);
    expect(await importKeyring(backup)).toBe(1);
    await expect(keyById(id)).resolves.toBeTruthy();
  });

  it('ignores malformed entries in an imported keyring', async () => {
    useDevice();
    expect(await importKeyring({ keys: { a: 123, b: null } })).toBe(0);
    expect(await importKeyring({})).toBe(0);
    expect(await importKeyring(null)).toBe(0);
  });
});
