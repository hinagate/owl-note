// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import * as bm from '../src/lib/bookmarks.js';
import { decode } from '../src/lib/codec.js';
import { createNote } from '../src/lib/note.js';
import { saveNote, MAX_URL_BYTES } from '../src/lib/save-note.js';

beforeEach(() => installFakeChrome());

describe('saveNote (lib)', () => {
  it('saves a small note as a synced bookmark', async () => {
    const root = await bm.ensureRoot();
    const note = createNote({ title: 'Hi', body: 'short body' });
    const res = await saveNote(note, root, undefined);
    expect(res.status).toBe('ok');
    expect(res.bookmarkId).toBeTruthy();
    const notes = await bm.allNotes(root);
    expect(notes).toHaveLength(1);
    expect((await decode(notes[0].payload)).body).toBe('short body');
  });
  it('exports the cap constant', () => { expect(MAX_URL_BYTES).toBe(65536); });
});
