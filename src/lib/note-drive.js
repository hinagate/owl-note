// src/lib/note-drive.js
// When a note's compressed payload exceeds the bookmark sync cap (MAX_URL_BYTES),
// the full payload is offloaded to the user's Drive and the bookmark keeps only a
// small "stub" (metadata + a short preview + the Drive fileId). This lets ANY note
// sync when Drive sync is on — small notes as bookmarks, big ones as stub + Drive body.
import * as client from './drive/client.js';

const NOTE_MIME = 'application/octet-stream';
const PREVIEW_CHARS = 200;

export function bodyPreview(body) {
  return String(body ?? '').slice(0, PREVIEW_CHARS);
}

// Create (or overwrite) the Drive file holding a note's full encoded payload.
// Returns the fileId. Reuses `existingFileId` so cross-device edits update in place.
export async function saveNoteBody(noteId, payloadStr, existingFileId) {
  const bytes = new TextEncoder().encode(payloadStr);
  if (existingFileId) {
    try {
      return await client.updateMedia(existingFileId, bytes);
    } catch (err) {
      // The Drive body file was deleted (e.g. the user removed the sync folder) — recreate
      // it instead of failing the save, so the note re-syncs to a fresh file.
      if (err && err.status === 404) {
        return client.uploadFile({ name: `note-${noteId}.owlnote`, mime: NOTE_MIME, bytes, hash: noteId });
      }
      throw err;
    }
  }
  return client.uploadFile({ name: `note-${noteId}.owlnote`, mime: NOTE_MIME, bytes, hash: noteId });
}

export async function loadNoteBody(fileId) {
  const bytes = await client.getMedia(fileId);
  return new TextDecoder().decode(bytes);
}

export async function deleteNoteBody(fileId) {
  await client.deleteFile(fileId);
}

// Build a stub for an over-cap note: upload the full payload to Drive, return the
// metadata-only stub to store in the bookmark. Returns null when Drive sync is off,
// so the caller falls back to keeping the note device-local (today's behavior).
export async function stubForBigNote(note, payloadStr, prevFileId) {
  const enabled = (await chrome.storage.local.get('drive:enabled'))['drive:enabled'];
  if (!enabled) return null;
  const fileId = await saveNoteBody(note.id, payloadStr, prevFileId);
  const stub = {
    id: note.id,
    title: note.title,
    created: note.created,
    version: note.version,
    hash: note.hash,
    pinned: note.pinned,
    _driveBody: fileId,
    preview: bodyPreview(note.body),
  };
  return { stub, fileId };
}
