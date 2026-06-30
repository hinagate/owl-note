import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import { getMedia } from '../src/lib/drive/client.js';

// Mock placed at module top level (NOT in beforeEach) per vitest requirements
vi.mock('../src/lib/drive/auth.js', () => ({ getAccessToken: vi.fn(async () => 'AT') }));

beforeEach(() => {
  installFakeChrome();
});

describe('drive/client getMedia', () => {
  it('downloads raw bytes via alt=media', async () => {
    let calledUrl = null;
    global.fetch = vi.fn(async (url) => {
      calledUrl = String(url);
      return { ok: true, arrayBuffer: async () => new Uint8Array([9, 8, 7]).buffer };
    });
    const bytes = await getMedia('FILE1');
    expect(Array.from(bytes)).toEqual([9, 8, 7]);
    expect(calledUrl).toContain('/FILE1?alt=media');
  });
});
