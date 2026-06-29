// src/lib/trash.js — move notes to a recoverable Trash folder under the OWL root.
import * as bm from './bookmarks.js';
import * as mirror from './mirror.js';

const TRASH_TITLE = '🗑 Trash';
const TRASH_ID_KEY = 'owl:trash-id';
const ORIGIN_KEY = 'owl:trash-origins';

export async function ensureTrash(rootId) {
  const stored = (await chrome.storage.local.get(TRASH_ID_KEY))[TRASH_ID_KEY];
  if (stored) {
    try { const [n] = await chrome.bookmarks.get(stored); if (n && !n.url) return stored; } catch { /* recreate */ }
  }
  for (const c of await chrome.bookmarks.getChildren(rootId)) {
    if (!c.url && c.title === TRASH_TITLE) { await chrome.storage.local.set({ [TRASH_ID_KEY]: c.id }); return c.id; }
  }
  const id = await bm.createNotebook(rootId, TRASH_TITLE);
  await chrome.storage.local.set({ [TRASH_ID_KEY]: id });
  return id;
}

async function getOrigins() { return (await chrome.storage.local.get(ORIGIN_KEY))[ORIGIN_KEY] || {}; }
async function setOrigins(m) { await chrome.storage.local.set({ [ORIGIN_KEY]: m }); }

export async function trashNotes(notes, trashId) {
  const origins = await getOrigins();
  for (const n of notes) {
    if (!n || n.draft) continue;
    origins[n.id] = n.folderId;
    if (n.bookmarkId) await bm.moveNote(n.bookmarkId, trashId);
    else await mirror.setFolder(n.id, trashId);
  }
  await setOrigins(origins);
}

export async function restoreNotes(notes, rootId) {
  const origins = await getOrigins();
  for (const n of notes) {
    let dest = origins[n.id] || rootId;
    try { const [f] = await chrome.bookmarks.get(dest); if (!f || f.url) dest = rootId; } catch { dest = rootId; }
    if (n.bookmarkId) await bm.moveNote(n.bookmarkId, dest);
    else await mirror.setFolder(n.id, dest);
    delete origins[n.id];
  }
  await setOrigins(origins);
}

export async function deleteForever(notes) {
  const origins = await getOrigins();
  for (const n of notes) {
    if (n.bookmarkId) await bm.deleteNote(n.bookmarkId);
    await mirror.removeBackup(n.id);
    delete origins[n.id];
  }
  await setOrigins(origins);
}
