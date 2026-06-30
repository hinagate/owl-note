// src/lib/save-note.js — persist a note to its bookmark (capping oversized notes to device-local).
import * as bm from './bookmarks.js';
import * as mirror from './mirror.js';
import { encode } from './codec.js';

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

export async function saveNote(note, folderId, existingBookmarkId) {
  await mirror.saveBackup(note); // durability first — always
  const payload = await encode(note);
  const bytes = urlByteLength(payload);
  if (bytes > MAX_URL_BYTES) {
    if (existingBookmarkId) await bm.deleteNote(existingBookmarkId);
    await mirror.saveBackup(note, { folderId, localOnly: true });
    return { bookmarkId: null, status: 'capped' };
  }
  let bookmarkId = existingBookmarkId;
  if (bookmarkId) await bm.updateNote(bookmarkId, note.title, payload);
  else bookmarkId = await bm.createNote(folderId, note.title, payload);
  await mirror.saveBackup(note, { localOnly: false });
  return { bookmarkId, status: bytes > WARN_URL_BYTES ? 'warn' : 'ok' };
}
