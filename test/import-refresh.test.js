// Import must never finish silently: whatever happens, the user gets a toast and
// the panes re-render. Drives the REAL toolbar file-input path (onImport ->
// doImportFiles) over fake-chrome — the same wiring production uses — because the
// original report ("import did not refresh the notebook list and note list") is
// only reproducible when a failure escapes that fire-and-forget path uncaught.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';

let app, bm;

beforeEach(async () => {
  installFakeChrome();
  document.body.innerHTML =
    '<div id="toolbar"></div><aside id="sidebar"></aside><section id="note-list"></section>'
    + '<main id="editor"></main><aside id="ask-panel" hidden></aside><div id="toast" hidden></div>';
  app = await import('../src/app/app.js');
  bm = await import('../src/lib/bookmarks.js');
  app.resetUI();
});

afterEach(async () => {
  try { app.resetUI(); } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 50));
});

const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 1500) {
  const start = Date.now();
  while (Date.now() - start < ms) { if (await fn()) return; await settle(5); }
  throw new Error('waitFor: condition not met in time');
}

const jsonFile = (name, obj) => ({
  name,
  text: async () => JSON.stringify(obj),
  arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(obj)).buffer,
});

function dispatchImport(files) {
  const input = document.querySelector('#toolbar input[type="file"]');
  expect(input).not.toBeNull();
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

const cardTitles = () => [...document.querySelectorAll('#note-list .item.card')].map((el) => el.textContent);
const toastText = () => document.getElementById('toast').textContent;

describe('import — refresh and feedback', () => {
  it('a JSON import shows the new notes in the list without any manual action', async () => {
    const root = await bm.ensureRoot();
    await app.initUI(root);
    await settle(); // let welcome-note/boot tasks land

    const before = cardTitles().length;
    dispatchImport([jsonFile('two-notes.json', { version: 1, notes: [
      { id: 'imp1', title: 'Imported Alpha', body: 'alpha body', attachments: [], version: 1, hash: 'h1' },
      { id: 'imp2', title: 'Imported Beta', body: 'beta body', attachments: [], version: 1, hash: 'h2' },
    ] })]);

    await waitFor(() => cardTitles().some((t) => t.includes('Imported Beta')));
    const titles = cardTitles();
    expect(titles.some((t) => t.includes('Imported Alpha'))).toBe(true);
    expect(titles.length).toBeGreaterThan(before);
    expect(toastText()).toContain('Imported: 2 new');
  });

  it('an unreadable file still ends with a summary toast (counted as skipped), not silence', async () => {
    const root = await bm.ensureRoot();
    await app.initUI(root);
    await settle();

    dispatchImport([{ name: 'bad.json', text: async () => { throw new Error('disk read failed'); } }]);
    await waitFor(() => toastText().includes('skipped'));
    expect(toastText()).toContain('1 skipped');
  });

  it('a hard failure before any file is read shows an error toast and still refreshes the panes', async () => {
    const root = await bm.ensureRoot();
    await app.initUI(root);
    await settle();
    const before = cardTitles().length;

    // Kill the FIRST bookmarks read after dispatch: importFiles' pre-loop dedup scan
    // (buildIdMap -> allNotes -> getChildren) throws before the per-file try/catch
    // can help — exactly the spot that used to escape doImportFiles uncaught.
    const real = chrome.bookmarks.getChildren;
    let killed = false;
    chrome.bookmarks.getChildren = async (...a) => {
      if (!killed) { killed = true; chrome.bookmarks.getChildren = real; throw new Error('bookmarks API hiccup'); }
      return real(...a);
    };

    dispatchImport([jsonFile('never-read.json', { version: 1, notes: [
      { id: 'imp3', title: 'Never Imported', body: 'x', attachments: [], version: 1, hash: 'h3' },
    ] })]);

    await waitFor(() => toastText().includes('Import failed'));
    expect(killed).toBe(true);
    await settle(); // post-failure refresh chain (API restored) must complete cleanly
    expect(cardTitles().length).toBe(before);                       // nothing landed…
    expect(cardTitles().some((t) => t.includes('Never Imported'))).toBe(false);
    expect(document.querySelectorAll('#note-list .item.card').length).toBe(before); // …and the pane re-rendered
  });
});
