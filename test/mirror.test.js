import { describe, it, expect, beforeEach } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import * as mirror from '../src/lib/mirror.js';
import { createNote, withUpdatedBody } from '../src/lib/note.js';

beforeEach(() => installFakeChrome());

describe('mirror', () => {
  it('saves and retrieves a backup, retaining the previous version', async () => {
    const n = createNote({ body: 'v1' });
    await mirror.saveBackup(n);
    const u = withUpdatedBody(n, 'v2', []);
    await mirror.saveBackup(u);
    const b = await mirror.getBackup(n.id);
    expect(b.current.body).toBe('v2');
    expect(b.previous.body).toBe('v1');
  });

  it('healMissing returns only notes absent from the live set', async () => {
    const a = createNote({ body: 'a' });
    const b = createNote({ body: 'b' });
    await mirror.saveBackup(a);
    await mirror.saveBackup(b);
    const missing = await mirror.healMissing(new Set([a.id]));
    expect(missing).toHaveLength(1);
    expect(missing[0].id).toBe(b.id);
  });

  it('exports and imports notes', async () => {
    const a = createNote({ body: 'a' });
    await mirror.saveBackup(a);
    const json = await mirror.exportAll();
    installFakeChrome(); // wipe storage
    const res = await mirror.importAll(json);
    expect(res.imported).toBe(1);
    expect((await mirror.allBackups())[0].body).toBe('a');
  });

  it('importAll skips entries without a valid id', async () => {
    const json = JSON.stringify({ version: 1, notes: [{ id: 'ok', title: 'A', body: 'a', attachments: [], version: 1, hash: 'h' }, { title: 'no id' }, null] });
    const res = await mirror.importAll(json);
    expect(res.imported).toBe(1);
    expect((await mirror.allBackups()).map((n) => n.id)).toEqual(['ok']);
  });

  it('saveBackup records folderId and localOnly; localOnlyBackups filters by folder', async () => {
    const a = createNote({ body: 'a' });
    const b = createNote({ body: 'b' });
    await mirror.saveBackup(a, { folderId: 'F1', localOnly: true });
    await mirror.saveBackup(b, { folderId: 'F2', localOnly: true });
    const inF1 = await mirror.localOnlyBackups('F1');
    expect(inF1).toHaveLength(1);
    expect(inF1[0].id).toBe(a.id);
    expect(inF1[0].localOnly).toBe(true);
    expect(inF1[0].bookmarkId).toBe(null);
    expect(inF1[0].folderId).toBe('F1');
  });

  it('localOnlyBackups excludes synced (non-local) backups', async () => {
    const synced = createNote({ body: 's' });
    await mirror.saveBackup(synced); // no opts -> not local-only
    expect(await mirror.localOnlyBackups('F1')).toHaveLength(0);
    expect(await mirror.isLocalOnly(synced.id)).toBe(false);
  });

  it('setFolder moves a local-only note and keeps it local-only', async () => {
    const a = createNote({ body: 'a' });
    await mirror.saveBackup(a, { folderId: 'F1', localOnly: true });
    await mirror.setFolder(a.id, 'F2');
    expect(await mirror.localOnlyBackups('F1')).toHaveLength(0);
    expect((await mirror.localOnlyBackups('F2'))[0].id).toBe(a.id);
  });
});
