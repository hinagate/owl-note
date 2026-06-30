import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import { connect, disconnect, isConnected } from '../src/lib/drive/auth.js';

beforeEach(() => {
  installFakeChrome();
  chrome.identity = {
    getRedirectURL: () => 'https://ext-id.chromiumapp.org/',
    launchWebAuthFlow: vi.fn(async () => 'https://ext-id.chromiumapp.org/?code=AUTH_CODE'),
  };
});

describe('drive/auth connect', () => {
  it('runs the interactive flow, exchanges the code, and stores the refresh token', async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }) }));
    await connect();
    expect(chrome.identity.launchWebAuthFlow).toHaveBeenCalledWith(expect.objectContaining({ interactive: true }));
    expect(await isConnected()).toBe(true);
    const saved = (await chrome.storage.local.get('drive:tokens'))['drive:tokens'];
    expect(saved.refreshToken).toBe('RT');
  });

  it('throws when the user cancels the consent window', async () => {
    chrome.identity.launchWebAuthFlow = vi.fn(async () => { throw new Error('The user did not approve access.'); });
    await expect(connect()).rejects.toThrow();
    expect(await isConnected()).toBe(false);
  });

  it('disconnect clears stored tokens', async () => {
    await chrome.storage.local.set({ 'drive:tokens': { refreshToken: 'RT', accessToken: 'AT', expiresAt: Date.now() + 1000 } });
    await disconnect();
    expect(await isConnected()).toBe(false);
  });
});
