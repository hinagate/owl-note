// [Task E16] Integration tests for the gentle, one-time, policy-safe in-app review
// ask. Boots the real app over fake-chrome (same harness as app-integration /
// ask-index-lifecycle) and drives the two VALUE-moment triggers:
//   (a) the 20th successful save (counter owl:saveCount), and
//   (b) the first Ask answer that actually ran the on-device model (usedModel:true).
// Proves: exact-threshold appearance, the flag set on show, both dismissal buttons,
// once-EVER persistence across a reboot, and zero interference by default.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import { installFakeLanguageModel } from './helpers/fake-language-model.js';
import { contentHash } from '../src/lib/note.js';

const STORE_URL = 'https://chromewebstore.google.com/detail/hjkbpgkmiaeojfhkpnhmokgjipenhcfl/reviews';

let app, bm, encode;

beforeEach(async () => {
  installFakeChrome();
  document.body.innerHTML =
    '<div id="toolbar"></div><aside id="sidebar"></aside><section id="note-list"></section>'
    + '<main id="editor"></main><aside id="ask-panel" hidden></aside><div id="toast" hidden></div>';
  app = await import('../src/app/app.js');
  bm = await import('../src/lib/bookmarks.js');
  ({ encode } = await import('../src/lib/codec.js'));
  app.resetUI();
  app.getAskIndex().build([]); // the index is a module-level singleton — clear it between tests
});

afterEach(async () => {
  try { app.resetUI(); } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 50)); // drain in-flight save/refresh against THIS fake-chrome
});

const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));

async function seedNote(folder, { id, title, body }) {
  const note = { id, title, body, version: 1, hash: contentHash(body) };
  const bookmarkId = await bm.createNote(folder, title, await encode(note));
  return { note, bookmarkId };
}

// New note -> type -> manual save, exactly as a user would. Each call is ONE save.
function saveNewNote({ title = 'Note', body = 'content' } = {}) {
  document.querySelector('button.new').click();
  const t = document.querySelector('#editor .note-title');
  t.value = title; t.dispatchEvent(new Event('input'));
  const ta = document.querySelector('#editor textarea.note-body');
  ta.value = body; ta.dispatchEvent(new Event('input'));
  document.querySelector('#editor button.save').click();
}

describe('review ask — save-threshold trigger', () => {
  it('is absent on a normal boot with no value moment yet', async () => {
    const root = await bm.ensureRoot();
    await app.initUI(root);
    await settle();
    expect(document.getElementById('review-banner')).toBeNull();
  });

  it('counts saves and shows the banner exactly at the 20th save, latching owl:reviewAsked', async () => {
    const root = await bm.ensureRoot();
    await chrome.storage.local.set({ 'owl:saveCount': 19 }); // one below the threshold
    await app.initUI(root);
    expect(document.getElementById('review-banner')).toBeNull(); // 19 so far — not yet

    saveNewNote({ title: 'Twenty', body: 'the twentieth note' });
    await settle();

    expect((await chrome.storage.local.get('owl:saveCount'))['owl:saveCount']).toBe(20); // counter incremented
    const banner = document.getElementById('review-banner');
    expect(banner).not.toBeNull(); // shown EXACTLY at the 20th save
    expect(banner.textContent).toContain('rating helps');
    expect(banner.querySelector('.review-rate')).not.toBeNull();
    expect(banner.querySelector('.review-dismiss')).not.toBeNull();
    expect((await chrome.storage.local.get('owl:reviewAsked'))['owl:reviewAsked']).toBe(true); // flag set on show
  });

  it('does not show below the threshold, but still increments the counter', async () => {
    const root = await bm.ensureRoot();
    await chrome.storage.local.set({ 'owl:saveCount': 5 });
    await app.initUI(root);
    saveNewNote({ title: 'Six', body: 'sixth' });
    await settle();
    expect((await chrome.storage.local.get('owl:saveCount'))['owl:saveCount']).toBe(6);
    expect(document.getElementById('review-banner')).toBeNull();
  });

  it('once dismissed, never reappears after a reboot even when the threshold is re-crossed', async () => {
    const root = await bm.ensureRoot();
    await chrome.storage.local.set({ 'owl:saveCount': 19 });
    await app.initUI(root);
    saveNewNote({ title: 'Twenty', body: 'x' });
    await settle();
    const banner = document.getElementById('review-banner');
    expect(banner).not.toBeNull();
    banner.querySelector('.review-close').click(); // dismiss via the ✕
    await settle();
    expect(document.getElementById('review-banner')).toBeNull();
    expect((await chrome.storage.local.get('owl:reviewAsked'))['owl:reviewAsked']).toBe(true);

    // Reboot: fresh in-memory state, SAME persisted storage (the flag survives).
    app.resetUI();
    await app.initUI(root);
    saveNewNote({ title: 'More', body: 'y' }); // re-cross the threshold
    await settle();
    expect(document.getElementById('review-banner')).toBeNull(); // stays gone forever
    // Counting stopped once flagged — no unbounded storage churn.
    expect((await chrome.storage.local.get('owl:saveCount'))['owl:saveCount']).toBe(20);
  });
});

