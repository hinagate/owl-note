import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import * as mirror from '../src/lib/mirror.js';

beforeEach(() => { installFakeChrome(); });

const NOW = 10_000_000_000;
const LONG_AGO = NOW - mirror.PENDING_GRACE_MS - 60_000;

// Real capture JPEGs barely deflate; random bytes model that. A near-blank page's JPEG
// deflates twentyfold and can sync as an ordinary bookmark, so the fixtures must not use
// 'A'.repeat(...) — that is the most compressible data there is.
function randomBase64(bytes) {
  const raw = new Uint8Array(bytes);
  for (let i = 0; i < raw.length; i += 65536) crypto.getRandomValues(raw.subarray(i, Math.min(i + 65536, raw.length)));
  let s = '';
  for (let i = 0; i < raw.length; i += 0x8000) s += String.fromCharCode(...raw.subarray(i, i + 0x8000));
  return btoa(s);
}
const realCapture = () => `data:image/jpeg;base64,${randomBase64(400 * 1024)}`; // ~400 KB, like a real capture
const blankCapture = () => `data:image/jpeg;base64,${'/9j/4AAQ'.repeat(6000)}`; // 48 KB of chars, deflates to little

const note = (id, dataUri = realCapture()) => ({
  id, title: 'Page', body: `![Page](owl-img:${id}img)`, updated: 1, version: 1,
  attachments: [{ id: `${id}img`, name: 'Page.jpg', mime: 'image/jpeg', dataUri }],
});

async function put(id, entry) {
  await chrome.storage.local.set({ [`note:${id}`]: entry });
}

const recover = (overrides = {}) => mirror.recoverStrandedNotes({
  folderFor: async (folderId) => folderId || 'ROOT',
  bookmarkedIds: async () => new Set(),
  now: NOW,
  ...overrides,
});

describe('recoverStrandedNotes — marked saves', () => {
  it('files an abandoned pending copy in the notebook it was headed for', async () => {
    await put('p1', { current: note('p1'), previous: null, localOnly: false, pending: { folderId: 'NB', at: LONG_AGO } });
    expect(await recover()).toBe(1);
    const entry = await mirror.getBackup('p1');
    expect(entry).toMatchObject({ localOnly: true, folderId: 'NB' });
    expect(entry.pending).toBeUndefined();
    expect(await mirror.localOnlyBackups('NB')).toEqual([expect.objectContaining({ id: 'p1' })]);
  });

  it('leaves a pending copy alone while its save could still be running', async () => {
    await put('p2', { current: note('p2'), previous: null, localOnly: false, pending: { folderId: 'NB', at: NOW - 60 * 60_000 } });
    expect(await recover()).toBe(0);
    expect((await mirror.getBackup('p2')).localOnly).toBe(false);
  });

  it('only clears the marker when the bookmark did get made', async () => {
    await put('p3', { current: note('p3'), previous: null, localOnly: false, pending: { folderId: 'NB', at: 0 } });
    expect(await recover({ bookmarkedIds: async () => new Set(['p3']) })).toBe(0);
    const entry = await mirror.getBackup('p3');
    expect(entry.pending).toBeUndefined();
    expect(entry.localOnly).toBe(false); // listed through its bookmark, not as a local note
  });

  it('does not overwrite a copy that was saved again while the bookmarks were being read', async () => {
    await put('p4', { current: note('p4'), previous: null, localOnly: false, pending: { folderId: 'NB', at: LONG_AGO } });
    const bookmarkedIds = async () => {
      // An open tab saves the note mid-sweep: a normal saveBackup drops the marker.
      await mirror.saveBackup({ ...note('p4'), title: 'Edited' }, { localOnly: false });
      return new Set();
    };
    expect(await recover({ bookmarkedIds })).toBe(0);
    const entry = await mirror.getBackup('p4');
    expect(entry.current.title).toBe('Edited');
    expect(entry.localOnly).toBe(false);
  });
});

describe('recoverStrandedNotes — copies stranded before saves were marked', () => {
  it('brings back a real capture, once asked to look for them', async () => {
    await put('old', { current: note('old'), previous: null, localOnly: false });
    expect(await recover()).toBe(0); // not looked for unless asked
    expect(await recover({ includeLegacy: true })).toBe(1);
    expect(await mirror.getBackup('old')).toMatchObject({ localOnly: true, folderId: 'ROOT' });
  });

  it('never brings back a note that could have synced in from another device', async () => {
    // The reviewer's case: a blank capture whose JPEG deflates small enough to sync as an
    // ordinary bookmark, mirrored on this device and later deleted on its origin.
    await put('blank', { current: note('blank', blankCapture()), previous: null, localOnly: false });
    // A completed save: its second write moved the first copy into `previous`.
    await put('done', { current: note('done'), previous: note('done'), localOnly: false });
    // Already filed by a folder.
    await put('filed', { current: note('filed'), previous: null, localOnly: false, folderId: 'NB' });
    // No image at all.
    await put('text', { current: { id: 'text', title: 't', body: 'x', attachments: [] }, previous: null, localOnly: false });
    expect(await recover({ includeLegacy: true })).toBe(0);
  });

  it('skips a stranded-looking copy whose note still has a bookmark', async () => {
    await put('listed', { current: note('listed'), previous: null, localOnly: false });
    expect(await recover({ includeLegacy: true, bookmarkedIds: async () => new Set(['listed']) })).toBe(0);
    expect((await mirror.getBackup('listed')).localOnly).toBe(false);
  });

  it('does not read the bookmarks when there is nothing to recover', async () => {
    const bookmarkedIds = vi.fn(async () => new Set());
    await put('fine', { current: note('fine'), previous: note('fine'), localOnly: false });
    expect(await recover({ includeLegacy: true, bookmarkedIds })).toBe(0);
    expect(bookmarkedIds).not.toHaveBeenCalled();
  });
});

describe('fileAbandonedSave — the worker saving it is known to be gone', () => {
  const opts = (listed = []) => ({ bookmarkedIds: async () => new Set(listed), folderFor: async (f) => f || 'ROOT' });

  it('files the note at once, with no grace period', async () => {
    await put('dead', { current: note('dead'), previous: null, localOnly: false, pending: { folderId: 'NB', at: NOW } });
    expect(await mirror.fileAbandonedSave('dead', opts())).toBe(true);
    expect(await mirror.getBackup('dead')).toMatchObject({ localOnly: true, folderId: 'NB' });
    expect((await mirror.getBackup('dead')).pending).toBeUndefined();
  });

  it('only clears the marker when the bookmark was made before the worker died', async () => {
    await put('late', { current: note('late'), previous: null, localOnly: false, pending: { folderId: 'NB', at: NOW } });
    expect(await mirror.fileAbandonedSave('late', opts(['late']))).toBe(false);
    const entry = await mirror.getBackup('late');
    expect(entry.localOnly).toBe(false);
    expect(entry.pending).toBeUndefined();
  });

  it('leaves alone a note whose save completed, or that never started', async () => {
    await put('done', { current: note('done'), previous: note('done'), localOnly: false });
    expect(await mirror.fileAbandonedSave('done', opts())).toBe(false);
    expect(await mirror.fileAbandonedSave('missing', opts())).toBe(false);
    expect((await mirror.getBackup('done')).localOnly).toBe(false);
  });
});
