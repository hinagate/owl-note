import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';

// Drive's hidden app-data folder, in memory; it outlives the browser's own storage.
const drive = { files: [], lacksScope: false };
vi.mock('../src/lib/drive/client.js', async (importOriginal) => ({
  ...(await importOriginal()),
  listAppData: vi.fn(async () => {
    if (drive.lacksScope) throw Object.assign(new Error('Drive API 403'), { status: 403, detail: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' });
    return drive.files.map((f) => ({ ...f }));
  }),
  createAppData: vi.fn(async ({ name, appProperties }) => { drive.files.push({ id: name, name, appProperties }); return name; }),
}));
// Connecting Drive for real needs Google; these stand in for a consent the user gives.
vi.mock('../src/lib/drive-sync.js', async (importOriginal) => ({
  ...(await importOriginal()),
  enable: vi.fn(async () => { await chrome.storage.local.set({ 'drive:enabled': true }); }),
  reauthorize: vi.fn(async () => { drive.lacksScope = false; }),
}));
vi.mock('../src/lib/drive/auth.js', async (importOriginal) => ({ ...(await importOriginal()), isConfigured: () => true }));

beforeEach(async () => {
  installFakeChrome();
  const { _resetCache } = await import('../src/lib/note-key.js');
  _resetCache();
  drive.files = [];
  drive.lacksScope = false;
  document.body.innerHTML =
    '<div id="toolbar"></div><aside id="sidebar"></aside><section id="note-list"></section><main id="editor"></main><div id="toast" hidden></div>';
  window.confirm = () => true;
  const app = await import('../src/app/app.js');
  app.resetUI();
});

afterEach(async () => {
  const app = await import('../src/app/app.js');
  app.resetUI();
  await new Promise((r) => setTimeout(r, 50));
});

async function waitFor(fn, ms = 2000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('waitFor: condition not met in time');
}

// A note saved in an earlier install whose key was backed up to Drive, then the
// extension reinstalled: the note is still in the bookmarks, the key only in Drive.
async function reinstalledWithNoteInDrive() {
  const bm = await import('../src/lib/bookmarks.js');
  const { encode } = await import('../src/lib/codec.js');
  const keys = await import('../src/lib/note-key.js');
  const root = await bm.ensureRoot();
  await bm.createNote(root, 'Diary', await encode({ id: 'd1', title: 'Diary', body: 'only the key can read this', created: 1 }));
  const [[id, b64]] = Object.entries((await keys.exportKeyring()).keys);
  drive.files = [{ id: 'k', appProperties: { owlKind: 'owl-note-key', owlKeyId: id, owlKey: b64 } }];
  await chrome.storage.local.remove([`owl:key:${id}`, 'owl:keyIds', 'owl:activeKeyId']);
  await chrome.storage.sync.remove([`owl:key:${id}`]);
  keys._resetCache();
  return root;
}

const notice = () => document.querySelector('#note-list .list-notice');
const noticeButton = (label) => [...(notice()?.querySelectorAll('button') || [])].find((b) => b.textContent === label);

describe('restoring note keys from Google Drive', () => {
  it('after a reinstall, one click on "Restore from Google Drive" opens the locked notes', async () => {
    const app = await import('../src/app/app.js');
    const root = await reinstalledWithNoteInDrive();
    await app.initUI(root);
    await waitFor(() => notice());
    expect(notice().textContent).toContain("1 note can't be opened");
    expect(noticeButton('Import recovery key')).toBeTruthy();

    noticeButton('Restore from Google Drive').click();
    await waitFor(() => document.querySelector('#editor textarea.note-body')?.value === 'only the key can read this');
    await waitFor(() => document.getElementById('toast').textContent.includes('restored 1 encryption key'));
    await waitFor(() => document.querySelector('#toolbar .drive-sync')?.checked); // the toggle's own refresh is done
    expect(notice()).toBeNull();
  });

  it('with Drive already on, restores the keys at launch with no click at all', async () => {
    const app = await import('../src/app/app.js');
    const root = await reinstalledWithNoteInDrive();
    await chrome.storage.local.set({ 'drive:enabled': true });
    await app.initUI(root);
    await waitFor(() => document.querySelector('#editor textarea.note-body')?.value === 'only the key can read this');
    expect(notice()).toBeNull();
  });

  it('backs up a new key to Drive, and asks once to allow it on an older Drive connection', async () => {
    const app = await import('../src/app/app.js');
    const bm = await import('../src/lib/bookmarks.js');
    const { encode } = await import('../src/lib/codec.js');
    const root = await bm.ensureRoot();
    await bm.createNote(root, 'Plan', await encode({ id: 'p1', title: 'Plan', body: 'b', created: 1 }));
    await chrome.storage.local.set({ 'drive:enabled': true });
    drive.lacksScope = true;
    await app.initUI(root);
    await waitFor(() => noticeButton('Allow'));
    expect(notice().textContent).toContain('Google Drive sync can now back up your encryption key');

    noticeButton('Allow').click();
    await waitFor(() => drive.files.length === 1);
    expect(drive.files[0].appProperties.owlKind).toBe('owl-note-key');
    await waitFor(() => !notice());
  });
});

// Every install from before key backup existed, and every install without Drive: the
// keys are backed up nowhere until the user is told and acts.
describe('telling existing users their key is backed up nowhere', () => {
  beforeEach(() => {
    URL.createObjectURL = () => 'blob:recovery-key';
    URL.revokeObjectURL = () => {};
  });

  async function installWithOwnNote() {
    const bm = await import('../src/lib/bookmarks.js');
    const { encode } = await import('../src/lib/codec.js');
    const root = await bm.ensureRoot();
    await bm.createNote(root, 'Plan', await encode({ id: 'p1', title: 'Plan', body: 'b', created: 1 }));
    return root;
  }

  it('asks once there are notes of the user\'s own, and a saved recovery file settles it until a new key appears', async () => {
    const app = await import('../src/app/app.js');
    const root = await installWithOwnNote();
    await app.initUI(root);
    await waitFor(() => notice());
    expect(notice().textContent).toContain('Back up your encryption key');
    expect([...notice().querySelectorAll('button')].map((b) => b.textContent))
      .toEqual(['Back up to Google Drive', 'Save recovery key file', 'Not now']);

    noticeButton('Save recovery key file').click();
    await waitFor(() => !notice());

    // A key minted elsewhere arrives: the saved file does not hold it.
    const { importKeyring } = await import('../src/lib/note-key.js');
    const { bytesToBase64url } = await import('../src/lib/base64url.js');
    await importKeyring({ keys: { keyNEWWW: bytesToBase64url(new Uint8Array(32).fill(9)) } });
    app.resetUI();
    await app.initUI(root);
    await waitFor(() => notice()?.textContent.includes('Back up your encryption key'));
  });

  it('turns Drive on from the banner, which backs the key up', async () => {
    const app = await import('../src/app/app.js');
    const root = await installWithOwnNote();
    await app.initUI(root);
    await waitFor(() => noticeButton('Back up to Google Drive'));
    noticeButton('Back up to Google Drive').click();
    await waitFor(() => drive.files.length === 1);
    await waitFor(() => !notice());
  });

  it('"Not now" holds across restarts', async () => {
    const app = await import('../src/app/app.js');
    const root = await installWithOwnNote();
    await app.initUI(root);
    await waitFor(() => noticeButton('Not now'));
    noticeButton('Not now').click();
    await waitFor(() => !notice());
    app.resetUI();
    await app.initUI(root);
    await new Promise((r) => setTimeout(r, 50));
    expect(notice()).toBeNull();
  });

  const backupItem = () => document.querySelector('#toolbar .menu-item.key-backup');

  it('the Export menu shows where the key is backed up, and brings the banner back after "Not now"', async () => {
    const app = await import('../src/app/app.js');
    const root = await installWithOwnNote();
    await app.initUI(root);
    await waitFor(() => noticeButton('Not now'));
    expect(backupItem().textContent).toBe('🔑 Key backup: not backed up…');
    noticeButton('Not now').click();
    await waitFor(() => !notice());

    backupItem().click();
    await waitFor(() => noticeButton('Close'));
    expect([...notice().querySelectorAll('button')].map((b) => b.textContent))
      .toEqual(['Back up to Google Drive', 'Save recovery key file', 'Close']);
    noticeButton('Save recovery key file').click();
    await waitFor(() => !notice());
    expect(backupItem().textContent).toBe('🔑 Key backup: recovery file ✓');

    backupItem().click(); // already in a file: offers Drive as well, or a fresh file
    await waitFor(() => noticeButton('Save a new recovery key file'));
    noticeButton('Close').click();
    await waitFor(() => !notice());
  });

  it('on an older Drive connection, the Export menu allows key backup directly after "Not now"', async () => {
    const app = await import('../src/app/app.js');
    const root = await installWithOwnNote();
    await chrome.storage.local.set({ 'drive:enabled': true });
    drive.lacksScope = true;
    await app.initUI(root);
    await waitFor(() => noticeButton('Allow'));
    expect(backupItem().textContent).toBe('🔑 Key backup: allow Google Drive…');
    noticeButton('Not now').click();
    await waitFor(() => !notice());

    backupItem().click();
    await waitFor(() => drive.files.length === 1);
    await waitFor(() => backupItem().textContent === '🔑 Key backup: Google Drive ✓');
    expect(notice()).toBeNull();
  });

  it('leaves a brand-new install alone while it holds only the welcome note', async () => {
    const app = await import('../src/app/app.js');
    const bm = await import('../src/lib/bookmarks.js');
    const { encode } = await import('../src/lib/codec.js');
    const { WELCOME_NOTE_ID } = await import('../src/app/welcome-note.js');
    const root = await bm.ensureRoot();
    await bm.createNote(root, 'Welcome', await encode({ id: WELCOME_NOTE_ID, title: 'Welcome', body: 'hi', created: 1 }));
    await app.initUI(root);
    await waitFor(() => document.querySelector('#note-list .item.card'));
    await new Promise((r) => setTimeout(r, 50));
    expect(notice()).toBeNull();
  });
});
