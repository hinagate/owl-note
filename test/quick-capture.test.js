// [feature] "Save selection to OWL-Note" quick capture: when the service worker writes
// the owl:quickCapture signal, an already-open app tab jumps to All notes (root) and
// refreshes so the just-saved note is on top — WITHOUT tearing down the editor (which
// would cancel a pending auto-save), and WITHOUT stealing a not-yet-saved draft's target
// notebook. Boots the real app over fake-chrome (same harness as app-integration) and
// drives the signal through chrome.storage.onChanged.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import { contentHash } from '../src/lib/note.js';

let app, bm, encode, decode;

beforeEach(async () => {
  installFakeChrome();
  document.body.innerHTML =
    '<div id="toolbar"></div><aside id="sidebar"></aside><section id="note-list"></section>'
    + '<main id="editor"></main><aside id="ask-panel" hidden></aside><div id="toast" hidden></div>';
  app = await import('../src/app/app.js');
  bm = await import('../src/lib/bookmarks.js');
  ({ encode, decode } = await import('../src/lib/codec.js'));
  app.resetUI();
  app.getAskIndex().build([]);
});

afterEach(async () => {
  try { app.resetUI(); } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 50));
});

const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));
const cardTitles = () => [...document.querySelectorAll('#note-list .item.card')].map((el) => el.textContent);
const folderRow = (name) => [...document.querySelectorAll('#sidebar .item.folder')]
  .find((x) => x.querySelector('.nb-label')?.textContent === name);

async function seedNote(folder, { id, title, body, created }) {
  const note = { id, title, body, version: 1, created, hash: contentHash(body) };
  return bm.createNote(folder, title, await encode(note));
}

// Root note r1 (newer) + subfolder 'Work' with note w1 (older). Root ("All notes") lists
// BOTH; the 'Work' subfolder lists only w1 — so a folder SWITCH is observable by count.
async function seedRootAndSub(root) {
  const sub = await bm.createNotebook(root, 'Work');
  await seedNote(root, { id: 'r1', title: 'Root note', body: 'at root', created: 2 });
  await seedNote(sub, { id: 'w1', title: 'Sub note', body: 'inside Work', created: 1 });
  return sub;
}

// Simulate the service worker's capture: create the note bookmark at root and write the
// signal (which fake-chrome dispatches via chrome.storage.onChanged).
async function fireQuickCapture(root, { id, title, body }) {
  await seedNote(root, { id, title, body, created: Date.now() + 1000 }); // newest
  await chrome.storage.local.set({ 'owl:quickCapture': { id, at: Date.now() + 1000 } });
}

async function folderNoteTitles(folderId) {
  const raw = await bm.listNotes(folderId);
  const out = [];
  for (const r of raw) { try { out.push((await decode(r.payload)).title); } catch { /* skip */ } }
  return out;
}

describe('quick capture — reveal at top of All notes', () => {
  it('switches from a subfolder to root, puts the capture on top, and preserves the open editor', async () => {
    const root = await bm.ensureRoot();
    const sub = await seedRootAndSub(root);
    await app.initUI(root);
    await settle();

    // Navigate into the subfolder and open the EXISTING sub note (not a new draft).
    folderRow('Work').click();
    await settle();
    [...document.querySelectorAll('#note-list .item.card')].find((c) => c.textContent.includes('Sub note')).click();
    await settle();
    const ta = document.querySelector('#editor textarea.note-body');
    ta.value = 'edited in place'; ta.dispatchEvent(new Event('input')); // a pending (debounced) edit

    await fireQuickCapture(root, { id: 'cap1', title: 'Captured selection', body: 'clipped text' });
    await settle();

    // Switched to root (only the reveal does this): capture is on TOP of all notes.
    expect(cardTitles()[0]).toContain('Captured selection');
    expect(cardTitles().some((t) => t.includes('Root note'))).toBe(true); // root shows the whole corpus
    // The editor was NOT torn down: same element, in-progress edit intact (auto-save survives).
    const taAfter = document.querySelector('#editor textarea.note-body');
    expect(taAfter).toBe(ta);
    expect(taAfter.value).toBe('edited in place');
  });

  it('does NOT switch folders while an unsaved new-note draft is open, so the draft keeps its notebook', async () => {
    const root = await bm.ensureRoot();
    const sub = await seedRootAndSub(root);
    await app.initUI(root);
    await settle();
    folderRow('Work').click();
    await settle();

    // Start a brand-new note IN the subfolder and type, without saving.
    document.querySelector('button.new').click();
    document.querySelector('#editor .note-title').value = 'Draft note';
    document.querySelector('#editor .note-title').dispatchEvent(new Event('input'));
    const ta = document.querySelector('#editor textarea.note-body');
    ta.value = 'draft body'; ta.dispatchEvent(new Event('input'));

    await fireQuickCapture(root, { id: 'cap2', title: 'Captured', body: 'x' });
    await settle();

    // The reveal must NOT have yanked us to root (that would retarget the draft's save).
    expect(cardTitles().some((t) => t.includes('Captured'))).toBe(false);
    expect(document.querySelector('#editor textarea.note-body')).toBe(ta); // draft editor intact

    // Save the draft: it must land in the subfolder we were composing in, not root.
    document.querySelector('#editor button.save').click();
    await settle();
    expect(await folderNoteTitles(sub)).toContain('Draft note');
    expect(await folderNoteTitles(root)).not.toContain('Draft note');
  });

  it('a key removal does not re-trigger a reveal (newValue-guarded)', async () => {
    const root = await bm.ensureRoot();
    await seedRootAndSub(root);
    await app.initUI(root);
    await settle();

    // A real capture switches us to root (2 cards: Root note + Sub note).
    await chrome.storage.local.set({ 'owl:quickCapture': { id: 'x', at: 1 } });
    await settle();
    expect(cardTitles().length).toBe(2);

    // Go back into the subfolder (1 card), then REMOVE the key — a change with only
    // oldValue. The guard must ignore it and leave us in the subfolder.
    folderRow('Work').click();
    await settle();
    expect(cardTitles().length).toBe(1);
    await chrome.storage.local.remove('owl:quickCapture');
    await settle();
    expect(cardTitles().length).toBe(1);              // still the subfolder…
    expect(cardTitles()[0]).toContain('Sub note');    // …not switched back to root (which had 2)
  });

  it('ignores unrelated storage changes (background writes must not yank the view)', async () => {
    const root = await bm.ensureRoot();
    await seedRootAndSub(root);
    await app.initUI(root);
    await settle();
    folderRow('Work').click();
    await settle();
    expect(cardTitles().length).toBe(1);

    // A non-capture storage write (e.g. the review counter) must NOT switch folders.
    await chrome.storage.local.set({ 'owl:saveCount': 3 });
    await settle();
    expect(cardTitles().length).toBe(1); // still in the subfolder
  });
});
