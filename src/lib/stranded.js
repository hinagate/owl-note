// src/lib/stranded.js
// What the app and the service worker both need to file a stranded save (see
// mirror.recoverStrandedNotes and mirror.fileAbandonedSave).
import * as bm from './bookmarks.js';
import { noteIdOf } from './codec.js';

// Every note id that has a bookmark, Trash included. Read from the payload envelope, so
// it works for notes sealed with a key this installation does not hold.
export async function bookmarkedNoteIds(rootId) {
  const ids = new Set();
  for (const r of await bm.allNotes(rootId)) {
    try {
      const id = await noteIdOf(r.payload);
      if (id) ids.add(id);
    } catch { /* a malformed payload names no note */ }
  }
  return ids;
}

// The notebook a save was headed for, if the user has not deleted it since.
export async function liveFolderOr(rootId, folderId) {
  if (!folderId) return rootId;
  try {
    const [node] = await chrome.bookmarks.get(folderId);
    return node && !node.url ? folderId : rootId;
  } catch {
    return rootId;
  }
}
