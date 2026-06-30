// src/lib/save-note.js — persist a note to its bookmark (capping oversized notes to device-local).
import * as bm from './bookmarks.js';
import * as mirror from './mirror.js';
import { encode } from './codec.js';
import { offloadNote } from './attachment-store.js';
import { stubForBigNote, deleteNoteBody } from './note-drive.js';

// Chrome's bookmark sync silently drops bookmarks whose URL is much past ~8 KB,
// so that — not Chrome's far larger local-bookmark limit — is the real ceiling
// for a note that must SYNC. Measured with tools/sync-probe across two devices.
// Above MAX a note can't sync, so it's kept device-local instead of written as a
// bookmark that looks saved but never replicates. (Earlier 16K/64K values let
// 8–64 KB notes masquerade as synced; the live size meter inherits MAX, so this
// also fixes the misleading "/ 64 KB" readout.)
export const WARN_URL_BYTES = 6144; // 6 KB — warn as a note nears the sync ceiling
export const MAX_URL_BYTES = 8192; // 8 KB — hard sync limit; beyond this, local-only

export function urlByteLength(payload) {
  return new TextEncoder().encode(bm.buildNoteUrl(payload)).length;
}

export async function saveNote(note, folderId, existingBookmarkId, offload = offloadNote, bigNote = stubForBigNote) {
  await mirror.saveBackup(note); // durability first — always, with full inline bytes
  const toSave = await offload(note); // best-effort Drive offload of attachments (no-op when sync off / on failure)
  const prevFileId = note._driveBody || null; // a prior Drive-backed body, if this note had one
  const { _driveBody, ...content } = toSave; // the stored payload never carries the body-pointer
  const payload = await encode(content);
  const bytes = urlByteLength(payload);
  if (bytes > MAX_URL_BYTES) {
    // Over the bookmark sync cap. When Drive sync is on, offload the WHOLE note to Drive
    // and keep a small stub bookmark; otherwise fall back to device-local (today's behavior).
    const big = await bigNote(content, payload, prevFileId);
    if (big) {
      const stubPayload = await encode(big.stub);
      let bookmarkId = existingBookmarkId;
      if (bookmarkId) await bm.updateNote(bookmarkId, content.title, stubPayload);
      else bookmarkId = await bm.createNote(folderId, content.title, stubPayload);
      await mirror.saveBackup(note, { localOnly: false });
      return { bookmarkId, status: 'synced' };
    }
    if (existingBookmarkId) await bm.deleteNote(existingBookmarkId);
    await mirror.saveBackup(note, { folderId, localOnly: true });
    return { bookmarkId: null, status: 'capped' };
  }
  // Fits in a bookmark. If it had been Drive-backed and shrank, clean up the Drive body.
  if (prevFileId) { try { await deleteNoteBody(prevFileId); } catch { /* best-effort cleanup */ } }
  let bookmarkId = existingBookmarkId;
  if (bookmarkId) await bm.updateNote(bookmarkId, content.title, payload);
  else bookmarkId = await bm.createNote(folderId, content.title, payload);
  await mirror.saveBackup(note, { localOnly: false });
  return { bookmarkId, status: bytes > WARN_URL_BYTES ? 'warn' : 'ok' };
}
