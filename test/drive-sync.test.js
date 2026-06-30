import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import * as auth from '../src/lib/drive/auth.js';
import { isEnabled, enable, disable } from '../src/lib/drive-sync.js';

vi.mock('../src/lib/drive/auth.js', () => ({ connect: vi.fn(async () => {}), disconnect: vi.fn(async () => {}) }));

beforeEach(() => {
  installFakeChrome();
  auth.connect.mockClear(); auth.disconnect.mockClear();
  chrome.permissions = { request: vi.fn(async () => true) };
});

describe('drive-sync', () => {
  it('is disabled by default', async () => { expect(await isEnabled()).toBe(false); });

  it('enable requests host permission, connects, and sets the flag', async () => {
    await enable();
    expect(chrome.permissions.request).toHaveBeenCalledWith({ origins: ['https://www.googleapis.com/*'] });
    expect(auth.connect).toHaveBeenCalled();
    expect(await isEnabled()).toBe(true);
  });

  it('enable does NOT set the flag if the permission is denied', async () => {
    chrome.permissions.request = vi.fn(async () => false);
    await expect(enable()).rejects.toThrow();
    expect(auth.connect).not.toHaveBeenCalled();
    expect(await isEnabled()).toBe(false);
  });

  it('disable clears the flag and disconnects', async () => {
    await chrome.storage.local.set({ 'drive:enabled': true });
    await disable();
    expect(auth.disconnect).toHaveBeenCalled();
    expect(await isEnabled()).toBe(false);
  });
});
