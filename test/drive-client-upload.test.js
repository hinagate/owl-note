import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import { findByHash, uploadFile } from '../src/lib/drive/client.js';

vi.mock('../src/lib/drive/auth.js', () => ({ getAccessToken: vi.fn(async () => 'AT') }));

beforeEach(() => {
  installFakeChrome();
});

describe('drive/client upload', () => {
  it('findByHash returns the fileId of a matching appProperties file', async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ files: [{ id: 'HIT' }] }) }));
    expect(await findByHash('abc')).toBe('HIT');
  });

  it('findByHash returns null when none match', async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ files: [] }) }));
    expect(await findByHash('abc')).toBe(null);
  });

  it('uploadFile multipart-posts to the upload endpoint and returns the new id', async () => {
    await chrome.storage.local.set({ 'drive:folderId': 'FOLDER' });
    let uploadedTo = null;
    global.fetch = vi.fn(async (url) => {
      uploadedTo = String(url);
      return { ok: true, json: async () => ({ id: 'NEW' }) };
    });
    const id = await uploadFile({ name: 'a.png', mime: 'image/png', bytes: new Uint8Array([1, 2, 3]), hash: 'h1' });
    expect(id).toBe('NEW');
    expect(uploadedTo).toContain('uploadType=multipart');
  });

  it('uploadFile rejects files over the 25 MB cap', async () => {
    const big = new Uint8Array(25 * 1024 * 1024 + 1);
    await expect(uploadFile({ name: 'big.bin', mime: 'application/octet-stream', bytes: big, hash: 'h' }))
      .rejects.toThrow(/too large/i);
  });
});
