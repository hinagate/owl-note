// src/lib/note-key.js
//
// The AES-GCM keys that protect note payloads in bookmark URLs.
//
// Why this exists: notes live in the browser's bookmark tree, which is a global
// namespace — ANY extension holding the "bookmarks" permission can read every
// note, and the on-disk Bookmarks file is plaintext JSON. chrome.storage, by
// contrast, is isolated per-extension with no cross-extension read API. So the
// ciphertext travels in the bookmark (where it syncs for free) and the key
// travels in storage (where nothing else can reach it).
//
// THE STORAGE LAYOUT IS THE WHOLE DESIGN. Each key is its OWN storage item
// (`owl:key:<id>`), never a single "keyring" object. Two devices that both
// generate a key while offline would last-writer-wins a shared object and
// permanently orphan one key — and every note written under it. Distinct item
// names cannot collide, so both survive and each note names the key that
// encrypted it. The rule that falls out: WRITE with your own key, READ with any
// key you hold. No election, no coordination, no race.
//
// Keys are written to BOTH areas: `sync` distributes them to the user's other
// devices, `local` is the durable copy that survives a Chrome "Reset Sync"
// (which clears server-side extension data). Reads take the union.
import { bytesToBase64url, base64urlToBytes } from './base64url.js';

const KEY_PREFIX = 'owl:key:';
// Which key THIS device encrypts with. Deliberately local-only: it is a
// per-device choice, and syncing it would reintroduce the shared-object race.
const ACTIVE_KEY_ID = 'owl:activeKeyId';
// Local-only index of the key ids held in storage.local, so the ring can be read
// with a targeted get() instead of get(null). The local area holds every note
// backup and can be tens of MB with unlimitedStorage — pulling all of it on a
// decode path would be a serious hot-path cost. A shared object is safe HERE
// (unlike the keys themselves) precisely because it never syncs.
const KEY_INDEX = 'owl:keyIds';

// A note encrypted under a key this device does not have yet. Distinct from a
// corrupt payload because it is TRANSIENT — the key may still be in flight on a
// new device — and callers must never treat it as "this note is garbage" and
// take a destructive shortcut. See the fail-safe handling in drive-gc.js and
// the notebook delete in app.js.
export class MissingKeyError extends Error {
  constructor(keyId) {
    super(`No key for id "${keyId}" on this device yet`);
    this.name = 'MissingKeyError';
    this.keyId = keyId;
  }
}

export function isMissingKeyError(err) {
  return !!err && err.name === 'MissingKeyError';
}

// Imported CryptoKey objects, by key id. Cleared when storage changes so a key
// arriving mid-session makes its notes readable without a reload.
let cache = new Map();
let ringCache = null; // { id: base64 } — the whole ring, read at most once per change
let active = null; // { id, key } — resolved once, not re-read on every encode
let deepScanned = false; // whether the KEY_INDEX-less fallback scan has run
let generating = null; // in-flight key creation, so concurrent callers share one key

function invalidate() {
  cache = new Map();
  ringCache = null;
  active = null;
  deepScanned = false;
}

function syncArea() {
  // storage.sync is absent in some contexts (and when a profile has extension
  // sync switched off). Every call site degrades to local-only rather than throwing.
  try { return chrome.storage.sync || null; } catch { return null; }
}

function collectKeys(obj, into) {
  for (const [k, v] of Object.entries(obj || {})) {
    if (k.startsWith(KEY_PREFIX) && typeof v === 'string') into[k.slice(KEY_PREFIX.length)] = v;
  }
  return into;
}

// Every raw key this device can see, `{ id: base64 }`, unioned across areas.
// Memoized: without this, a device still waiting for its key would re-scan
// storage once per note on every decode attempt.
export async function rawKeys() {
  if (ringCache) return ringCache;
  const out = {};
  const sync = syncArea();
  // storage.sync is capped at 100 KB, so reading it whole is cheap.
  if (sync) { try { collectKeys(await sync.get(null), out); } catch { /* offline / unavailable */ } }
  try {
    const ids = (await chrome.storage.local.get(KEY_INDEX))[KEY_INDEX];
    if (Array.isArray(ids) && ids.length) {
      collectKeys(await chrome.storage.local.get(ids.map((id) => KEY_PREFIX + id)), out);
    }
  } catch { /* index unreadable — the deep scan below is the fallback */ }
  ringCache = out;
  return out;
}

// Last resort for a key that exists in storage.local but is absent from the
// index (a torn write, or a profile restored file-by-file). Costs one full local
// read, so it runs at most once per invalidation and only on an actual miss.
async function deepScan() {
  if (deepScanned) return ringCache || {};
  deepScanned = true;
  try {
    const found = collectKeys(await chrome.storage.local.get(null), {});
    if (Object.keys(found).length) {
      ringCache = { ...found, ...(ringCache || {}) };
      await reindex(Object.keys(ringCache));
    }
  } catch { /* best-effort */ }
  return ringCache || {};
}

async function reindex(ids) {
  try { await chrome.storage.local.set({ [KEY_INDEX]: [...new Set(ids)] }); } catch { /* best-effort */ }
}

