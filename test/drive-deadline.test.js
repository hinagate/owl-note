import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import { uploadTimeoutMs, fetchWithDeadline, downloadWithStallDeadline, DRIVE_REQUEST_TIMEOUT_MS } from '../src/lib/drive/deadline.js';
import { authedFetch, uploadFile, getMedia } from '../src/lib/drive/client.js';

vi.mock('../src/lib/drive/auth.js', () => ({ getAccessToken: vi.fn(async () => 'AT') }));

// A fetch that never answers, but stops waiting when its signal fires — exactly what a
// stalled upload looks like to the page, and what froze the capture badge at 99%.
const hangingFetch = () => vi.fn((url, opts = {}) => new Promise((_, reject) => {
  opts.signal?.addEventListener('abort', () => reject(opts.signal.reason ?? new DOMException('aborted', 'AbortError')));
}));

// A response whose body arrives in chunks on a schedule, and errors if its signal fires.
function streamingResponse(chunks, gapMs, signal) {
  let i = 0;
  const body = new ReadableStream({
    async pull(controller) {
      if (i >= chunks.length) { controller.close(); return; }
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, gapMs);
        signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')); });
      });
      controller.enqueue(chunks[i++]);
    },
  });
  return { ok: true, status: 200, body };
}

const realFetch = global.fetch;
beforeEach(() => { installFakeChrome(); });
afterEach(() => { global.fetch = realFetch; });

describe('Drive request deadlines', () => {
  it('lets an upload take as long as a 128 kbit/s link needs, on top of the request deadline', () => {
    expect(uploadTimeoutMs(0)).toBe(DRIVE_REQUEST_TIMEOUT_MS);
    // 24 MB — the largest a full-page capture gets — at 16 KiB/s is a little over 25 minutes.
    const big = uploadTimeoutMs(24 * 1024 * 1024);
    expect(big).toBeGreaterThan(25 * 60_000);
    expect(big).toBeLessThan(28 * 60_000);
    // A 5.4 MB capture on a 256 kbit/s link (32 KiB/s, ~170 s) must fit comfortably.
    expect(uploadTimeoutMs(5.4 * 1024 * 1024)).toBeGreaterThan((5.4 * 1024 * 1024) / (32 * 1024) * 1000);
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

describe('Drive downloads are bounded by silence, not by length', () => {
  it('finishes a slow download that keeps moving, however long it takes overall', async () => {
    const chunks = Array.from({ length: 8 }, (_, i) => new Uint8Array([i, i]));
    global.fetch = vi.fn(async (url, opts) => streamingResponse(chunks, 25, opts.signal));
    // Every gap (25 ms) is well inside the stall limit, but the total (200 ms) is far past it.
    const bytes = await downloadWithStallDeadline('https://example.test/f', {}, { startMs: 100, stallMs: 60 });
    expect(bytes).toHaveLength(16);
    expect([...bytes.slice(0, 4)]).toEqual([0, 0, 1, 1]);
  });

  it('gives up when the data stops arriving', async () => {
    global.fetch = vi.fn(async (url, opts) => streamingResponse([new Uint8Array([1]), new Uint8Array([2])], 200, opts.signal));
    await expect(downloadWithStallDeadline('https://example.test/f', {}, { startMs: 1000, stallMs: 50 }))
      .rejects.toMatchObject({ name: 'TimeoutError', message: expect.stringContaining('stalled') });
  });

  it('gives up when the reply never begins', async () => {
    global.fetch = hangingFetch();
    await expect(downloadWithStallDeadline('https://example.test/f', {}, { startMs: 30, stallMs: 1000 }))
      .rejects.toMatchObject({ name: 'TimeoutError', message: expect.stringContaining('timed out') });
  });

  it('keeps the Drive error shape the cleanup code matches on', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 404 }));
    await expect(getMedia('GONE')).rejects.toThrow(/Drive API 404/);
  });

  it('getMedia returns the whole file', async () => {
    global.fetch = vi.fn(async (url, opts) => streamingResponse([new Uint8Array([7, 8]), new Uint8Array([9])], 1, opts.signal));
    expect([...await getMedia('F')]).toEqual([7, 8, 9]);
  });
});
