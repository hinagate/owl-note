import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import * as client from '../src/lib/drive/client.js';
import { bodyPreview, saveNoteBody, loadNoteBody, deleteNoteBody, stubForBigNote } from '../src/lib/note-drive.js';

vi.mock('../src/lib/drive/client.js', () => ({
  uploadFile: vi.fn(),
  updateMedia: vi.fn(),
  getMedia: vi.fn(),
  deleteFile: vi.fn(),
}));

beforeEach(() => {
  installFakeChrome();
  client.uploadFile.mockReset();
  client.updateMedia.mockReset();
  client.getMedia.mockReset();
  client.deleteFile.mockReset();
});

describe('note-drive', () => {
  it('bodyPreview truncates to 200 chars and tolerates null', () => {
    expect(bodyPreview('x'.repeat(300)).length).toBe(200);
    expect(bodyPreview(null)).toBe('');
  });

  it('saveNoteBody creates a new file when there is no existing id', async () => {
    client.uploadFile.mockResolvedValue('NEW');
    expect(await saveNoteBody('n1', 'PAYLOAD', null)).toBe('NEW');
    expect(client.uploadFile).toHaveBeenCalledTimes(1);
    expect(client.updateMedia).not.toHaveBeenCalled();
  });

  it('saveNoteBody overwrites an existing file in place', async () => {
    client.updateMedia.mockResolvedValue('OLD');
    expect(await saveNoteBody('n1', 'PAYLOAD', 'OLD')).toBe('OLD');
    expect(client.updateMedia).toHaveBeenCalledTimes(1);
    const [fileId, bytes] = client.updateMedia.mock.calls[0];
    expect(fileId).toBe('OLD');
    expect(new TextDecoder().decode(bytes)).toBe('PAYLOAD');
    expect(client.uploadFile).not.toHaveBeenCalled();
  });

  it('loadNoteBody decodes the fetched bytes back to the payload string', async () => {
    client.getMedia.mockResolvedValue(new TextEncoder().encode('PAYLOAD'));
    expect(await loadNoteBody('F')).toBe('PAYLOAD');
  });

  it('deleteNoteBody deletes the Drive file', async () => {
    await deleteNoteBody('F');
    expect(client.deleteFile).toHaveBeenCalledWith('F');
  });

  it('stubForBigNote returns null (no upload) when Drive sync is off', async () => {
    expect(await stubForBigNote({ id: 'n', title: 't', body: 'B' }, 'PAYLOAD', null)).toBe(null);
    expect(client.uploadFile).not.toHaveBeenCalled();
  });

  it('stubForBigNote uploads and returns a metadata-only stub when enabled', async () => {
    await chrome.storage.local.set({ 'drive:enabled': true });
    client.uploadFile.mockResolvedValue('FID');
    const note = { id: 'n', title: 'Big', body: 'BODY '.repeat(80), created: 5, version: 2, hash: 'h2', pinned: false };
    const res = await stubForBigNote(note, 'PAYLOAD', null);
    expect(res.fileId).toBe('FID');
    expect(res.stub).toMatchObject({ id: 'n', title: 'Big', version: 2, hash: 'h2', _driveBody: 'FID' });
    expect(res.stub.preview.length).toBeLessThanOrEqual(200);
    expect(res.stub.body).toBeUndefined(); // the stub carries no full body
  });
});
