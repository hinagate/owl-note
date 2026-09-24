import { describe, it, expect, vi, afterEach } from 'vitest';
import { withKeepAlive, KEEPALIVE_INTERVAL_MS } from '../src/lib/keepalive.js';

afterEach(() => { vi.useRealTimers(); });

describe('withKeepAlive', () => {
  it('pings well inside Chrome\'s 30 s idle window while the work is pending', () => {
    expect(KEEPALIVE_INTERVAL_MS).toBeLessThan(30_000);
  });

  it('keeps pinging for as long as the work runs, then stops', async () => {
    vi.useFakeTimers();
    const ping = vi.fn();
    let finish;
    const running = withKeepAlive(() => new Promise((resolve) => { finish = resolve; }), { ping });

    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS * 3);
    expect(ping).toHaveBeenCalledTimes(3);

    finish('saved');
    await expect(running).resolves.toBe('saved');
    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS * 3);
    expect(ping).toHaveBeenCalledTimes(3);
  });

  it('stops pinging when the work throws, and passes the error on', async () => {
    vi.useFakeTimers();
    const ping = vi.fn();
    const running = withKeepAlive(async () => { throw new Error('upload failed'); }, { ping });
    await expect(running).rejects.toThrow('upload failed');
    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS * 3);
    expect(ping).not.toHaveBeenCalled();
  });

  it('gives up after its ceiling, so a missed deadline cannot pin the worker forever', async () => {
    vi.useFakeTimers();
    const ping = vi.fn();
    withKeepAlive(() => new Promise(() => {}), { ping, intervalMs: 1000, maxMs: 5000 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ping.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it('pings a real extension API by default', async () => {
    vi.useFakeTimers();
    const getPlatformInfo = vi.fn(async () => ({ os: 'win' }));
    globalThis.chrome = { runtime: { getPlatformInfo } };
    let finish;
    const running = withKeepAlive(() => new Promise((resolve) => { finish = resolve; }));
    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS);
    expect(getPlatformInfo).toHaveBeenCalledTimes(1);
    finish();
    await running;
  });
});
