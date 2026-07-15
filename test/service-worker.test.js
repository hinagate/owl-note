import { describe, it, expect, beforeEach } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import * as sw from '../src/background/service-worker.js';
import * as bm from '../src/lib/bookmarks.js';
import { createNote } from '../src/lib/note.js';
import { encode, decode } from '../src/lib/codec.js';
import { getBackup } from '../src/lib/mirror.js';

beforeEach(() => installFakeChrome());

describe('service worker handlers', () => {
  it('the extension icon focuses an existing OWL-Note tab instead of opening a duplicate', async () => {
    const base = chrome.runtime.getURL('app.html');
    chrome.runtime.getContexts = async () => [{ contextType: 'TAB', tabId: 8, windowId: 2, documentUrl: `${base}#note` }];
    const updated = []; const created = [];
    chrome.tabs.update = async (id, opts) => { updated.push([id, opts]); };
    chrome.tabs.create = async (opts) => { created.push(opts); };
    await sw.handleActionClick();
    expect(updated).toEqual([[8, { active: true }]]);
    expect(created).toEqual([]);
  });

  it('a plain desktop-shortcut launch focuses the older app tab and closes only the duplicate', async () => {
    const base = chrome.runtime.getURL('app.html');
    chrome.runtime.getContexts = async () => [
      { contextType: 'TAB', tabId: 7, windowId: 2, documentUrl: `${base}#open-note` },
      { contextType: 'TAB', tabId: 99, windowId: 5, documentUrl: base },
    ];
    const updated = []; const removed = [];
    chrome.tabs.update = async (id, opts) => { updated.push([id, opts]); };
    chrome.tabs.remove = async (id) => { removed.push(id); };
    let response = null;
    expect(sw.handleRuntimeMessage({ type: 'owl-app-opened' }, { tab: { id: 99 } }, (value) => { response = value; })).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(response).toEqual({ reused: true });
    expect(updated).toEqual([[7, { active: true }]]);
    expect(removed).toEqual([99]);
  });

  it('reuses a registered app tab when runtime.getContexts is unavailable', async () => {
    chrome.runtime.getContexts = undefined; // Chrome < 116 / browser without the API
    const updated = []; const created = [];
    chrome.tabs.update = async (id, opts) => { updated.push([id, opts]); };
    chrome.tabs.create = async (opts) => { created.push(opts); };

    let registered = null;
    sw.handleRuntimeMessage(
      { type: 'owl-app-opened', dedupe: false, tabId: 41, windowId: 6 },
      {},
      (value) => { registered = value; },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(registered).toEqual({ reused: false });

    await sw.handleActionClick();
    expect(updated).toEqual([[41, { active: true }]]);
    expect(created).toEqual([]);
  });

  it('handleInstalled creates the Notes root', async () => {
    await sw.handleInstalled();
    const children = await chrome.bookmarks.getChildren('2');
    expect(children.some((c) => c.title === '📓 Notes')).toBe(true);
  });

  it('mirrors a note when its bookmark changes', async () => {
    const root = await bm.ensureRoot();
    const note = createNote({ body: 'hello' });
    const id = await bm.createNote(root, note.title, await encode(note));
    await sw.handleBookmarkChanged(id, { url: bm.buildNoteUrl(await encode(note)) });
    const backup = await getBackup(note.id);
    expect(backup.current.body).toBe('hello');
  });

  it('handleSaveSelection saves the selected text + a source link as a note in root', async () => {
    const root = await bm.ensureRoot();
    await sw.handleSaveSelection(
      { menuItemId: 'owl-save-selection', selectionText: 'LLM output here', pageUrl: 'https://chat.example/c/1' },
      { title: 'A Chat', url: 'https://chat.example/c/1' },
    );
    const notes = await bm.allNotes(root);
    expect(notes.length).toBe(1);
    const note = await decode(notes[0].payload);
    expect(note.body).toContain('LLM output here');
    expect(note.body).toContain('[A Chat](https://chat.example/c/1)');
  });

  it('ignores other menu items and empty selections', async () => {
    const root = await bm.ensureRoot();
    await sw.handleSaveSelection({ menuItemId: 'something-else', selectionText: 'x', pageUrl: 'https://e/' }, {});
    await sw.handleSaveSelection({ menuItemId: 'owl-save-selection', selectionText: '   ', pageUrl: 'https://e/' }, {});
    expect((await bm.allNotes(root)).length).toBe(0);
  });

  it('writes a quick-capture signal carrying the saved note id so an open app tab can reveal it', async () => {
    const root = await bm.ensureRoot();
    await sw.handleSaveSelection(
      { menuItemId: 'owl-save-selection', selectionText: 'capture me', pageUrl: 'https://e/' },
      { title: 'E', url: 'https://e/' },
    );
    const saved = await decode((await bm.allNotes(root))[0].payload);
    const sig = (await chrome.storage.local.get('owl:quickCapture'))['owl:quickCapture'];
    expect(sig).toBeTruthy();
    expect(sig.id).toBe(saved.id);       // the exact note just created
    expect(typeof sig.at).toBe('number'); // timestamp so repeated captures always change the value
  });

  // Mock getContexts the way REAL chrome behaves: when a documentUrls filter is passed it
  // exact-matches the full document URL (fragment included). So if the SW ever regressed to
  // documentUrls:[app.html], a note-showing tab (app.html#hash) would be filtered out here —
  // failing the #fragment test below. This locks in BOTH halves of the fix (drop the filter
  // AND prefix-match), not just the match logic.
  const fakeContexts = (list) => async (filter) => (filter && filter.documentUrls)
    ? list.filter((c) => filter.documentUrls.includes(c.documentUrl))
    : list;

  it('focuses an already-open OWL-Note tab (permission-free) instead of opening a new one', async () => {
    await bm.ensureRoot();
    let seenFilter = null;
    const base = chrome.runtime.getURL('app.html');
    chrome.runtime.getContexts = async (filter) => {
      seenFilter = filter;
      return fakeContexts([{ contextType: 'TAB', tabId: 7, windowId: 3, documentUrl: base }])(filter);
    };
    const updated = []; const focused = []; const created = [];
    chrome.tabs.update = async (id, o) => { updated.push([id, o]); };
    chrome.tabs.create = async (o) => { created.push(o); return {}; };
    chrome.windows.update = async (id, o) => { focused.push([id, o]); };

    await sw.handleSaveSelection({ menuItemId: 'owl-save-selection', selectionText: 'hi', pageUrl: 'https://e/' }, {});

    expect(seenFilter.contextTypes).toEqual(['TAB']);
    expect(seenFilter.documentUrls).toBeUndefined();    // must NOT exact-filter (fragments would be missed)
    expect(updated).toEqual([[7, { active: true }]]);   // activate the existing tab
    expect(focused).toEqual([[3, { focused: true }]]);  // and bring its window forward
    expect(created).toEqual([]);                         // did NOT spawn a duplicate tab
  });

  it('focuses a tab that is showing a note (app.html#<hash>), not a duplicate', async () => {
    // The common case: the open app tab deep-links a note, so its URL carries a #fragment.
    // With the realistic getContexts mock, an exact documentUrls:[app.html] filter would
    // exclude this tab -> a new tab would be created -> this test fails. So it guards both
    // the "no exact filter" and the "prefix-match" halves of the fix.
    await bm.ensureRoot();
    chrome.runtime.getContexts = fakeContexts([
      { contextType: 'TAB', tabId: 12, windowId: 4, documentUrl: `${chrome.runtime.getURL('app.html')}#eyJpZCI6ImFiYyJ9` },
    ]);
    const updated = []; const created = [];
    chrome.tabs.update = async (id, o) => { updated.push([id, o]); };
    chrome.tabs.create = async (o) => { created.push(o); return {}; };

    await sw.handleSaveSelection({ menuItemId: 'owl-save-selection', selectionText: 'hi', pageUrl: 'https://e/' }, {});

    expect(updated).toEqual([[12, { active: true }]]); // focused the note-showing tab
    expect(created).toEqual([]);                        // and did NOT open a duplicate
  });

  it('opens a new app tab when none is open', async () => {
    await bm.ensureRoot();
    chrome.runtime.getContexts = async () => [];
    const updated = []; const created = [];
    chrome.tabs.update = async (id, o) => { updated.push([id, o]); };
    chrome.tabs.create = async (o) => { created.push(o); return {}; };

    await sw.handleSaveSelection({ menuItemId: 'owl-save-selection', selectionText: 'hi', pageUrl: 'https://e/' }, {});

    expect(created).toEqual([{ url: 'app.html' }]);
    expect(updated).toEqual([]);
  });

  it('falls back to opening a tab if getContexts is unavailable/throws', async () => {
    await bm.ensureRoot();
    chrome.runtime.getContexts = async () => { throw new Error('unsupported'); };
    const created = [];
    chrome.tabs.create = async (o) => { created.push(o); return {}; };

    await sw.handleSaveSelection({ menuItemId: 'owl-save-selection', selectionText: 'hi', pageUrl: 'https://e/' }, {});

    expect(created).toEqual([{ url: 'app.html' }]);
  });
});
