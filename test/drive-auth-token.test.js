import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import { getAccessToken, isConnected } from '../src/lib/drive/auth.js';

beforeEach(() => installFakeChrome());

const TOKENS = 'drive:tokens';

describe('drive/auth token lifecycle', () => {
  it('isConnected reflects a stored refresh token', async () => {
    expect(await isConnected()).toBe(false);
    await chrome.storage.local.set({ [TOKENS]: { refreshToken: 'rt', accessToken: '', expiresAt: 0 } });
    expect(await isConnected()).toBe(true);
  });

  it('returns the cached access token when still valid', async () => {
    await chrome.storage.local.set({ [TOKENS]: { refreshToken: 'rt', accessToken: 'AT', expiresAt: Date.now() + 600000 } });
    global.fetch = vi.fn();
    expect(await getAccessToken()).toBe('AT');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('refreshes silently when the access token is expired', async () => {
    await chrome.storage.local.set({ [TOKENS]: { refreshToken: 'rt', accessToken: 'OLD', expiresAt: Date.now() - 1000 } });
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ access_token: 'NEW', expires_in: 3600 }) }));
    expect(await getAccessToken()).toBe('NEW');
    const saved = (await chrome.storage.local.get(TOKENS))[TOKENS];
    expect(saved.accessToken).toBe('NEW');
    expect(saved.expiresAt).toBeGreaterThan(Date.now());
  });

  it('throws NeedsAuth when there is no refresh token', async () => {
    await expect(getAccessToken()).rejects.toMatchObject({ name: 'NeedsAuth' });
  });

  it('throws NeedsAuth when refresh fails (revoked)', async () => {
    await chrome.storage.local.set({ [TOKENS]: { refreshToken: 'rt', accessToken: '', expiresAt: 0 } });
    global.fetch = vi.fn(async () => ({ ok: false, status: 400, text: async () => 'invalid_grant' }));
    await expect(getAccessToken()).rejects.toMatchObject({ name: 'NeedsAuth' });
  });
});
