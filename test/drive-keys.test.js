import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import { _resetCache, exportKeyring, importKeyring } from '../src/lib/note-key.js';
import { bytesToBase64url } from '../src/lib/base64url.js';

// Drive's hidden app-data folder, in memory.
const drive = { files: [], fail: null };
vi.mock('../src/lib/drive/client.js', () => ({
  listAppData: vi.fn(async () => {
    if (drive.fail) throw drive.fail;
    return drive.files.map((f) => ({ ...f }));
  }),
  createAppData: vi.fn(async ({ name, appProperties }) => {
    drive.files.push({ id: `file${drive.files.length}`, name, appProperties });
    return `file${drive.files.length - 1}`;
  }),
}));

import { syncKeysWithDrive, driveKeys } from '../src/lib/drive-keys.js';

const key = (fill) => bytesToBase64url(new Uint8Array(32).fill(fill));
const A = { id: 'keyAAAAA', b64: key(1) };
const B = { id: 'keyBBBBB', b64: key(2) };
const inDrive = (k) => ({ id: `f-${k.id}`, appProperties: { owlKind: 'owl-note-key', owlKeyId: k.id, owlKey: k.b64 } });
const apiError = (status, detail) => Object.assign(new Error(`Drive API ${status}`), { status, detail });

beforeEach(() => {
  installFakeChrome();
  _resetCache();
  drive.files = [];
  drive.fail = null;
});

describe('note keys in Google Drive', () => {
  it('backs up each key as its own hidden file, once', async () => {
    await importKeyring({ keys: { [A.id]: A.b64 } });
    expect(await syncKeysWithDrive()).toEqual({ restored: 0, backedUp: 1, needsAccess: false });
    expect(drive.files).toEqual([{ id: 'file0', name: `owl-note-key-${A.id}`, appProperties: { owlKind: 'owl-note-key', owlKeyId: A.id, owlKey: A.b64 } }]);
    expect(await syncKeysWithDrive()).toEqual({ restored: 0, backedUp: 0, needsAccess: false });
    expect(drive.files).toHaveLength(1);
  });

  it('restores every key Drive holds into a browser that has none (a reinstall)', async () => {
    drive.files = [inDrive(A), inDrive(B)];
    expect((await exportKeyring()).keys).toEqual({});
    expect(await syncKeysWithDrive()).toMatchObject({ restored: 2, backedUp: 0 });
    expect((await exportKeyring()).keys).toEqual({ [A.id]: A.b64, [B.id]: B.b64 });
  });

  it('merges two devices\' keys both ways, overwriting nothing', async () => {
    drive.files = [inDrive(A)];
    await importKeyring({ keys: { [B.id]: B.b64 } });
    expect(await syncKeysWithDrive()).toMatchObject({ restored: 1, backedUp: 1 });
    expect(await driveKeys()).toEqual({ [A.id]: A.b64, [B.id]: B.b64 });
    expect((await exportKeyring()).keys).toEqual({ [A.id]: A.b64, [B.id]: B.b64 });
  });

  it('ignores a malformed Drive entry instead of adopting it as a key', async () => {
    drive.files = [{ id: 'bad', appProperties: { owlKind: 'owl-note-key', owlKeyId: 'keyCCCCC', owlKey: 'not-a-key' } }];
    expect(await syncKeysWithDrive()).toMatchObject({ restored: 0 });
    expect((await exportKeyring()).keys).toEqual({});
  });

  it('reports a connection made before key backup existed, and rethrows anything else', async () => {
    drive.fail = apiError(403, '{"error":{"status":"PERMISSION_DENIED","details":[{"reason":"ACCESS_TOKEN_SCOPE_INSUFFICIENT"}]}}');
    expect(await syncKeysWithDrive()).toEqual({ restored: 0, backedUp: 0, needsAccess: true });
    drive.fail = apiError(403, '{"error":{"errors":[{"reason":"userRateLimitExceeded"}]}}');
    await expect(syncKeysWithDrive()).rejects.toThrow('Drive API 403');
  });
});
