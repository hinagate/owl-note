// [Task E18] Integration tests for the first-run Welcome note. Boots the real app over
// fake-chrome (same harness as review-ask) and drives the onboarding note
// that only a brand-new, never-welcomed install creates:
//   - fresh boot (empty + owl:welcomed unset): ONE ordinary Welcome note is created via
//     the real save path, the editor LANDS on it, and the flag latches;
//   - deleting it never resurrects it (the flag is checked BEFORE emptiness);
//   - an existing user (any notes) silently latches the flag and gets NO surprise note;
//   - the note is ordinary: indexed by Ask and deletable through the normal flow;
//   - a creation failure (save path throws) never breaks boot or leaks a rejection.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import { contentHash } from '../src/lib/note.js';
import { WELCOME_NOTE_ID, WELCOME_NOTE_TITLE } from '../src/app/welcome-note.js';
import { ensureTrash, trashNotes } from '../src/lib/trash.js';

let app, bm, encode;

beforeEach(async () => {
  installFakeChrome();
  // Mount an #ask-panel: the welcome note is a full-app onboarding
  // experience (it points at Ask Owl), so it stays inert in bare
  // harnesses without one — exactly as app.html always mounts it in production.
  document.body.innerHTML =
    '<div id="toolbar"></div><aside id="sidebar"></aside><section id="note-list"></section>'
    + '<main id="editor"></main><aside id="ask-panel" hidden></aside><div id="toast" hidden></div>';
  app = await import('../src/app/app.js');
  bm = await import('../src/lib/bookmarks.js');
  ({ encode } = await import('../src/lib/codec.js'));
  app.resetUI();
  app.getAskIndex().build([]); // module-level singleton — clear between tests
});

afterEach(async () => {
  try { app.__setWelcomeSaveForTests(null); } catch { /* ignore */ }
  try { app.resetUI(); } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 50));
});

const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 1500) {
  const start = Date.now();
  while (Date.now() - start < ms) { if (await fn()) return; await settle(5); }
  throw new Error('waitFor: condition not met in time');
}

async function seedNote(folder, { id, title, body }) {
  const note = { id, title, body, version: 1, hash: contentHash(body) };
  await bm.createNote(folder, title, await encode(note));
}
const hasWelcome = async (root) => (await app.loadNotes(root)).some((n) => n.id === WELCOME_NOTE_ID);
const flagSet = async () => (await chrome.storage.local.get('owl:welcomed'))['owl:welcomed'];

describe('welcome note — fresh first run', () => {
  it('creates a real welcome note, lands the editor on it, and latches the flag', async () => {
    const root = await bm.ensureRoot();
    expect(await flagSet()).toBeFalsy();
    await app.initUI(root);
    await waitFor(() => document.querySelector('#editor .note-title')?.value === WELCOME_NOTE_TITLE);

    // A real, listed note (created through the save path — has a bookmark).
    const welcome = (await app.loadNotes(root)).find((n) => n.id === WELCOME_NOTE_ID);
    expect(welcome).toBeTruthy();
    expect(welcome.title).toBe(WELCOME_NOTE_TITLE);
    expect(welcome.bookmarkId).toBeTruthy();

    // The editor actually LANDED on it (editor/ui state, not merely note existence).
    expect(document.querySelector('#editor .note-title').value).toBe(WELCOME_NOTE_TITLE);
    expect(document.querySelector('#editor textarea.note-body').value).toContain('Ask Owl');

    // Flag latched so it never recreates.
    expect(await flagSet()).toBe(true);
  });

  it('does not resurrect the welcome note after it is deleted (flag checked before emptiness)', async () => {
    const root = await bm.ensureRoot();
    await app.initUI(root);
    await waitFor(() => hasWelcome(root));

    // Delete it, leaving the corpus empty again.
    const welcome = (await app.loadNotes(root)).find((n) => n.id === WELCOME_NOTE_ID);
    const trashId = await ensureTrash(root);
    await trashNotes([{ id: welcome.id, bookmarkId: welcome.bookmarkId, folderId: root }], trashId);
    expect(await hasWelcome(root)).toBe(false);

    // Reboot on the now-empty corpus: the persisted flag prevents recreation.
    app.resetUI();
    await app.initUI(root);
    await settle();
    expect(await hasWelcome(root)).toBe(false);
  });

  it('is an ordinary note: indexed by Ask and deletable through the editor', async () => {
    const root = await bm.ensureRoot();
    await app.initUI(root);
    await waitFor(() => document.querySelector('#editor .note-title')?.value === WELCOME_NOTE_TITLE);

    await app.rebuildAskIndex();
    expect(app.getAskIndex().stats().notes).toBe(1);
    expect(app.getAskIndex().noteMeta(WELCOME_NOTE_ID)).toBeTruthy();

    window.confirm = () => true;
    document.querySelector('#editor button.delete').click();
    await waitFor(async () => !(await hasWelcome(root)));
    expect(await hasWelcome(root)).toBe(false);
  });
});

describe('welcome note — existing users', () => {
  it('latches the flag and creates NO welcome note when the corpus already has notes', async () => {
    const root = await bm.ensureRoot();
    await seedNote(root, { id: 'x1', title: 'My note', body: 'something I already wrote' });
    await app.initUI(root);
    await waitFor(() => document.querySelector('#editor .note-title')?.value === 'My note');

    expect(await hasWelcome(root)).toBe(false);       // no surprise note
    expect(await flagSet()).toBe(true);               // silently latched
    // A later delete-everything therefore can't resurrect a welcome note.
  });
});

describe('welcome note — creation failure is non-fatal', () => {
  it('a save-path throw leaves boot intact, creates nothing, and does not latch the flag', async () => {
    const root = await bm.ensureRoot();
    app.__setWelcomeSaveForTests(async () => { throw new Error('storage hiccup'); });

    await app.initUI(root); // must NOT reject
    await settle();

    expect(await hasWelcome(root)).toBe(false);    // nothing created
    expect(await flagSet()).toBeFalsy();           // NOT latched -> a healthy next boot retries
    expect(document.getElementById('note-list')).not.toBeNull(); // shell still rendered
  });
});
