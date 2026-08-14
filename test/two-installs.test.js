import { describe, it, expect, beforeEach } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import * as bm from '../src/lib/bookmarks.js';
import { saveNote } from '../src/lib/save-note.js';
import { decode } from '../src/lib/codec.js';
import { createNote } from '../src/lib/note.js';
import { exportKeyring, importKeyring, rawKeys, activeKey, _resetCache } from '../src/lib/note-key.js';

// Two installs on one machine — an unpacked developer build and the Web Store build
// — have different extension ids, so separate chrome.storage, but ONE bookmark tree.
// Swapping only the storage contents (never re-installing the fake, which would also
// wipe the bookmarks) is exactly what the second extension id experiences.
async function becomeOtherInstall() {
  const ids = Object.keys(await rawKeys());
  const keys = ids.map((id) => `owl:key:${id}`);
  await chrome.storage.local.remove([...keys, 'owl:keyIds', 'owl:activeKeyId']);
  await chrome.storage.sync.remove(keys);
  _resetCache();
}

async function restoreOnly(ring) {
  await becomeOtherInstall();
  await importKeyring(ring);
  _resetCache();
}

describe('two installs sharing a bookmark tree', () => {
  beforeEach(() => { installFakeChrome(); _resetCache(); });

  it('locks the other install out, and a backup unlocks it in place', async () => {
    const root = await bm.ensureRoot();
    const { bookmarkId } = await saveNote(createNote({ title: 'Q3', body: 'SECRET FROM A' }), root, null);
    const payload = await bm.payloadAt(bookmarkId);
    const ringA = await exportKeyring();

    await becomeOtherInstall();
    await expect(decode(payload)).rejects.toThrow(); // the note is locked here

    expect(await importKeyring(ringA)).toBe(1);
    _resetCache();
    expect((await decode(payload)).body).toBe('SECRET FROM A'); // same bookmark, now readable
  });

  // The gap that mattered: re-encrypting an edited note with THIS install's key would
  // silently lock the origin out of a note it could previously read.
  it('editing keeps the key the note was written with', async () => {
    const root = await bm.ensureRoot();
    const { bookmarkId } = await saveNote(createNote({ title: 'Q3', body: 'v1 from A' }), root, null);
    const keyOfA = Object.keys(await rawKeys())[0];
    const ringA = await exportKeyring();

    // B mints its own key first, as a real second install would, then imports A's.
    await becomeOtherInstall();
    await activeKey();
    const keyOfB = Object.keys(await rawKeys())[0];
    expect(keyOfB).not.toBe(keyOfA);
    await importKeyring(ringA);
    _resetCache();

    const current = await decode(await bm.payloadAt(bookmarkId));
    await saveNote({ ...current, body: 'v2 edited by B' }, root, bookmarkId);
    const after = await bm.payloadAt(bookmarkId);

    // Back on A, which never had B's key.
    await restoreOnly(ringA);
    expect(Object.keys(await rawKeys())).toEqual([keyOfA]);
    expect((await decode(after)).body).toBe('v2 edited by B');
  });

  it('a brand-new note still uses this install\'s own key', async () => {
    const root = await bm.ensureRoot();
    const first = await saveNote(createNote({ title: 'a', body: 'x' }), root, null);
    const keyOfA = Object.keys(await rawKeys())[0];

    await becomeOtherInstall();
    const second = await saveNote(createNote({ title: 'b', body: 'y' }), root, null);
    const keyOfB = Object.keys(await rawKeys())[0];
    expect(keyOfB).not.toBe(keyOfA);

    // B reads its own note but not A's — no accidental key reuse.
    expect((await decode(await bm.payloadAt(second.bookmarkId))).body).toBe('y');
    await expect(decode(await bm.payloadAt(first.bookmarkId))).rejects.toThrow();
  });

});