async function importKey(b64) {
  return crypto.subtle.importKey('raw', base64urlToBytes(b64), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

// Persist one key to both areas. A sync write can fail (quota, sync disabled);
// the local write is the one that must succeed, so it goes first and is not
// wrapped — losing it would mean encrypting under a key we cannot reload.
async function persist(id, b64) {
  const ring = await rawKeys();
  await chrome.storage.local.set({ [KEY_PREFIX + id]: b64 });
  await reindex([...Object.keys(ring), id]);
  ringCache = { ...ring, [id]: b64 };
  const sync = syncArea();
  if (sync) { try { await sync.set({ [KEY_PREFIX + id]: b64 }); } catch { /* offline / quota — local copy stands, retried by ensureDistributed */ } }
}

// Push any key that only exists locally up to sync. Covers the device that
// minted its key while offline or with sync switched off; cheap on startup.
export async function ensureDistributed() {
  const sync = syncArea();
  if (!sync) return 0;
  const ring = await rawKeys();
  if (!Object.keys(ring).length) return 0;
  let synced = {};
  try { synced = collectKeys(await sync.get(null), {}); } catch { return 0; }
  const missing = {};
  for (const [id, b64] of Object.entries(ring)) if (synced[id] !== b64) missing[KEY_PREFIX + id] = b64;
  if (!Object.keys(missing).length) return 0;
  try { await sync.set(missing); return Object.keys(missing).length; } catch { return 0; }
}

export async function keyById(id) {
  if (cache.has(id)) return cache.get(id);
  let b64 = (await rawKeys())[id];
  if (!b64) b64 = (await deepScan())[id];
  if (!b64) throw new MissingKeyError(id);
  const key = await importKey(b64);
  cache.set(id, key);
  return key;
}

// The key this device encrypts with, creating one on first use. Adopting an
// already-synced key when this device has no active id keeps the ring small —
// and picking the lexicographically smallest id makes two devices adopting
// concurrently land on the SAME key instead of each minting another.
export async function activeKey() {
  if (active) return active; // memoized: encode() runs on every save and every size probe
  const stored = (await chrome.storage.local.get(ACTIVE_KEY_ID))[ACTIVE_KEY_ID];
  const ring = await rawKeys();
  if (stored && ring[stored]) {
    active = { id: stored, key: await keyById(stored) };
    return active;
  }
  const existing = Object.keys(ring).sort()[0];
  if (existing) {
    await chrome.storage.local.set({ [ACTIVE_KEY_ID]: existing });
    active = { id: existing, key: await keyById(existing) };
    return active;
  }
  if (generating) return generating;
  generating = (async () => {
    // 6 random bytes → 8 base64url chars. Only needs to be unique across a
    // user's own devices, and it must avoid '.' (the payload separator);
    // base64url has no '.' in its alphabet.
    const id = bytesToBase64url(crypto.getRandomValues(new Uint8Array(6)));
    const b64 = bytesToBase64url(crypto.getRandomValues(new Uint8Array(32))); // AES-256
    await persist(id, b64);
    await chrome.storage.local.set({ [ACTIVE_KEY_ID]: id });
    active = { id, key: await keyById(id) };
    return active;
  })();
  try { return await generating; } finally { generating = null; }
}

export async function hasAnyKey() {
  return Object.keys(await rawKeys()).length > 0;
}

// --- Backup / recovery -----------------------------------------------------
// Bookmarks survive an uninstall; before encryption so did the notes inside
// them. Now they only survive if the key does, so the keyring rides along in
// every export (see mirror.exportAll) and can be pasted back on a fresh device.

export async function exportKeyring() {
  return { version: 1, keys: await rawKeys() };
}

// Merge keys in. NEVER overwrites an existing id — an id already present with
// different bytes would mean a collision, and clobbering it would strand every
// note encrypted under the copy we hold. Returns how many were added.
export async function importKeyring(ring) {
  const incoming = (ring && ring.keys) || {};
  const have = await rawKeys();
  let added = 0;
  for (const [id, b64] of Object.entries(incoming)) {
    if (typeof b64 !== 'string' || have[id]) continue;
    await persist(id, b64);
    added += 1;
  }
  if (added) { cache = new Map(); active = null; }
  return added;
}

// A key arriving from another device must make its notes readable without a
// reload, so drop the import cache whenever the ring changes underneath us.
export function watchKeyChanges(onNewKey) {
  if (!chrome.storage.onChanged || !chrome.storage.onChanged.addListener) return;
  chrome.storage.onChanged.addListener((changes) => {
    const ids = Object.keys(changes).filter((k) => k.startsWith(KEY_PREFIX));
    if (!ids.length) return;
    invalidate(); // re-resolves to the same active id; just drops the stale ring
    if (typeof onNewKey === 'function') onNewKey(ids.map((k) => k.slice(KEY_PREFIX.length)));
  });
}

// Test seam: forget everything memoized without touching storage.
export function _resetCache() {
  invalidate();
  generating = null;
}
