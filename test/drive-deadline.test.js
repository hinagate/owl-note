import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import { uploadTimeoutMs, fetchWithDeadline, DRIVE_REQUEST_TIMEOUT_MS } from '../src/lib/drive/deadline.js';
import { authedFetch, uploadFile } from '../src/lib/drive/client.js';

vi.mock('../src/lib/drive/auth.js', () => ({ getAccessToken: vi.fn(async () => 'AT') }));

// A fetch that never answers, but stops waiting when its signal fires — exactly what a
// stalled upload looks like to the page, and what froze the capture badge at 99%.
const hangingFetch = () => vi.fn((url, opts = {}) => new Promise((_, reject) => {
  opts.signal?.addEventListener('abort', () => reject(opts.signal.reason ?? new DOMException('aborted', 'AbortError')));
}));

const realFetch = global.fetch;
beforeEach(() => { installFakeChrome(); });
afterEach(() => { global.fetch = realFetch; });

describe('Drive request deadlines', () => {
  it('gives an upload time for its bytes at a slow floor rate, on top of the request deadline', () => {
    expect(uploadTimeoutMs(0)).toBe(DRIVE_REQUEST_TIMEOUT_MS);
    // 24 MB — the largest a full-page capture gets — at 64 KiB/s is a little over 6 minutes.
    const big = uploadTimeoutMs(24 * 1024 * 1024);
    expect(big).toBeGreaterThan(6 * 60_000);
    expect(big).toBeLessThan(8 * 60_000);
  });

  it('rejects a request that never answers instead of waiting forever', async () => {
    global.fetch = hangingFetch();
    await expect(fetchWithDeadline('https://example.test/x', {}, 30))
      .rejects.toMatchObject({ name: 'TimeoutError', message: expect.stringContaining('timed out') });
  });

  it('bounds every authed Drive call', async () => {
    global.fetch = hangingFetch();
    await expect(authedFetch('https://www.googleapis.com/drive/v3/files', { timeoutMs: 30 }))
      .rejects.toThrow(/timed out/);
    expect(global.fetch.mock.calls[0][1].signal).toBeTruthy();
  });

  it('sends the upload with a deadline sized to its body', async () => {
    const seen = [];
    global.fetch = vi.fn(async (url, opts) => {
      seen.push({ url: String(url), signal: opts.signal });
      if (String(url).includes('?q=')) return { ok: true, json: async () => ({ files: [{ id: 'FOLDER' }] }) };
      return { ok: true, json: async () => ({ id: 'NEW' }) };
    });
    await uploadFile({ name: 'a.jpg', mime: 'image/jpeg', bytes: new Uint8Array(1000), hash: 'h' });
    const upload = seen.find((s) => s.url.includes('uploadType=multipart'));
    expect(upload.signal).toBeTruthy();
    expect(upload.signal.aborted).toBe(false);
  });

  it('passes an ordinary network error through unchanged', async () => {
    global.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    await expect(fetchWithDeadline('https://example.test/x', {}, 1000)).rejects.toThrow('Failed to fetch');
  });
});
