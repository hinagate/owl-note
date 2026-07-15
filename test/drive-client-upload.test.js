import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import { findByHash, uploadFile, createPublicShareLink } from '../src/lib/drive/client.js';

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
    let uploadedTo = null;
    global.fetch = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes('?q=')) return { ok: true, json: async () => ({ files: [{ id: 'FOLDER' }] }) }; // resolve folder by name
      uploadedTo = u;
      return { ok: true, json: async () => ({ id: 'NEW' }) };
    });
    const id = await uploadFile({ name: 'a.png', mime: 'image/png', bytes: new Uint8Array([1, 2, 3]), hash: 'h1' });
    expect(id).toBe('NEW');
    expect(uploadedTo).toContain('uploadType=multipart');
  });

  it('uploadFile self-heals a deleted folder: re-resolves the name and uploads to a fresh folder', async () => {
    await chrome.storage.local.set({ 'drive:folderId': 'DEAD' }); // stale id is ignored
    let uploads = 0;
    global.fetch = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes('/upload/')) { uploads += 1; return { ok: true, json: async () => ({ id: 'NEW' }) }; }
      if (u.includes('?q=')) return { ok: true, json: async () => ({ files: [] }) }; // name search -> none (deleted/trashed)
      return { ok: true, json: async () => ({ id: 'FRESH' }) }; // create a new folder
    });
    const id = await uploadFile({ name: 'a.png', mime: 'image/png', bytes: new Uint8Array([1, 2, 3]), hash: 'h1' });
    expect(id).toBe('NEW');
    expect(uploads).toBe(1); // no doomed attempt on the dead folder — resolved fresh first
    expect((await chrome.storage.local.get('drive:folderId'))['drive:folderId']).toBe('FRESH');
  });

  it('uploadFile rejects files over the 25 MB cap', async () => {
    const big = new Uint8Array(25 * 1024 * 1024 + 1);
    await expect(uploadFile({ name: 'big.bin', mime: 'application/octet-stream', bytes: big, hash: 'h' }))
      .rejects.toThrow(/too large/i);
  });

  it('creates an anyone-reader permission and returns the Drive viewer link', async () => {
    global.fetch = vi.fn(async (url, options = {}) => {
      if (String(url).includes('fields=webViewLink')) {
        return { ok: true, json: async () => ({ webViewLink: 'https://drive.google.com/viewer', permissions: [] }) };
      }
      expect(options.method).toBe('POST');
      expect(JSON.parse(options.body)).toEqual({ type: 'anyone', role: 'reader' });
      return { ok: true, json: async () => ({ id: 'permission' }) };
    });
    expect(await createPublicShareLink('PDF1')).toBe('https://drive.google.com/viewer');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('reuses an existing public permission instead of creating a duplicate', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ webViewLink: 'https://drive.google.com/viewer', permissions: [{ type: 'anyone', role: 'reader' }] }),
    }));
    expect(await createPublicShareLink('PDF1')).toBe('https://drive.google.com/viewer');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