describe('review ask — dismissal buttons', () => {
  async function showBanner(root) {
    await chrome.storage.local.set({ 'owl:saveCount': 19 });
    await app.initUI(root);
    saveNewNote({ title: 'Twenty', body: 'x' });
    await settle();
    return document.getElementById('review-banner');
  }

  it('[Rate it] opens the Chrome Web Store review page in a new tab, then dismisses + sets the flag', async () => {
    const root = await bm.ensureRoot();
    const banner = await showBanner(root);
    expect(banner).not.toBeNull();
    const opened = [];
    const origOpen = window.open;
    window.open = (url) => { opened.push(url); return null; };
    try {
      banner.querySelector('.review-rate').click();
    } finally {
      window.open = origOpen;
    }
    await settle();
    expect(opened).toEqual([STORE_URL]); // exact const store URL
    expect(document.getElementById('review-banner')).toBeNull(); // dismissed
    expect((await chrome.storage.local.get('owl:reviewAsked'))['owl:reviewAsked']).toBe(true);
  });

  it('[No thanks] dismisses and permanently suppresses the ask', async () => {
    const root = await bm.ensureRoot();
    const banner = await showBanner(root);
    banner.querySelector('.review-dismiss').click();
    await settle();
    expect(document.getElementById('review-banner')).toBeNull();
    expect((await chrome.storage.local.get('owl:reviewAsked'))['owl:reviewAsked']).toBe(true);
  });
});

// Trigger (b): the first Ask answer that actually ran the on-device model. Installs
// the fake Prompt API global so the REAL registry/builtin provider answers, then
// UNINSTALLS it (a leaked global would corrupt other suites).
describe('review ask — Ask-success trigger', () => {
  let lm = null;
  afterEach(() => { if (lm) { lm.uninstall(); lm = null; } });

  it('shows the banner on the first Ask answer that used the on-device model', async () => {
    lm = installFakeLanguageModel({ availability: 'available' });
    const root = await bm.ensureRoot();
    await seedNote(root, { id: 'c1', title: 'Coffee', body: 'Tamp the grounds evenly before pulling a shot of espresso.' });
    await app.initUI(root);
    await app.rebuildAskIndex(); // deterministic corpus (don't race the floating boot build)

    expect(document.getElementById('review-banner')).toBeNull(); // nothing before the ask
    [...document.querySelectorAll('#toolbar button')].find((b) => b.textContent === '🦉 Ask Owl').click();
    document.querySelector('#ask-panel .ask-input').value = 'espresso';
    document.querySelector('#ask-panel .ask-submit').click();
    await settle();

    expect(document.querySelector('#ask-panel .ask-answer')).not.toBeNull(); // the model answered (usedModel:true)
    expect(document.getElementById('review-banner')).not.toBeNull(); // the value moment -> review ask
    expect((await chrome.storage.local.get('owl:reviewAsked'))['owl:reviewAsked']).toBe(true);
  });

  it('a retrieval-only ask (no model) does NOT trigger the review ask', async () => {
    // No fake LM installed -> provider unavailable -> snippets, usedModel never true.
    const root = await bm.ensureRoot();
    await seedNote(root, { id: 'c1', title: 'Coffee', body: 'Tamp the grounds evenly before pulling a shot of espresso.' });
    await app.initUI(root);
    await app.rebuildAskIndex();

    [...document.querySelectorAll('#toolbar button')].find((b) => b.textContent === '🦉 Ask Owl').click();
    document.querySelector('#ask-panel .ask-input').value = 'espresso';
    document.querySelector('#ask-panel .ask-submit').click();
    await settle();

    expect(document.querySelector('#ask-panel .ask-note')).not.toBeNull(); // retrieval-only snippet
    expect(document.getElementById('review-banner')).toBeNull(); // no model -> no value moment -> no ask
  });
});
