import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import * as bm from '../src/lib/bookmarks.js';
import * as mirror from '../src/lib/mirror.js';
import * as client from '../src/lib/drive/client.js';
import { encode } from '../src/lib/codec.js';
import { deleteUnreferencedFiles, driveFileIdsOf } from '../src/lib/drive-gc.js';

vi.mock('../src/lib/drive/client.js', () => ({ deleteFile: vi.fn(async () => {}), getMedia: vi.fn() }));

beforeEach(() => { installFakeChrome(); client.deleteFile.mockClear(); client.getMedia.mockReset(); });

describe('drive-gc', () => {
  it('driveFileIdsOf collects the body file and attachment file ids', () => {
    expect(driveFileIdsOf({ _driveBody: 'B', attachments: [{ driveFileId: 'A1' }, { driveFileId: 'A2' }, {}] }))
      .toEqual(['B', 'A1', 'A2']);
    expect(driveFileIdsOf(null)).toEqual([]);
  });

  it('deleteUnreferencedFiles deletes only files no note references (bookmarks)', async () => {
    const root = await bm.ensureRoot();
    await bm.createNote(root, 'K', await encode({ id: 'k', attachments: [{ id: 'x', driveFileId: 'KEEP' }] }));
    await deleteUnreferencedFiles(['KEEP', 'ORPHAN']);
    expect(client.deleteFile).toHaveBeenCalledWith('ORPHAN');
    expect(client.deleteFile).not.toHaveBeenCalledWith('KEEP');
    expect(client.deleteFile).toHaveBeenCalledTimes(1);
  });

  it('deleteUnreferencedFiles also spares a file referenced only by a local-mirror note', async () => {
    await mirror.saveBackup({ id: 'm', attachments: [{ id: 'y', driveFileId: 'MKEEP' }] }, { localOnly: true });
    await deleteUnreferencedFiles(['MKEEP', 'GONE']);
    expect(client.deleteFile).toHaveBeenCalledWith('GONE');
    expect(client.deleteFile).not.toHaveBeenCalledWith('MKEEP');
  });

  it('spares a file held inside a surviving over-cap (stub) note\'s Drive body', async () => {
    const root = await bm.ensureRoot();
    // Stub bookmark carries only _driveBody (no attachments); its attachments live in the Drive body.
    await bm.createNote(root, 'B', await encode({ id: 'b', _driveBody: 'BODYB', preview: 'x' }));
    const body = await encode({ id: 'b', attachments: [{ id: 'h', driveFileId: 'SHARED' }] });
    client.getMedia.mockResolvedValue(new TextEncoder().encode(body)); // loadNoteBody(BODYB) -> B's payload
    await deleteUnreferencedFiles(['SHARED', 'ORPHAN']);
    expect(client.deleteFile).toHaveBeenCalledWith('ORPHAN');
    expect(client.deleteFile).not.toHaveBeenCalledWith('SHARED'); // referenced INSIDE the stub body
  });

  it('aborts (deletes nothing) when a stub body cannot be read', async () => {
    const root = await bm.ensureRoot();
    await bm.createNote(root, 'B', await encode({ id: 'b', _driveBody: 'BODYB' }));
    client.getMedia.mockRejectedValue(new Error('offline'));
    await deleteUnreferencedFiles(['ORPHAN']);
    expect(client.deleteFile).not.toHaveBeenCalled(); // couldn't verify the stub -> leak, never lose
  });

  it('deleteUnreferencedFiles does nothing for an empty candidate list', async () => {
    await deleteUnreferencedFiles([]);
    expect(client.deleteFile).not.toHaveBeenCalled();
  });
});
