// src/lib/drive-gc.js — remove Drive files that no note references anymore.
// Attachments are de-duplicated by content hash (identical images/files share ONE Drive
// file), so a file is only deleted when NO surviving note — bookmark OR local mirror —
// still points at it. Used by the save path (a removed attachment) and by deleteForever.
import * as bm from './bookmarks.js';
import * as mirror from './mirror.js';
import { decode } from './codec.js';
import { deleteFile } from './drive/client.js';
import { loadNoteBody } from './note-drive.js';

// A note's Drive files: its over-cap body file and any image/file attachment files.
export function driveFileIdsOf(note) {
  const ids = [];
  if (note && note._driveBody) ids.push(note._driveBody);
  for (const a of (note && note.attachments) || []) if (a && a.driveFileId) ids.push(a.driveFileId);
  return ids;
}

// Delete each candidate Drive file that no note still references. Best-effort per file; a
// tree-read failure aborts the whole pass (better to leak a file than delete a live one).
export async function deleteUnreferencedFiles(candidateFileIds) {
  const candidates = [...new Set(candidateFileIds)].filter(Boolean);
  if (!candidates.length) return;
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
  } catch { return; }

  // A candidate not yet accounted for MIGHT live inside an over-cap note's Drive body. Fetch
  // and decode those bodies so we never delete a file a stub note still needs. If a body can't
  // be read we can't be sure — abort the whole pass (leak, never lose).
  if (stubBodies.length && candidates.some((f) => !referenced.has(f))) {
    for (const bodyId of stubBodies) {
      let full; try { full = await loadNoteBody(bodyId); } catch { return; }
      try { for (const f of driveFileIdsOf(await decode(full))) referenced.add(f); } catch { return; }
    }
  }

  for (const f of candidates) {
    if (referenced.has(f)) continue;
    try { await deleteFile(f); } catch (err) { console.warn('[owl-note] Drive cleanup: failed to delete', f, err); }
  }
}
