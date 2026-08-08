// The caption overlay is an injected IIFE with a CLOSED shadow root, so it has
// never had a test. Full mode is the first part of it with real state — a
// pull-based history fetch, pinning, and two render paths — so it gets one.
//
// The IIFE is executed fresh per test via new Function; attachShadow is patched
// to hand back an open root so the test can see inside.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync('src/content/overlay.js', 'utf8');

let sent;        // messages the overlay sent to the worker
let listeners;   // its chrome.runtime.onMessage handlers
let root;        // the captured shadow root
let realAttach;

function boot() {
  sent = [];
  listeners = [];
  root = null;
  globalThis.chrome = {
    runtime: {
      sendMessage: (m) => { sent.push(m); },
      onMessage: { addListener: (fn) => listeners.push(fn) },
    },
  };
  realAttach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function attachShadowOpen(init) {
    const opened = realAttach.call(this, { ...init, mode: 'open' });
    root = opened;
    return opened;
  };
  // eslint-disable-next-line no-new-func
  new Function(SOURCE)();
}

function deliver(message) {
  for (const fn of listeners) fn(message);
}
const el = (id) => root.getElementById(id);
const bubble = () => root.querySelector('.bubble');
const clickFull = () => el('full').dispatchEvent(new MouseEvent('click', { bubbles: true }));

beforeEach(() => {
  document.body.innerHTML = '';
  window.__owlOverlay = null;
  boot();
});
afterEach(() => {
  if (realAttach) Element.prototype.attachShadow = realAttach;
  window.__owlOverlay = null;
});

describe('overlay full mode', () => {
  it('mounts with a Full button in the top-right corner', () => {
    expect(el('full')).toBeTruthy();
    expect(root.querySelector('.corner').contains(el('full'))).toBe(true);
    expect(bubble().classList.contains('full')).toBe(false);
  });

  it('asks the worker for the whole transcript when full mode opens', () => {
    clickFull();
    expect(bubble().classList.contains('full')).toBe(true);
    expect(sent.some((m) => m.type === 'owl-panel-history')).toBe(true);
  });

  // The live pill only ever receives a TAIL. If the history response is not
  // rendered there is nothing older to scroll back to, and full mode looks
  // broken precisely because the box never overflows.
  it('renders the history response, not just the live tail', () => {
    deliver({ type: 'owl-overlay-update', text: 'the newest words only' });
    clickFull();
    deliver({
      type: 'owl-overlay-history',
      text: '## 0:00\n\nmuch older words\n\n## 3:00\n\nthe newest words only',
    });
    const shown = el('text').textContent;
    expect(shown).toContain('much older words');
    expect(root.querySelectorAll('.text h4')).toHaveLength(2);
    expect(root.querySelectorAll('.text p').length).toBeGreaterThanOrEqual(2);
  });

  it('renders speech as text, never as markup', () => {
    clickFull();
    deliver({ type: 'owl-overlay-history', text: 'watch out for <img src=x onerror=alert(1)>' });
    expect(root.querySelector('.text img')).toBeNull();
    expect(el('text').textContent).toContain('<img');
  });

  it('goes back to the clamped pill on toggle', () => {
    clickFull();
    deliver({ type: 'owl-overlay-history', text: 'older\n\nnewer' });
    clickFull();
    expect(bubble().classList.contains('full')).toBe(false);
  });

  // Icon only in the corner; the wording is a tooltip, so the pill stays a pill.
  it('labels the corner control by tooltip rather than by text', () => {
    expect(el('full').textContent.trim()).toBe('⤢');
    expect(el('full').title).toContain('Full mode');
    expect(el('full').getAttribute('aria-label')).toBe('Full mode');

    clickFull();
    expect(el('full').textContent.trim()).toBe('⤡');
    expect(el('full').title).toContain('Compact mode');
    expect(el('full').getAttribute('aria-label')).toBe('Compact mode');
  });

  it('keeps updating the live pill while full mode is closed', () => {
    deliver({ type: 'owl-overlay-update', text: 'hello there' });
    expect(el('text').textContent).toContain('hello there');
  });
});
