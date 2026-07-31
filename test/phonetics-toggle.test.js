// End-to-end wiring for the phonetics reader: the toolbar toggle, the lazy dictionary
// fetch, the ruby annotations in the preview, and the persisted per-reader preference.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { gzipSync } from 'node:zlib';
import { installFakeChrome } from './helpers/fake-chrome.js';
import { resetIpaTable } from '../src/lib/phonetics.js';

const TABLE = "phonics\tˈfɑnɪks\nis\tɪz\nuseful\tˈjusfəl\n";

let fetches;

beforeEach(async () => {
  installFakeChrome();
  resetIpaTable();
  fetches = [];
  globalThis.fetch = async (url) => {
    fetches.push(String(url));
    return new Response(gzipSync(Buffer.from(TABLE, 'utf8')));
  };
  document.body.innerHTML =
    '<div id="toolbar"></div><aside id="sidebar"></aside><section id="note-list"></section><main id="editor"></main><div id="toast" hidden></div>';
  const app = await import('../src/app/app.js');
  app.resetUI();
});

afterEach(async () => {
  try { const app = await import('../src/app/app.js'); app.resetUI(); } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 50));
});

async function waitFor(fn, ms = 1500) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('waitFor: condition not met in time');
}

async function openNoteWithBody(text) {
  const app = await import('../src/app/app.js');
  const bm = await import('../src/lib/bookmarks.js');
  await app.initUI(await bm.ensureRoot());
  document.querySelector('button.new').click();
  const ta = document.querySelector('#editor textarea.note-body');
  ta.value = text;
  ta.dispatchEvent(new Event('input'));
  return app;
}

const toggleBtn = () => document.querySelector('#editor .phonetics-toggle');
const rubies = () => [...document.querySelectorAll('#editor .preview-content ruby')];

describe('phonetics reader', () => {
  it('is off by default and fetches nothing', async () => {
    await openNoteWithBody('Phonics is useful');

    expect(toggleBtn()).toBeTruthy();
    expect(toggleBtn().classList.contains('on')).toBe(false);
    expect(rubies()).toHaveLength(0);
    expect(fetches).toEqual([]); // the 800 KB table is not downloaded until asked for
  });

  it('annotates every known word in the preview once turned on', async () => {
    await openNoteWithBody('Phonics is useful');
    toggleBtn().click();
    await waitFor(() => rubies().length > 0);

    expect(rubies().map((r) => r.querySelector('rt').textContent))
      .toEqual(['ˈfɑnɪks', 'ɪz', 'ˈjusfəl']);
    expect(toggleBtn().classList.contains('on')).toBe(true);
    expect(document.querySelector('#editor .preview-content').classList.contains('phonetics')).toBe(true);
  });

  it('never changes the note text itself', async () => {
    await openNoteWithBody('Phonics is useful');
    toggleBtn().click();
    await waitFor(() => rubies().length > 0);

    expect(document.querySelector('#editor textarea.note-body').value).toBe('Phonics is useful');
  });

  it('downloads the dictionary once, however often it is toggled', async () => {
    await openNoteWithBody('Phonics is useful');
    toggleBtn().click();
    await waitFor(() => rubies().length > 0);
    toggleBtn().click();
    await waitFor(() => rubies().length === 0);
    toggleBtn().click();
    await waitFor(() => rubies().length > 0);

    expect(fetches).toHaveLength(1);
  });

  it('remembers the choice across sessions and re-annotates on boot', async () => {
    await openNoteWithBody('Phonics is useful');
    toggleBtn().click();
    await waitFor(() => rubies().length > 0);
    expect((await chrome.storage.local.get('owl:phonetics'))['owl:phonetics']).toBe(true);

    // Fresh session: same stored preference, new module state.
    const app = await import('../src/app/app.js');
    app.resetUI();
    resetIpaTable();
    await openNoteWithBody('Phonics is useful');
    await waitFor(() => rubies().length > 0);
    expect(toggleBtn().classList.contains('on')).toBe(true);
  });

  it('stays off and says so when the dictionary cannot be fetched', async () => {
    globalThis.fetch = async () => new Response('', { status: 404 });
    await openNoteWithBody('Phonics is useful');
    toggleBtn().click();
    await waitFor(() => document.getElementById('toast').hidden === false);

    expect(document.getElementById('toast').textContent).toContain('pronunciation dictionary');
    expect(toggleBtn().classList.contains('on')).toBe(false);
    expect(rubies()).toHaveLength(0);
    expect((await chrome.storage.local.get('owl:phonetics'))['owl:phonetics']).toBeUndefined();
  });

  it('leaves code spans unannotated', async () => {
    await openNoteWithBody('Phonics is `useful`');
    toggleBtn().click();
    await waitFor(() => rubies().length > 0);

    expect(document.querySelector('#editor .preview-content code').textContent).toBe('useful');
    expect(rubies().map((r) => r.querySelector('rt').textContent)).toEqual(['ˈfɑnɪks', 'ɪz']);
  });
});
