// [Task E17] Integration tests for the first-run sample-notes offer. Boots the real
// app over fake-chrome (same harness as app-integration / review-ask) and drives the
// activation card that only a brand-new, empty, never-offered install sees:
//   - shown ONLY when the corpus is empty AND owl:sampleOffered is unset;
//   - [Load samples] seeds the bundled demo corpus into a "Samples" notebook via the
//     REAL import path (ids/hashes/index consistent), latches the flag, and the
//     lexical index sees the new notes;
//   - [Start empty] latches the flag and creates nothing;
//   - once a choice is made the offer never returns across a re-init;
//   - the seeded notes come straight from demo/demo-notes.json (single source).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { installFakeChrome } from './helpers/fake-chrome.js';
import { contentHash } from '../src/lib/note.js';

// The on-disk demo corpus — the SINGLE source of truth the offer must seed from.
// Read straight off disk (vitest's cwd is the repo root) so this test asserts the
// app seeds from the real file, not a hand-copied duplicate.
const demoOnDisk = JSON.parse(readFileSync(resolve(process.cwd(), 'demo/demo-notes.json'), 'utf8'));
const DEMO_IDS = demoOnDisk.notes.map((n) => n.id).sort();

let app, bm, encode;

beforeEach(async () => {
  installFakeChrome();
  // Mount an #ask-panel — the offer only exists to make Ask Owl demoable, so it is
  // gated on the Ask drawer being present (as app.html always is in production).
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

async function samplesFolderId(root) {
  return (await bm.listNotebooks(root)).find((nb) => nb.title === 'Samples')?.id ?? null;
}

describe('first-run sample offer — when it appears', () => {
  it('appears on a brand-new empty install with the flag unset', async () => {
    const root = await bm.ensureRoot();
    await app.initUI(root);
    const banner = document.getElementById('sample-banner');
    expect(banner).not.toBeNull();
    expect(banner.textContent).toContain('sample notes');
    expect(banner.querySelector('.sample-load')).not.toBeNull();
    expect(banner.querySelector('.sample-skip')).not.toBeNull();
    // Merely showing the offer must NOT latch the flag — only a choice does.
    expect((await chrome.storage.local.get('owl:sampleOffered'))['owl:sampleOffered']).toBeFalsy();
  });

  it('never appears when the corpus already has notes (existing user)', async () => {
    const root = await bm.ensureRoot();
    await seedNote(root, { id: 'x1', title: 'Existing', body: 'a real note the user already has' });
    await app.initUI(root);
    await settle();
    expect(document.getElementById('sample-banner')).toBeNull();
  });

  it('never appears when owl:sampleOffered is already set (even on an empty corpus)', async () => {
    const root = await bm.ensureRoot();
    await chrome.storage.local.set({ 'owl:sampleOffered': true });
    await app.initUI(root);
    await settle();
    expect(document.getElementById('sample-banner')).toBeNull();
  });
});

describe('first-run sample offer — [Load samples]', () => {
  it('seeds the demo corpus into a Samples notebook, the index sees them, latches the flag, and dismisses', async () => {
    const root = await bm.ensureRoot();
    await app.initUI(root);
    const banner = document.getElementById('sample-banner');
    expect(banner).not.toBeNull();

    banner.querySelector('.sample-load').click();
    await waitFor(async () => {
      const id = await samplesFolderId(root);
      return id && (await bm.listNotes(id)).length === demoOnDisk.notes.length;
    });

    // Notes landed in a "Samples" notebook...
    const samplesId = await samplesFolderId(root);
    expect(samplesId).not.toBeNull();
    const seeded = await bm.listNotes(samplesId);
    expect(seeded).toHaveLength(demoOnDisk.notes.length);

    // ...they come straight from demo/demo-notes.json (single source of truth)...
    const all = await app.loadNotes(root);
    const seededIds = all.filter((n) => n.folderId === samplesId).map((n) => n.id).sort();
    expect(seededIds).toEqual(DEMO_IDS);

    // ...the lexical index sees them...
    await app.rebuildAskIndex();
    expect(app.getAskIndex().stats().notes).toBe(demoOnDisk.notes.length);

    // ...the flag is latched and the offer is gone.
    expect((await chrome.storage.local.get('owl:sampleOffered'))['owl:sampleOffered']).toBe(true);
    expect(document.getElementById('sample-banner')).toBeNull();
  });

  it('seeded notes are ordinary notes — they can be trashed like any other', async () => {
    const root = await bm.ensureRoot();
    await app.initUI(root);
    document.getElementById('sample-banner').querySelector('.sample-load').click();
    await waitFor(async () => {
      const id = await samplesFolderId(root);
      return id && (await bm.listNotes(id)).length === demoOnDisk.notes.length;
    });
    const samplesId = await samplesFolderId(root);
    const one = (await app.loadNotes(root)).find((n) => n.folderId === samplesId);
    const trashId = await (await import('../src/lib/trash.js')).ensureTrash(root);
    await (await import('../src/lib/trash.js')).trashNotes([{ id: one.id, bookmarkId: one.bookmarkId, folderId: samplesId }], trashId);
    const remaining = (await app.loadNotes(root)).filter((n) => n.folderId === samplesId);
    expect(remaining).toHaveLength(demoOnDisk.notes.length - 1);
  });

  it('does not re-offer after loading samples, even across a re-init (corpus now non-empty + flag set)', async () => {
    const root = await bm.ensureRoot();
    await app.initUI(root);
    document.getElementById('sample-banner').querySelector('.sample-load').click();
    await waitFor(async () => {
      const id = await samplesFolderId(root);
      return id && (await bm.listNotes(id)).length === demoOnDisk.notes.length;
    });
    app.resetUI();
    await app.initUI(root);
    await settle();
    expect(document.getElementById('sample-banner')).toBeNull();
  });
});

describe('first-run sample offer — [Start empty]', () => {
  it('latches the flag, creates no notes, and never returns across a re-init', async () => {
    const root = await bm.ensureRoot();
    await app.initUI(root);
    const banner = document.getElementById('sample-banner');
    expect(banner).not.toBeNull();

    banner.querySelector('.sample-skip').click();
    await settle();

    expect((await chrome.storage.local.get('owl:sampleOffered'))['owl:sampleOffered']).toBe(true);
    expect(document.getElementById('sample-banner')).toBeNull();
    expect(await app.loadNotes(root)).toHaveLength(0); // nothing created
    expect(await samplesFolderId(root)).toBeNull();    // no Samples notebook

    // Re-init: corpus still empty, but the flag suppresses the offer forever.
    app.resetUI();
    await app.initUI(root);
    await settle();
    expect(document.getElementById('sample-banner')).toBeNull();
  });
});
