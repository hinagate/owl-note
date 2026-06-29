import { describe, it, expect, beforeEach } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import * as sw from '../src/background/service-worker.js';
import * as bm from '../src/lib/bookmarks.js';
import { createNote } from '../src/lib/note.js';
import { encode, decode } from '../src/lib/codec.js';
import { getBackup } from '../src/lib/mirror.js';

beforeEach(() => installFakeChrome());

describe('service worker handlers', () => {
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
});
