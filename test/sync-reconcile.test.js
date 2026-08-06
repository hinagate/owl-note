// Two devices, one note: when device A's edit syncs in, device B's note LIST used to
// update while the open editor kept showing (and, on its next auto-save, wrote back)
// the copy it was opened with — silently reverting A. These cover the open note being
// pulled forward with the list, and never at the cost of unsaved work.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';

beforeEach(async () => {
  installFakeChrome();
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

const bodyField = () => document.querySelector('#editor textarea.note-body');
const titleField = () => document.querySelector('#editor .note-title');
const remoteBar = () => document.querySelector('#editor .remote-change-bar');

function type(field, text) {
  field.value = text;
  field.dispatchEvent(new Event('input'));
}

// Open one note in the app, exactly as a fresh boot would.
async function bootWithNote({ body = 'original body', title = 'Shared note' } = {}) {
  const app = await import('../src/app/app.js');
  const bm = await import('../src/lib/bookmarks.js');
  const { encode } = await import('../src/lib/codec.js');
  const { contentHash } = await import('../src/lib/note.js');
  const root = await bm.ensureRoot();
  const note = { id: 'n1', title, body, created: 1000, updated: 1000, version: 1, hash: contentHash(body) };
  await bm.createNote(root, note.title, await encode(note));
  await app.initUI(root);
  await waitFor(() => bodyField()?.value === body); // boot opens the latest note
  const [{ bookmarkId }] = await bm.listNotes(root);
  return { app, bm, root, note, bookmarkId };
}

// What Chrome's bookmark sync does when the other device's edit lands: the same
// bookmark, rewritten with a newer payload.
async function syncInEdit(bm, bookmarkId, note, { body, title = note.title }) {
  const { encode } = await import('../src/lib/codec.js');
  const { contentHash } = await import('../src/lib/note.js');
  const remote = { ...note, title, body, updated: note.updated + 1000, version: note.version + 1, hash: contentHash(body) };
  await bm.updateNote(bookmarkId, remote.title, await encode(remote));
  return remote;
}

async function storedBody(bm, bookmarkId) {
  const { decode } = await import('../src/lib/codec.js');
  return (await decode(await bm.payloadAt(bookmarkId))).body;
}

describe('an edit synced in from another device reaches the OPEN note', () => {
  it('replaces the editor content, not just the note-list card', async () => {
    const { bm, note, bookmarkId } = await bootWithNote();
    await syncInEdit(bm, bookmarkId, note, { body: 'edited on the other device' });
    await waitFor(() => bodyField().value === 'edited on the other device');
    expect(document.querySelector('#note-list .item.card').textContent).toContain('edited on the other device');
  });

  it('follows a title-only edit too', async () => {
    const { bm, note, bookmarkId } = await bootWithNote();
    await syncInEdit(bm, bookmarkId, note, { body: note.body, title: 'Renamed elsewhere' });
    await waitFor(() => titleField().value === 'Renamed elsewhere');
    expect(bodyField().value).toBe(note.body); // body untouched
  });

  it('no longer writes the pre-sync copy back on blur (the reverted-edit bug)', async () => {
    const { bm, note, bookmarkId } = await bootWithNote();
    await syncInEdit(bm, bookmarkId, note, { body: 'edited on the other device' });
    await waitFor(() => bodyField().value === 'edited on the other device');
    // Clicking into the note and away used to persist this tab's stale copy.
    bodyField().dispatchEvent(new Event('blur'));
    await new Promise((r) => setTimeout(r, 120));
    expect(await storedBody(bm, bookmarkId)).toBe('edited on the other device');
  });

  it('leaves an untouched editor alone when the change is to a DIFFERENT note', async () => {
    const { bm, root, note } = await bootWithNote();
    const { encode } = await import('../src/lib/codec.js');
    const other = { id: 'n2', title: 'Other', body: 'other body', created: 500, updated: 500, version: 1 };
    await bm.createNote(root, other.title, await encode(other)); // fires onCreated -> live refresh
    await waitFor(async () => (await bm.listNotes(root)).length === 2);
    await new Promise((r) => setTimeout(r, 60));
    expect(bodyField().value).toBe(note.body);
  });
});

describe('unsaved local edits are never discarded by a synced-in change', () => {
  it('keeps the in-progress text and shows the remote-change notice instead', async () => {
    const { bm, note, bookmarkId } = await bootWithNote();
    type(bodyField(), 'my unsaved paragraph'); // typed here, not yet saved
    await syncInEdit(bm, bookmarkId, note, { body: 'edited on the other device' });
    await waitFor(() => remoteBar() && !remoteBar().hidden);
    expect(bodyField().value).toBe('my unsaved paragraph');
  });

  it('Reload swaps in the other device\'s version on request', async () => {
    const { bm, note, bookmarkId } = await bootWithNote();
    type(bodyField(), 'my unsaved paragraph');
    await syncInEdit(bm, bookmarkId, note, { body: 'edited on the other device' });
    await waitFor(() => remoteBar() && !remoteBar().hidden);
    document.querySelector('.remote-change-bar .remote-reload').click();
    await waitFor(() => bodyField().value === 'edited on the other device');
    expect(remoteBar().hidden).toBe(true); // fresh editor, no stale notice
  });

  it('Keep mine dismisses the notice and leaves the local draft in place', async () => {
    const { bm, note, bookmarkId } = await bootWithNote();
    type(bodyField(), 'my unsaved paragraph');
    await syncInEdit(bm, bookmarkId, note, { body: 'edited on the other device' });
    await waitFor(() => remoteBar() && !remoteBar().hidden);
    document.querySelector('.remote-change-bar .remote-dismiss').click();
    expect(remoteBar().hidden).toBe(true);
    expect(bodyField().value).toBe('my unsaved paragraph');
  });
});

describe('the app\'s own save is not mistaken for a remote change', () => {
  it('does not rebuild the editor (and take the caret with it) after saving', async () => {
    const { bm, bookmarkId } = await bootWithNote();
    const before = bodyField();
    type(before, 'typed here and saved');
    document.querySelector('#editor button.save').click();
    await waitFor(async () => (await storedBody(bm, bookmarkId)) === 'typed here and saved');
    await new Promise((r) => setTimeout(r, 120)); // let the save's own onChanged cycle settle
    expect(bodyField()).toBe(before); // same element — no reconcile-triggered re-render
    expect(bodyField().value).toBe('typed here and saved');
    expect(remoteBar().hidden).toBe(true);
  });
});
