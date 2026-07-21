// src/lib/drive-gc.js — remove Drive files that no note references anymore.
// Attachments are de-duplicated by content hash (identical images/files share ONE Drive
// file), so a file is only deleted when NO surviving note — bookmark OR local mirror —
// still points at it. Used by the save path (a removed attachment) and by deleteForever.
import * as bm from './bookmarks.js';
import * as mirror from './mirror.js';
import { decode } from './codec.js';
import { deleteFile } from './drive/client.js';
import { loadNoteBody } from './note-drive.js';

export const DRIVE_CLEANUP_PENDING_KEY = 'drive:pendingCleanupV1';

function validIds(values) {
  return [...new Set((values || []).filter((value) => typeof value === 'string' && value))];
}

async function readPendingCleanup() {
  try {
    const value = (await chrome.storage.local.get(DRIVE_CLEANUP_PENDING_KEY))[DRIVE_CLEANUP_PENDING_KEY];
    return {
      files: validIds(value?.files),
      stubBodies: validIds(value?.stubBodies),
    };
  } catch {
    return { files: [], stubBodies: [] };
  }
}

async function writePendingCleanup(files, stubBodies) {
  const value = {
    files: [...files].sort(),
    stubBodies: [...stubBodies].sort(),
  };
  try {
    if (!value.files.length && !value.stubBodies.length) {
      await chrome.storage.local.remove(DRIVE_CLEANUP_PENDING_KEY);
    } else {
      await chrome.storage.local.set({ [DRIVE_CLEANUP_PENDING_KEY]: value });
    }
  } catch { /* cleanup remains best-effort if local storage itself is unavailable */ }
}

// A note's Drive files: its over-cap body file and any image/file attachment files.
export function driveFileIdsOf(note) {
  const ids = [];
  if (note && note._driveBody) ids.push(note._driveBody);
  for (const a of (note && note.attachments) || []) if (a && a.driveFileId) ids.push(a.driveFileId);
  return ids;
}

// Delete each candidate Drive file that no note still references. Work is persisted before
// touching Drive, so offline/auth failures retry on a later save or app launch. A deleted
// over-cap note passes its body id in stubBodyFileIds: that body is decoded first to discover
// attachment ids hidden by the bookmark stub, and the body itself is never deleted until the
// expansion succeeds.
async function runDeleteUnreferencedFiles(candidateFileIds, { stubBodyFileIds = [] } = {}) {
  const pending = await readPendingCleanup();
  const candidates = new Set(validIds([...pending.files, ...(candidateFileIds || [])]));
  const bodiesToExpand = new Set(validIds([...pending.stubBodies, ...stubBodyFileIds]));
  for (const bodyId of bodiesToExpand) candidates.add(bodyId);
  if (!candidates.size && !bodiesToExpand.size) return { deleted: 0, pending: 0 };

  // Crash-safe checkpoint: even if the service/app context closes during the network work,
  // every not-yet-deleted id is available to the next retry.
  await writePendingCleanup(candidates, bodiesToExpand);

  for (const bodyId of [...bodiesToExpand]) {
    try {
      const full = await decode(await loadNoteBody(bodyId));
      for (const fileId of driveFileIdsOf(full)) candidates.add(fileId);
      bodiesToExpand.delete(bodyId);
    } catch { /* keep body + expansion request pending; do not orphan its hidden files */ }
  }
  await writePendingCleanup(candidates, bodiesToExpand);

  const referenced = new Set();
  const stubBodies = []; // over-cap notes hide their attachments INSIDE their Drive body file
  try {
    const root = await bm.ensureRoot();
    for (const r of await bm.allNotes(root)) { // every synced note (all folders incl. Trash)
      let note; try { note = await decode(r.payload); } catch { continue; }
      for (const f of driveFileIdsOf(note)) referenced.add(f);
      if (note._driveBody) stubBodies.push(note._driveBody);
    }
    for (const n of await mirror.allBackups()) for (const f of driveFileIdsOf(n)) referenced.add(f); // + local-only notes
  } catch {
    return { deleted: 0, pending: candidates.size };
  }

  // A candidate not yet accounted for MIGHT live inside an over-cap note's Drive body. Fetch
  // and decode those bodies so we never delete a file a stub note still needs. If a body can't
  // be read we can't be sure — abort the whole pass (leak, never lose).
  if (stubBodies.length && [...candidates].some((f) => !referenced.has(f))) {
    for (const bodyId of stubBodies) {
      let full; try { full = await loadNoteBody(bodyId); } catch {
        return { deleted: 0, pending: candidates.size };
      }
      try { for (const f of driveFileIdsOf(await decode(full))) referenced.add(f); } catch {
        return { deleted: 0, pending: candidates.size };
      }
    }
  }

  let deleted = 0;
  for (const fileId of [...candidates]) {
    // A body that could not be decoded is the only remaining index of its attachment ids.
    if (bodiesToExpand.has(fileId)) continue;
    if (referenced.has(fileId)) {
      candidates.delete(fileId);
      continue;
    }
    try {
      await deleteFile(fileId);
      candidates.delete(fileId);
      deleted += 1;
    } catch (err) {
      // A prior attempt may have deleted the file but closed before clearing the checkpoint.
      if (/\b404\b/.test(String(err?.message || err))) candidates.delete(fileId);
      else console.warn('[owl-note] Drive cleanup: failed to delete', fileId, err);
    }
  }
  await writePendingCleanup(candidates, bodiesToExpand);
  return { deleted, pending: candidates.size };
}

let cleanupQueue = Promise.resolve();

export function deleteUnreferencedFiles(candidateFileIds = [], options = {}) {
  const task = cleanupQueue.then(() => runDeleteUnreferencedFiles(candidateFileIds, options));
  cleanupQueue = task.catch(() => {});
  return task;
}

export function retryPendingDriveCleanup() {
  return deleteUnreferencedFiles([]);
}
