import { describe, it, expect, beforeEach } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import { decode } from '../src/lib/codec.js';

// The UI save/pin handlers are async (encode -> saveNote -> re-render) and can
// take longer than a fixed delay under parallel test load — which made this
// file flaky. Poll for the actual end-state (capped) instead of sleeping a
// fixed amount: same conditions, no race, and a clear failure if it never holds.
async function waitFor(predicate, timeout = 2000, step = 10) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { if (await predicate()) return; } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, step));
  }
}

beforeEach(async () => {
  installFakeChrome();
  document.body.innerHTML =
    '<div id="toolbar"></div><aside id="sidebar"></aside><section id="note-list"></section><main id="editor"></main><div id="toast" hidden></div>';
  const app = await import('../src/app/app.js');
  app.resetUI();
});

describe('pin + new-note-on-top', () => {
  it('a newly created note appears at the top of the list', async () => {
    const app = await import('../src/app/app.js');
    const bm = await import('../src/lib/bookmarks.js');
    const root = await bm.ensureRoot();
    // an older note, saved directly (NOT through the UI, so it is not "recent")
    await app.saveNote({ id: 'old', title: 'Older', body: 'o', attachments: [], version: 1, hash: 'h' }, root, undefined);
    await app.initUI(root);
    // create a new note through the UI
    document.querySelector('button.new').click();
    const title = document.querySelector('#editor .note-title');
    title.value = 'Fresh';
    title.dispatchEvent(new Event('input'));
    document.querySelector('#editor button.save').click();
    // wait until the save persisted + re-rendered: two saved (non-draft) cards,
    // the just-created "Fresh" floated to the top above the older one.
    await waitFor(() => {
      const cards = [...document.querySelectorAll('#note-list .item.card:not(.draft)')];
      return cards.length === 2 && cards[0].querySelector('.card-title')?.textContent.includes('Fresh');
    });
    expect(document.querySelector('#note-list .item.card:not(.draft) .card-title').textContent).toContain('Fresh');
  });

  it('clicking the pin persists pinned:true and floats the note to the top', async () => {
    const app = await import('../src/app/app.js');
    const bm = await import('../src/lib/bookmarks.js');
    const root = await bm.ensureRoot();
    await app.saveNote({ id: 'a', title: 'Alpha', body: 'aaa', attachments: [], version: 1, hash: 'h' }, root, undefined);
    await app.saveNote({ id: 'b', title: 'Bravo', body: 'bbb', attachments: [], version: 1, hash: 'h' }, root, undefined);
    await app.initUI(root);
    const bravo = [...document.querySelectorAll('#note-list .item.card')].find((c) => c.textContent.includes('Bravo'));
    bravo.querySelector('.pin').click();
    // wait until the pin took effect: Bravo re-rendered to the top (which the
    // save path reaches only AFTER updating the bookmark payload).
    await waitFor(() => document.querySelector('#note-list .item.card .card-title')?.textContent.includes('Bravo'));
    // Bravo's bookmark now decodes to pinned:true
    const raw = await bm.allNotes(root);
    const decoded = await Promise.all(raw.map((r) => decode(r.payload)));
    const bravoDecoded = decoded.find((d) => d.id === 'b');
    expect(bravoDecoded.pinned).toBe(true);
    expect('bookmarkId' in bravoDecoded).toBe(false); // device-local UI fields not baked into the synced payload
    expect('folderId' in bravoDecoded).toBe(false);
    // and Bravo is now the first card
    expect(document.querySelector('#note-list .item.card .card-title').textContent).toContain('Bravo');
  });

  it('pins a local-only (oversized) note: it stays local-only and gains pinned', async () => {
    const app = await import('../src/app/app.js');
    const bm = await import('../src/lib/bookmarks.js');
    const mirror = await import('../src/lib/mirror.js');
    const root = await bm.ensureRoot();
    await app.initUI(root);
    // create an oversized note (incompressible body) -> capped -> local-only
    document.querySelector('button.new').click();
    const bytes = new Uint8Array(62000);
    crypto.getRandomValues(bytes);
    let big = '';
    for (let i = 0; i < bytes.length; i++) big += String.fromCharCode(33 + (bytes[i] % 94));
    const ta = document.querySelector('#editor textarea.note-body');
    ta.value = big;
    ta.dispatchEvent(new Event('input'));
    document.querySelector('#editor button.save').click();
    // wait for the saved local-only card (a non-draft card has a pin button)
    await waitFor(() => !!document.querySelector('#note-list .item.card .pin'));
    // pin it via its card button
    document.querySelector('#note-list .item.card .pin').click();
    await waitFor(async () => {
      const locals = await mirror.allLocalOnly();
      return locals.length === 1 && locals[0].pinned === true;
    });
    const locals = await mirror.allLocalOnly();
    expect(locals).toHaveLength(1);
    expect(locals[0].pinned).toBe(true);
  });
});
