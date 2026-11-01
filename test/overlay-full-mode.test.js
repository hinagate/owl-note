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

describe('overlay compact pill', () => {
  const newest = () => [...el('text').childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join('');
  const older = () => root.querySelector('.text .old')?.textContent || '';

  // Skipping a fixed ". " after 。 cut the first character off every new sentence.
  it('keeps the first character of a new Chinese or Japanese sentence', () => {
    deliver({ type: 'owl-overlay-update', text: '今天很好。我們走吧' });
    expect(older()).toBe('今天很好。');
    expect(newest()).toBe('我們走吧');
    deliver({ type: 'owl-overlay-update', text: '今日は晴れです。明日は雨' });
    expect(newest()).toBe('明日は雨');
  });

  it('dims everything before the newest English sentence', () => {
    deliver({ type: 'owl-overlay-update', text: 'First one. Is this second? Third here' });
    expect(older()).toBe('First one. Is this second? ');
    expect(newest()).toBe('Third here');
    expect(el('text').textContent).toBe('First one. Is this second? Third here');
  });
});

describe('overlay question when a video has no subtitles', () => {
  it('shows its answers without a hover, and starts live on request', () => {
    deliver({ type: 'owl-overlay-update', state: 'no subtitles', text: 'This video has no subtitles.', armed: true, offerLive: true });
    expect(el('live').hidden).toBe(false);
    expect(bubble().classList.contains('asking')).toBe(true);
    expect(el('stop').textContent).toBe('Cancel');

    el('live').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(sent).toContainEqual({ type: 'owl-panel-start-live' });
    expect(el('live').hidden).toBe(true);
  });

  it('puts the question away once recording starts', () => {
    deliver({ type: 'owl-overlay-update', armed: true, offerLive: true });
    deliver({ type: 'owl-overlay-update', canSave: true, armed: false });
    expect(el('live').hidden).toBe(true);
    expect(bubble().classList.contains('asking')).toBe(false);
  });
});

describe('overlay language button', () => {
  const LANGS = [
    { tag: 'en-US', label: 'English (United States)', name: 'English' },
    { tag: 'zh-TW', label: 'Chinese, Mandarin (Traditional)', name: '中文' },
  ];
  const press = (node) => {
    node.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  };
  const recording = () => deliver({
    type: 'owl-overlay-update', canSave: true, armed: false, lang: 'en-US', langName: 'English', languages: LANGS,
  });

  it('stays hidden until the session records and knows its languages', () => {
    expect(el('lang').hidden).toBe(true);
    deliver({ type: 'owl-overlay-update', canSave: true, armed: false });
    expect(el('lang').hidden).toBe(true);
    recording();
    expect(el('lang').hidden).toBe(false);
    expect(el('lang').textContent).toContain('English');
  });

  it('lists the installed languages, marks the current one, and switches on a pick', () => {
    recording();
    press(el('lang'));
    expect(el('menu').hidden).toBe(false);
    const items = [...el('menu').querySelectorAll('button')];
    // Each language in its own name, with the English label beside it.
    expect(items.map((b) => [b.firstChild.nodeValue, b.querySelector('.label')?.textContent])).toEqual([
      ['English', 'English (United States)'],
      ['中文', 'Chinese, Mandarin (Traditional)'],
      ['Add a language…', undefined],
    ]);
    expect(items[0].getAttribute('aria-checked')).toBe('true');
    expect(items[1].getAttribute('aria-checked')).toBe('false');

    press(items[1]);
    expect(sent).toContainEqual({ type: 'owl-panel-language', lang: 'zh-TW' });
    expect(el('menu').hidden).toBe(true);
  });

  it('does not ask to switch to the language already in use', () => {
    recording();
    press(el('lang'));
    press(el('menu').querySelector('button'));
    expect(sent.some((m) => m.type === 'owl-panel-language')).toBe(false);
  });

  it('opens setup for a language that is not installed yet', () => {
    recording();
    press(el('lang'));
    press(el('menu').querySelector('.add'));
    expect(sent).toContainEqual({ type: 'owl-panel-add-language' });
  });

  it('closes when the page is pressed', () => {
    recording();
    press(el('lang'));
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
    expect(el('menu').hidden).toBe(true);
  });

  it('hides again when the session parks for setup', () => {
    recording();
    deliver({ type: 'owl-overlay-update', canSave: false, armed: true });
    expect(el('lang').hidden).toBe(true);
  });
});
