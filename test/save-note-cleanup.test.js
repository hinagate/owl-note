import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import * as bm from '../src/lib/bookmarks.js';
import * as client from '../src/lib/drive/client.js';
import { saveNote } from '../src/lib/save-note.js';

vi.mock('../src/lib/drive/client.js', () => ({
  deleteFile: vi.fn(async () => {}), uploadFile: vi.fn(), updateMedia: vi.fn(),
  getMedia: vi.fn(), findByHash: vi.fn(), ensureFolder: vi.fn(), authedFetch: vi.fn(),
}));

const noop = async (n) => n; // offload no-op: attachments already carry a driveFileId

beforeEach(() => { installFakeChrome(); client.deleteFile.mockClear(); });

describe('saveNote attachment cleanup', () => {
  it('deletes the Drive file of an attachment removed from a note', async () => {
    const root = await bm.ensureRoot();
    const v1 = { id: 'n1', title: 'N', body: '[a](owl-file:a1)[b](owl-file:b1)', version: 2, hash: 'h1',
      attachments: [{ id: 'a1', name: 'a', driveFileId: 'FA' }, { id: 'b1', name: 'b', driveFileId: 'FB' }] };
    const r1 = await saveNote(v1, root, undefined, noop);
    const v2 = { ...v1, body: '[a](owl-file:a1)', attachments: [{ id: 'a1', name: 'a', driveFileId: 'FA' }] };
    await saveNote(v2, root, r1.bookmarkId, noop);
    expect(client.deleteFile).toHaveBeenCalledWith('FB'); // removed attachment's file
    expect(client.deleteFile).not.toHaveBeenCalledWith('FA'); // kept attachment's file
  });

  it('keeps a removed attachment\'s file if another note still uses it', async () => {
    const root = await bm.ensureRoot();
    await saveNote({ id: 'other', title: 'O', body: '[s](owl-file:s1)', version: 2, hash: 'ho',
      attachments: [{ id: 's1', name: 's', driveFileId: 'FS' }] }, root, undefined, noop);
    const v1 = { id: 'n1', title: 'N', body: '[s](owl-file:s1)', version: 2, hash: 'h1',
      attachments: [{ id: 's1', name: 's', driveFileId: 'FS' }] };
    const r1 = await saveNote(v1, root, undefined, noop);
    await saveNote({ ...v1, body: 'gone', attachments: [] }, root, r1.bookmarkId, noop);
    expect(client.deleteFile).not.toHaveBeenCalled(); // FS still used by 'other'
  });

  it('does not delete anything when no attachment was removed', async () => {
    const root = await bm.ensureRoot();
    const v1 = { id: 'n1', title: 'N', body: '[a](owl-file:a1)', version: 2, hash: 'h1',
      attachments: [{ id: 'a1', name: 'a', driveFileId: 'FA' }] };
    const r1 = await saveNote(v1, root, undefined, noop);
    await saveNote({ ...v1, body: '[a](owl-file:a1) edited' }, root, r1.bookmarkId, noop);
    expect(client.deleteFile).not.toHaveBeenCalled();
  });
});
