// Context-menu capture handoff: selection clips reveal the saved note in All notes
// without disrupting the editor, while full-page screenshots save pending edits and open
// the exact captured note. Covers both a live chrome.storage.onChanged handoff and the
// stored one-shot value consumed when a new app tab boots.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
async function fireQuickCapture(root, { id, title, body, openNote = false }) {
  await seedNote(root, { id, title, body, created: Date.now() + 1000 }); // newest
  await chrome.storage.local.set({ 'owl:quickCapture': { id, at: Date.now() + 1000, openNote } });
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

  it('opens the exact full-page capture and saves the note that was being edited first', async () => {
    const root = await bm.ensureRoot();
    await seedRootAndSub(root);
    await app.initUI(root);
    await settle();

    folderRow('Work').click();
    await settle();
    [...document.querySelectorAll('#note-list .item.card')].find((c) => c.textContent.includes('Sub note')).click();
    await settle();
    const oldBody = document.querySelector('#editor textarea.note-body');
    oldBody.value = 'saved before switching to the capture';
    oldBody.dispatchEvent(new Event('input'));

    await fireQuickCapture(root, {
      id: 'full1',
      title: 'Captured full page',
      body: '![Captured page](owl-img:image1)',
      openNote: true,
    });
    await settle(150);

    expect(document.querySelector('#editor .note-title').value).toBe('Captured full page');
    expect(document.querySelector('#editor textarea.note-body').value).toContain('owl-img:image1');
    expect(document.querySelector('#note-list .item.card.active .card-title-text').textContent).toBe('Captured full page');
    expect((await chrome.storage.local.get('owl:quickCapture'))['owl:quickCapture']).toBeUndefined();
    const workBodies = [];
    for (const raw of await bm.listNotes((await bm.listNotebooks(root)).find((n) => n.title === 'Work').id)) {
      workBodies.push((await decode(raw.payload)).body);
    }
    expect(workBodies).toContain('saved before switching to the capture');
  });

  it('opens a stored full-page capture on fresh app boot even when another note sorts first', async () => {
    const root = await bm.ensureRoot();
    await seedNote(root, { id: 'newer', title: 'Newer ordinary note', body: 'newer', created: 20 });
    await seedNote(root, { id: 'full2', title: 'Stored full-page capture', body: 'captured', created: 10 });
    await chrome.storage.local.set({
      'owl:quickCapture': { id: 'full2', at: Date.now() + 1000, openNote: true },
    });

    await app.initUI(root);
    await settle();

    expect(document.querySelector('#editor .note-title').value).toBe('Stored full-page capture');
    expect(document.querySelector('#note-list .item.card.active .card-title-text').textContent).toBe('Stored full-page capture');
    expect((await chrome.storage.local.get('owl:quickCapture'))['owl:quickCapture']).toBeUndefined();
  });

  it('consumes the one-shot key without re-triggering a reveal on its removal', async () => {
    const root = await bm.ensureRoot();
    await seedRootAndSub(root);
    await app.initUI(root);
    await settle();

    // A real capture switches us to root (2 cards: Root note + Sub note).
    await chrome.storage.local.set({ 'owl:quickCapture': { id: 'x', at: 1 } });
    await settle();
    expect(cardTitles().length).toBe(2);
    expect((await chrome.storage.local.get('owl:quickCapture'))['owl:quickCapture']).toBeUndefined();

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

describe('a full-page capture lands in the photo editor', () => {
  const realGetContext = HTMLCanvasElement.prototype.getContext;
  beforeEach(() => { HTMLCanvasElement.prototype.getContext = () => null; }); // jsdom draws nothing
  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = realGetContext;
    document.querySelector('.draw-backdrop')?.remove();
    history.replaceState(null, '', '/');
  });

  // The worker's note: a screenshot attachment and a reference to it.
  async function seedCapture(root, id) {
    const attachments = [{ id: 'shot1', name: 'Page.jpg', mime: 'image/jpeg', dataUri: 'data:image/jpeg;base64,AQID' }];
    const body = '![Page](owl-img:shot1)';
    const note = { id, title: 'Captured page', body, attachments, version: 1, created: Date.now(), hash: contentHash(body) };
    await bm.createNote(root, note.title, await encode(note));
  }
  const signal = (id, at = Date.now()) => chrome.storage.local.set({
    'owl:quickCapture': { id, at, openNote: true, editImage: 'shot1' },
  });

  it('opens a fresh capture straight in Edit photo, on its screenshot', async () => {
    const root = await bm.ensureRoot();
    await seedNote(root, { id: 'r1', title: 'Root note', body: 'at root', created: 2 });
    await app.initUI(root);
    await settle();
    await seedCapture(root, 'cap1');
    await signal('cap1');

    await vi.waitFor(() => expect(document.querySelector('.draw-dialog.draw-photo-mode')).toBeTruthy());
    expect(document.querySelector('#editor .note-title').value).toBe('Captured page');
    expect(document.querySelector('.draw-photo, .draw-status')).toBeTruthy();
  });

  // Giving up on an edit of a capture may mean giving up on the capture: Discard
  // then comes with "Delete note too". jsdom loads no images, and the panel takes no
  // marks until its photo has a size, so Image is stood in for here.
  describe('discarding changes to the capture', () => {
    const pointer = (el, type, x, y) => {
      const ev = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
      Object.defineProperty(ev, 'pointerId', { value: 1, configurable: true });
      el.dispatchEvent(ev);
    };
    const click = (selector) => document.querySelector(selector).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // Opening a capture and trashing a note each cross several saves and a repaint:
    // well inside a second alone, not always beside the rest of the suite.
    const SLOW = { timeout: 5000 };
    let confirm;
    beforeEach(() => {
      vi.stubGlobal('Image', class {
        set src(value) { this.naturalWidth = 800; this.naturalHeight = 600; setTimeout(() => this.onload?.(), 0); }
      });
      confirm = vi.spyOn(window, 'confirm').mockReturnValue(false); // it would say no, if it were asked
    });
    afterEach(() => { confirm.mockRestore(); vi.unstubAllGlobals(); });

    // A capture, open in the editor, with one pen mark on it and Cancel pressed.
    async function captureMarkedAndCancelled(id) {
      const root = await bm.ensureRoot();
      await seedNote(root, { id: 'r1', title: 'Root note', body: 'at root', created: 2 });
      await app.initUI(root);
      await settle();
      await seedCapture(root, id);
      await signal(id);
      await vi.waitFor(() => expect(document.querySelector('.draw-zoom-in')?.disabled).toBe(false), SLOW);
      const canvas = document.querySelector('.draw-canvas');
      pointer(canvas, 'pointerdown', 400, 300);
      pointer(canvas, 'pointermove', 430, 320);
      pointer(canvas, 'pointerup', 430, 320);
      click('.draw-cancel');
      expect(document.querySelector('.draw-confirm').hidden).toBe(false);
      return root;
    }

    it('"Delete note too" moves the captured note to Trash, without asking a second time', async () => {
      const root = await captureMarkedAndCancelled('cap4');
      click('.draw-delete-note');
      await vi.waitFor(() => expect(document.getElementById('toast').textContent).toBe('Moved to Trash'), SLOW);
      expect(confirm).not.toHaveBeenCalled();
      expect(document.querySelector('.draw-backdrop')).toBeNull();
      expect((await app.loadNotes(root)).map((n) => n.id)).toEqual(['r1']);
      expect(document.querySelector('#editor .note-title')?.value).not.toBe('Captured page');
    });

    // Cancel straight after a capture, nothing touched: it still asks about the note.
    async function captureCancelledUntouched(id) {
      const root = await bm.ensureRoot();
      await seedNote(root, { id: 'r1', title: 'Root note', body: 'at root', created: 2 });
      await app.initUI(root);
      await settle();
      await seedCapture(root, id);
      await signal(id);
      await vi.waitFor(() => expect(document.querySelector('.draw-zoom-in')?.disabled).toBe(false), SLOW);
      click('.draw-cancel');
      expect(document.querySelector('.draw-confirm span').textContent).toBe('Keep the captured note?');
      return root;
    }

    it('Cancel with nothing changed asks, and "Delete note" moves the capture to Trash', async () => {
      const root = await captureCancelledUntouched('cap6');
      click('.draw-delete-note');
      await vi.waitFor(() => expect(document.getElementById('toast').textContent).toBe('Moved to Trash'), SLOW);
      expect(confirm).not.toHaveBeenCalled();
      expect(document.querySelector('.draw-backdrop')).toBeNull();
      expect((await app.loadNotes(root)).map((n) => n.id)).toEqual(['r1']);
    });

    it('Cancel with nothing changed asks, and "Keep note" keeps the capture', async () => {
      const root = await captureCancelledUntouched('cap7');
      click('.draw-keep-note');
      await settle(100);
      expect(document.querySelector('.draw-backdrop')).toBeNull();
      expect((await app.loadNotes(root)).map((n) => n.id).sort()).toEqual(['cap7', 'r1']);
      expect(document.querySelector('#editor .note-title').value).toBe('Captured page');
    });

    it('"Discard" keeps the captured note as it was', async () => {
      const root = await captureMarkedAndCancelled('cap5');
      click('.draw-discard');
      await settle(100);
      expect(document.querySelector('.draw-backdrop')).toBeNull();
      expect((await app.loadNotes(root)).map((n) => n.id).sort()).toEqual(['cap5', 'r1']);
      expect(document.querySelector('#editor .note-title').value).toBe('Captured page');
      expect(document.querySelector('textarea.note-body').value).toContain('owl-img:shot1');
    });
  });

  it('opens a stale capture (left for a later boot) without springing the editor', async () => {
    const root = await bm.ensureRoot();
    await seedCapture(root, 'cap2');
    await signal('cap2', Date.now() - 10 * 60 * 1000);
    await app.initUI(root);

    await vi.waitFor(() => expect(document.querySelector('#editor .note-title').value).toBe('Captured page'));
    await settle(100); // the editor would open right after the note
    expect(document.querySelector('.draw-backdrop')).toBeNull();
  });

  it('a note open in its own tab stays on its note', async () => {
    const root = await bm.ensureRoot();
    await seedNote(root, { id: 'r1', title: 'Root note', body: 'at root', created: 2 });
    history.replaceState(null, '', '/app.html?note=r1');
    await app.initUI(root);
    await settle();
    expect(document.querySelector('#editor .note-title').value).toBe('Root note');

    await seedCapture(root, 'cap3');
    await signal('cap3');
    await settle(150);

    expect(document.querySelector('#editor .note-title').value).toBe('Root note');
    expect(document.querySelector('.draw-backdrop')).toBeNull();
    // The signal is left for the main tab to consume.
    expect((await chrome.storage.local.get('owl:quickCapture'))['owl:quickCapture']).toBeTruthy();
  });
});
