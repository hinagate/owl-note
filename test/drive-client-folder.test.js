import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import { ensureFolder } from '../src/lib/drive/client.js';

vi.mock('../src/lib/drive/auth.js', () => ({ getAccessToken: vi.fn(async () => 'AT') }));

describe('drive/client ensureFolder', () => {
  beforeEach(() => {
    installFakeChrome();
  });

  it('reuses a cached folder id without calling Drive', async () => {
    await chrome.storage.local.set({ 'drive:folderId': 'CACHED' });
    global.fetch = vi.fn();
    expect(await ensureFolder()).toBe('CACHED');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('adopts an existing folder found by name', async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ files: [{ id: 'FOUND' }] }) }));
    expect(await ensureFolder()).toBe('FOUND');
    expect((await chrome.storage.local.get('drive:folderId'))['drive:folderId']).toBe('FOUND');
  });

  it('creates the folder when none exists', async () => {
    const calls = [];
    global.fetch = vi.fn(async (url, opts) => {
      calls.push(url);
      if (String(url).includes('/files?')) return { ok: true, json: async () => ({ files: [] }) }; // list -> empty
      return { ok: true, json: async () => ({ id: 'CREATED' }) }; // create
    });
    expect(await ensureFolder()).toBe('CREATED');
    expect(calls.some((u) => String(u).includes('/files?'))).toBe(true);
  });
});
