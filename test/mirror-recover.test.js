import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import * as mirror from '../src/lib/mirror.js';

beforeEach(() => { installFakeChrome(); });

const MIN = 16384; // what the app passes: twice the 8 KB bookmark sync cap
const NOW = 10_000_000;
const jpeg = (chars) => `data:image/jpeg;base64,${'A'.repeat(chars)}`;
const capture = (id, dataUri = jpeg(100_000)) => ({
  id, title: 'Page', body: `![Page](owl-img:${id}img)`,
  attachments: [{ id: `${id}img`, name: 'Page.jpg', mime: 'image/jpeg', dataUri }],
});

async function put(id, entry) {
  await chrome.storage.local.set({ [`note:${id}`]: entry });
}

const recover = (overrides = {}) => mirror.recoverStrandedNotes({
  folderFor: async (folderId) => folderId || 'ROOT',
  bookmarkedIds: async () => new Set(),
  minInlineChars: MIN,
  now: NOW,
  ...overrides,
});

describe('recoverStrandedNotes — saves cut off before their bookmark existed', () => {
  it('files an abandoned pending copy in the notebook it was headed for', async () => {
    await put('p1', { current: capture('p1'), previous: null, localOnly: false, pending: { folderId: 'NB', at: NOW - mirror.PENDING_GRACE_MS - 1 } });
    expect(await recover()).toBe(1);
    const entry = await mirror.getBackup('p1');
    expect(entry).toMatchObject({ localOnly: true, folderId: 'NB' });
    expect(entry.pending).toBeUndefined();
    expect(await mirror.localOnlyBackups('NB')).toEqual([expect.objectContaining({ id: 'p1' })]);
  });

  it('leaves a pending copy alone while its save could still be running', async () => {
    await put('p2', { current: capture('p2'), previous: null, localOnly: false, pending: { folderId: 'NB', at: NOW - 60_000 } });
    expect(await recover()).toBe(0);
    expect((await mirror.getBackup('p2')).localOnly).toBe(false);
  });

  it('only clears the marker when the bookmark did get made', async () => {
    await put('p3', { current: capture('p3'), previous: null, localOnly: false, pending: { folderId: 'NB', at: 0 } });
    expect(await recover({ bookmarkedIds: async () => new Set(['p3']) })).toBe(0);
    const entry = await mirror.getBackup('p3');
    expect(entry.pending).toBeUndefined();
    expect(entry.localOnly).toBe(false); // listed through its bookmark, not as a local note
  });

  it('brings back a capture stranded before saves were marked', async () => {
    await put('old', { current: capture('old'), previous: null, localOnly: false });
    expect(await recover()).toBe(1);
    expect(await mirror.getBackup('old')).toMatchObject({ localOnly: true, folderId: 'ROOT' });
  });

  it('never touches a note that could have come from another device', async () => {
    // Synced in through a bookmark, then deleted elsewhere: its inline bytes fit a bookmark.
    await put('synced', { current: capture('synced', jpeg(4000)), previous: null, localOnly: false });
    // A completed save: its second write moved the first copy into `previous`.
    await put('done', { current: capture('done'), previous: capture('done'), localOnly: false });
    // Already filed by a folder.
    await put('filed', { current: capture('filed'), previous: null, localOnly: false, folderId: 'NB' });
    // A large but compressible image could have deflated into a bookmark.
    await put('bmp', { current: capture('bmp', `data:image/bmp;base64,${'A'.repeat(100_000)}`), previous: null, localOnly: false });
    // No image at all.
    await put('text', { current: { id: 'text', title: 't', body: 'x', attachments: [] }, previous: null, localOnly: false });
    expect(await recover()).toBe(0);
  });

  it('skips a stranded-looking copy whose note still has a bookmark', async () => {
    await put('listed', { current: capture('listed'), previous: null, localOnly: false });
    expect(await recover({ bookmarkedIds: async () => new Set(['listed']) })).toBe(0);
    expect((await mirror.getBackup('listed')).localOnly).toBe(false);
  });

  it('does not read the bookmarks when there is nothing to recover', async () => {
    const bookmarkedIds = vi.fn(async () => new Set());
    await put('fine', { current: capture('fine'), previous: capture('fine'), localOnly: false });
    expect(await recover({ bookmarkedIds })).toBe(0);
    expect(bookmarkedIds).not.toHaveBeenCalled();
  });
});
