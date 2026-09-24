// src/lib/save-note.js — persist a note to its bookmark (capping oversized notes to device-local).
import * as bm from './bookmarks.js';
import * as mirror from './mirror.js';
import { encode, decode, encryptionKeyId } from './codec.js';
import { offloadNote } from './attachment-store.js';
import { stubForBigNote, deleteNoteBody } from './note-drive.js';
import { deleteUnreferencedFiles } from './drive-gc.js';
import { resolveReferencedAttachments } from './attachment-resolver.js';

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

// A note's Drive attachment files (its over-cap body file is tracked separately, above).
function attachmentFileIds(note) {
  return ((note && note.attachments) || []).filter((a) => a && a.driveFileId).map((a) => a.driveFileId);
}

export async function saveNote(note, folderId, existingBookmarkId, offload = offloadNote, bigNote = stubForBigNote, resolveAttachments = resolveReferencedAttachments) {
  // `locked` is attached only to an envelope whose ciphertext this installation
  // cannot open. No caller may turn that placeholder back into note content.
  if (note && note.locked) throw new Error('Cannot save a locked note without its encryption key');

  // A copied owl-img/owl-file reference contains only an id. Recover its matching
  // attachment from another note before mirroring, pruning, or Drive offload.
  const completeNote = await resolveAttachments(note);
  // Capture the note's previously-synced attachment files BEFORE the bookmark is overwritten,
  // so we can delete from Drive any the user has since removed (see the cleanup at the end).
  let prevAtt = [];
  let existingKeyId = null;
  if (existingBookmarkId) {
    const prevPayload = await bm.payloadAt(existingBookmarkId);
    if (prevPayload) {
      try { existingKeyId = await encryptionKeyId(prevPayload); } catch { /* malformed legacy payload: save with the active key */ }
      try { prevAtt = attachmentFileIds(await decode(prevPayload)); } catch { /* unreadable */ }
    }
  }

  // Durability first — always, with full inline bytes. A NEW note's first copy is not
  // listed anywhere until the writes below file it, so it records where it was going: a
  // save cut off in between (the worker stopped during a slow Drive upload) otherwise
  // leaves the note complete, full-size, and invisible. The app files such a copy as a
  // device-local note once it is clearly abandoned (mirror.recoverStrandedNotes).
  await mirror.saveBackup(completeNote, existingBookmarkId ? undefined : { pendingFolderId: folderId });
  const toSave = await offload(completeNote); // best-effort Drive offload of attachments (no-op when sync off / on failure)
  const prevFileId = completeNote._driveBody || null; // a prior Drive-backed body, if this note had one
  const { _driveBody, ...content } = toSave; // the stored payload never carries the body-pointer
  const encodeOpts = existingKeyId ? { keyId: existingKeyId } : undefined;
  const payload = await encode(content, encodeOpts);
  const bytes = urlByteLength(payload);

  let result;
  if (bytes > MAX_URL_BYTES) {
    // Over the bookmark sync cap. When Drive sync is on, offload the WHOLE note to Drive
    // and keep a small stub bookmark; otherwise fall back to device-local (today's behavior).
    let big = null;
    let driveFailed = false;
    try {
      big = await bigNote(content, payload, prevFileId);
    } catch (err) {
      // A NEW note loses nothing by staying on this device, which is exactly where a failed
      // attachment offload already leaves it. An existing synced note must not fall
      // through: the device-local branch deletes its bookmark, and a passing network error
      // is no reason to take a note off every other device.
      if (existingBookmarkId) throw err;
      console.warn('[owl-note] Drive note offload failed — note kept device-local:', err);
      driveFailed = true; // callers must not report this as synced, or as merely too large
    }
    if (big) {
      const stubPayload = await encode(big.stub, encodeOpts);
      let bookmarkId = existingBookmarkId;
      if (bookmarkId) await bm.updateNote(bookmarkId, content.title, stubPayload);
      else bookmarkId = await bm.createNote(folderId, content.title, stubPayload);
      await mirror.saveBackup(completeNote, { localOnly: false });
      result = { bookmarkId, status: 'synced' };
    } else {
      if (existingBookmarkId) await bm.deleteNote(existingBookmarkId);
      await mirror.saveBackup(completeNote, { folderId, localOnly: true });
      result = { bookmarkId: null, status: 'capped', ...(driveFailed ? { driveFailed: true } : {}) };
    }
  } else {
    // Fits in a bookmark. If it had been Drive-backed and shrank, clean up the Drive body.
    if (prevFileId) { try { await deleteNoteBody(prevFileId); } catch { /* best-effort cleanup */ } }
    let bookmarkId = existingBookmarkId;
    if (bookmarkId) await bm.updateNote(bookmarkId, content.title, payload);
    else bookmarkId = await bm.createNote(folderId, content.title, payload);
    await mirror.saveBackup(completeNote, { localOnly: false });
    result = { bookmarkId, status: bytes > WARN_URL_BYTES ? 'warn' : 'ok' };
  }

  // Delete the Drive files of attachments the user removed from this note — but only if no
  // other note still references the same (content-hash-deduped) file.
  //
  // The note is saved by now, and this pass also works through cleanup left over from
  // earlier saves, which can mean any number of downloads. So the save waits only a
  // moment for it: the pass checkpoints its work before touching Drive and carries on in
  // the background, and whatever it does not finish is retried on a later save or launch.
  const stillHere = new Set(attachmentFileIds(content));
  const cleanup = deleteUnreferencedFiles(prevAtt.filter((f) => !stillHere.has(f)))
    .catch((err) => { console.warn('[owl-note] Drive cleanup after save failed:', err); });
  await settleWithin(cleanup, CLEANUP_WAIT_MS);
  return { ...result, note: completeNote };
}

export const CLEANUP_WAIT_MS = 30_000;

async function settleWithin(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(resolve, ms); });
  try {
    await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
