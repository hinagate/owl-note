import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import * as bm from '../src/lib/bookmarks.js';
import * as gc from '../src/lib/drive-gc.js';
import { createNote } from '../src/lib/note.js';
import { saveNote, CLEANUP_WAIT_MS } from '../src/lib/save-note.js';

// Cleanup left over from earlier saves can mean any number of Drive downloads. It must
// not hold a finished save open: in the service worker that kept a capture "saving"
// long after its note existed, and past the keep-alive ceiling reported it as failed.
vi.mock('../src/lib/drive-gc.js', async (importOriginal) => ({
  ...(await importOriginal()),
  deleteUnreferencedFiles: vi.fn(() => new Promise(() => {})),
}));

beforeEach(() => { installFakeChrome(); });
afterEach(() => { vi.useRealTimers(); });

describe('saveNote — Drive cleanup after the save', () => {
  it('returns once the note is saved, without waiting out the cleanup', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const root = await bm.ensureRoot();
    const saving = saveNote(createNote({ title: 'Capture', body: 'x' }), root, undefined, async (n) => n);
    await vi.waitFor(() => expect(gc.deleteUnreferencedFiles).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(CLEANUP_WAIT_MS);
    await expect(saving).resolves.toMatchObject({ status: 'ok' });
    expect(await bm.listNotes(root)).toHaveLength(1);
  });

  it('gives the cleanup a moment first, so an ordinary pass still finishes with the save', () => {
    expect(CLEANUP_WAIT_MS).toBeGreaterThanOrEqual(10_000);
  });
});
