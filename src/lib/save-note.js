// src/lib/save-note.js — persist a note to its bookmark (capping oversized notes to device-local).
import * as bm from './bookmarks.js';
import * as mirror from './mirror.js';
import { encode } from './codec.js';

export const WARN_URL_BYTES = 16384;
export const MAX_URL_BYTES = 65536;

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
