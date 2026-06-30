import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import * as client from '../src/lib/drive/client.js';
import { putAttachment } from '../src/lib/attachment-store.js';

vi.mock('../src/lib/drive/client.js', () => ({ findByHash: vi.fn(), uploadFile: vi.fn(), getMedia: vi.fn() }));

beforeEach(() => {
  installFakeChrome();
  client.findByHash.mockReset();
  client.uploadFile.mockReset();
});

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

describe('attachment-store putAttachment', () => {
  it('uploads new bytes and returns a reference without dataUri', async () => {
    client.findByHash.mockResolvedValue(null);
    client.uploadFile.mockResolvedValue('FID');
    const ref = await putAttachment({ id: 'h1', name: 'p.png', dataUri: PNG });
    expect(ref).toEqual({ id: 'h1', name: 'p.png', mime: 'image/png', driveFileId: 'FID' });
    expect(client.uploadFile).toHaveBeenCalledTimes(1);
    expect((await chrome.storage.local.get('owlcache:h1'))['owlcache:h1']).toBe(PNG); // cached locally
  });

  it('reuses an existing Drive file (dedup by hash) without uploading', async () => {
    client.findByHash.mockResolvedValue('EXISTING');
    const ref = await putAttachment({ id: 'h1', name: 'p.png', dataUri: PNG });
    expect(ref.driveFileId).toBe('EXISTING');
    expect(client.uploadFile).not.toHaveBeenCalled();
  });

  it('is a no-op for an attachment already offloaded (has driveFileId, no dataUri)', async () => {
    const ref = await putAttachment({ id: 'h1', name: 'p.png', mime: 'image/png', driveFileId: 'OLD' });
    expect(ref).toEqual({ id: 'h1', name: 'p.png', mime: 'image/png', driveFileId: 'OLD' });
    expect(client.findByHash).not.toHaveBeenCalled();
  });
});
