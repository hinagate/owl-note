import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import * as client from '../src/lib/drive/client.js';
import { getBytes, offloadNote, offloadShape } from '../src/lib/attachment-store.js';

vi.mock('../src/lib/drive/client.js', () => ({ findByHash: vi.fn(), uploadFile: vi.fn(), getMedia: vi.fn() }));

beforeEach(() => { installFakeChrome(); client.getMedia.mockReset(); client.findByHash.mockReset(); client.uploadFile.mockReset(); });

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

describe('attachment-store getBytes', () => {
  it('returns the inline dataUri when present', async () => {
    expect(await getBytes({ id: 'h1', dataUri: PNG })).toBe(PNG);
    expect(client.getMedia).not.toHaveBeenCalled();
  });
  it('returns cached bytes without hitting Drive', async () => {
    await chrome.storage.local.set({ 'owlcache:h1': PNG });
    expect(await getBytes({ id: 'h1', mime: 'image/png', driveFileId: 'FID' })).toBe(PNG);
    expect(client.getMedia).not.toHaveBeenCalled();
  });
  it('fetches from Drive, caches, and returns a data URI', async () => {
    client.getMedia.mockResolvedValue(new Uint8Array([1, 2, 3]));
    const uri = await getBytes({ id: 'h1', mime: 'image/png', driveFileId: 'FID' });
    expect(uri.startsWith('data:image/png;base64,')).toBe(true);
    expect((await chrome.storage.local.get('owlcache:h1'))['owlcache:h1']).toBe(uri);
  });
  it('returns null when bytes are unavailable (offline / no id)', async () => {
    expect(await getBytes({ id: 'h1', mime: 'image/png' })).toBe(null);
  });
});

describe('attachment-store offloadNote', () => {
  it('is a no-op when Drive sync is disabled', async () => {
    const note = { id: 'n', attachments: [{ id: 'h1', name: 'p.png', dataUri: PNG }] };
    expect(await offloadNote(note)).toBe(note);
  });
  it('replaces inline bytes with driveFileId when enabled', async () => {
    await chrome.storage.local.set({ 'drive:enabled': true });
    client.findByHash.mockResolvedValue(null);
    client.uploadFile.mockResolvedValue('FID');
    const note = { id: 'n', attachments: [{ id: 'h1', name: 'p.png', dataUri: PNG }] };
    const out = await offloadNote(note);
    expect(out.attachments[0]).toEqual({ id: 'h1', name: 'p.png', mime: 'image/png', driveFileId: 'FID' });
    expect(out.attachments[0].dataUri).toBeUndefined();
  });
  it('returns the original note unchanged if any upload fails (stays local)', async () => {
    await chrome.storage.local.set({ 'drive:enabled': true });
    client.findByHash.mockResolvedValue(null);
    client.uploadFile.mockRejectedValue(new Error('offline'));
    const note = { id: 'n', attachments: [{ id: 'h1', name: 'p.png', dataUri: PNG }] };
    expect(await offloadNote(note)).toBe(note);
  });
});

describe('attachment-store offloadShape (pure, for sizing)', () => {
  it('replaces inline bytes with a reference-sized stand-in without uploading', () => {
    const note = { id: 'n', attachments: [{ id: 'h1', name: 'p.png', mime: 'image/png', dataUri: PNG }] };
    const shape = offloadShape(note);
    expect(shape.attachments[0].dataUri).toBeUndefined();
    expect(shape.attachments[0].driveFileId).toBeTruthy();
    expect(client.uploadFile).not.toHaveBeenCalled();
  });
});
