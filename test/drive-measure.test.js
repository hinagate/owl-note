import { describe, it, expect, beforeEach } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import { measuredBytes } from '../src/app/app.js';

beforeEach(() => installFakeChrome());

describe('size meter reflects Drive offload', () => {
  it('measures the offloaded shape (no inline bytes) when sync is enabled', async () => {
    const big = 'data:image/png;base64,' + 'A'.repeat(12000);
    const note = { id: 'n', title: 't', body: '![](owl-img:h1)', attachments: [{ id: 'h1', name: 'p.png', mime: 'image/png', dataUri: big }] };
    await chrome.storage.local.set({ 'drive:enabled': false });
    const without = await measuredBytes(note);
    await chrome.storage.local.set({ 'drive:enabled': true });
    const withOffload = await measuredBytes(note);
    expect(withOffload).toBeLessThan(without);
  });
});
