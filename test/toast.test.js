// toast() must give each message its own full 3s: a rapid second toast used to be cut
// short when the FIRST toast's stale hide-timer fired (UI audit). Fake timers prove the
// timer is reset per call.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';

let toast;

beforeEach(async () => {
  installFakeChrome();
  document.body.innerHTML = '<div id="toast" hidden></div>';
  vi.useFakeTimers();
  ({ toast } = await import('../src/app/app.js'));
});
afterEach(() => { vi.useRealTimers(); });

describe('toast', () => {
  it('a rapid second toast is not cut short by the first toast\'s hide timer', () => {
    const el = document.getElementById('toast');
    toast('first');
    expect(el.hidden).toBe(false);
    expect(el.textContent).toBe('first');

    vi.advanceTimersByTime(2000);   // 2s into first's 3s window
    toast('second');                // resets the timer
    expect(el.textContent).toBe('second');

    vi.advanceTimersByTime(1500);   // 3.5s from first (would have hidden) but 1.5s from second
    expect(el.hidden).toBe(false);  // second is STILL showing (the fix)

    vi.advanceTimersByTime(2000);   // now past second's own 3s
    expect(el.hidden).toBe(true);
  });

  it('a single toast still auto-hides after 3s', () => {
    const el = document.getElementById('toast');
    toast('hi');
    expect(el.hidden).toBe(false);
    vi.advanceTimersByTime(3000);
    expect(el.hidden).toBe(true);
  });
});
