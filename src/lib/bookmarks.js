// src/lib/bookmarks.js
export const ROOT_TITLE = '📓 Notes';
// Stock Chrome uses '2' for the permanent "Other Bookmarks" folder, but the id is
// assigned per-profile and other Chromium browsers (Edge, Brave, …) and some
// profiles differ. Used only as a last-resort fallback — see getOtherBookmarksId().
export const OTHER_BOOKMARKS_ID = '2';

export function buildNoteUrl(payload) {
  return `chrome-extension://${chrome.runtime.id}/app.html#${payload}`;
}

// Match a note URL for ANY extension id (Chrome ids are 32 chars, a–p). A bookmark
// written by a different build — an unpacked dev build vs the published store build,
// or a reinstall under a new id — embeds a different id, but the payload after
// `app.html#` is identical. Matching id-agnostically keeps notes recognizable no
// matter which build created them; healNoteUrls() then rewrites them to the
// current id so clicking opens this extension instead of being blocked by Chrome.
const NOTE_URL_RE = /^chrome-extension:\/\/[a-p]{32}\/app\.html#([\s\S]*)$/;

export function isNoteUrl(url) {
  return typeof url === 'string' && NOTE_URL_RE.test(url);
}

export function payloadFromUrl(url) {
  const m = typeof url === 'string' ? NOTE_URL_RE.exec(url) : null;
  return m ? m[1] : null;
}

// Resolve the "Other Bookmarks" folder id at runtime rather than hardcoding it,
// or boot fails with Chrome's "Can't find bookmark for id." on browsers/profiles
// where that permanent folder isn't id '2'.
export async function getOtherBookmarksId() {
  const [treeRoot] = await chrome.bookmarks.getTree();
  const roots = (treeRoot && treeRoot.children) || [];
  // Chrome 134+ tags permanent roots with folderType; prefer the canonical one.
  const byType = roots.find((r) => r.folderType === 'other');
  if (byType) return byType.id;
  // Legacy fallback: layout order is [Bookmarks Bar, Other Bookmarks, …].
  return (roots[1] || roots[0] || { id: OTHER_BOOKMARKS_ID }).id;
}

// Where the resolved root folder id is remembered. Persisting it lets the app
// follow the folder if the user moves it (ids are stable across moves) instead
// of creating a duplicate. storage.local (not sync) on purpose: bookmark ids
// differ per device for the same synced folder, so each device records its own.
export const ROOT_ID_KEY = 'owl:rootId';

// Depth-first search the whole bookmark tree for the first folder titled `title`.
async function findFolderByTitle(title) {
  const [tree] = await chrome.bookmarks.getTree();
  let found = null;
  (function walk(node) {
    for (const c of node.children || []) {
      if (c.url) continue; // skip bookmarks; we only want folders
      if (!found && c.title === title) found = c.id;
      walk(c);
    }
  })(tree);
  return found;
}

export async function ensureRoot() {
  // 1. Follow the folder we recorded last time, wherever the user has since
  //    moved it (Bookmarks bar, a subfolder, …) — moving never changes its id.
  const stored = (await chrome.storage.local.get(ROOT_ID_KEY))[ROOT_ID_KEY];
  if (stored) {
    try {
      const [node] = await chrome.bookmarks.get(stored);
      if (node && !node.url) return stored; // still a live folder — done
    } catch {
      /* recorded folder was deleted — fall through to rediscover/recreate */
    }
  }
  // 2. Re-adopt an existing "📓 Notes" folder anywhere in the tree. Handles
  //    cleared storage and synced profiles whose ids differ from this device's.
  let id = await findFolderByTitle(ROOT_TITLE);
  // 3. Nothing exists yet — create it in Other Bookmarks (least intrusive).
  if (!id) {
    const otherId = await getOtherBookmarksId();
    const created = await chrome.bookmarks.create({ parentId: otherId, title: ROOT_TITLE });
    id = created.id;
  }
  await chrome.storage.local.set({ [ROOT_ID_KEY]: id });
  return id;
}

export async function listNotebooks(rootId) {
  const out = [];
  async function walk(id) {
    for (const c of await chrome.bookmarks.getChildren(id)) {
      if (!c.url) {
        out.push({ id: c.id, title: c.title, parentId: c.parentId });
        await walk(c.id);
      }
    }
  }
  await walk(rootId);
  return out;
}

export async function listNotes(folderId) {
  const children = await chrome.bookmarks.getChildren(folderId);
  return children
    .filter((c) => isNoteUrl(c.url))
    .map((c) => ({ bookmarkId: c.id, title: c.title, url: c.url, payload: payloadFromUrl(c.url), dateAdded: c.dateAdded }));
}

export async function allNotes(rootId) {
  const out = [];
  async function walk(id) {
    for (const c of await chrome.bookmarks.getChildren(id)) {
      if (c.url) {
        if (isNoteUrl(c.url)) out.push({ bookmarkId: c.id, folderId: id, title: c.title, url: c.url, payload: payloadFromUrl(c.url), dateAdded: c.dateAdded });
      } else {
        await walk(c.id);
      }
    }
  }
  await walk(rootId);
  return out;
}

export async function createNote(folderId, title, payload) {
  const node = await chrome.bookmarks.create({ parentId: folderId, title, url: buildNoteUrl(payload) });
  return node.id;
}

export async function updateNote(bookmarkId, title, payload) {
  await chrome.bookmarks.update(bookmarkId, { title, url: buildNoteUrl(payload) });
}

// Rewrite note bookmarks whose URL embeds a different extension id (e.g. notes
// created by an unpacked dev build, then opened in the published store build) to
// the current runtime id, so clicking them opens this extension instead of hitting
// Chrome's "blocked / ERR_BLOCKED_BY_CLIENT". Returns how many were healed; safe to
// run on every startup (a no-op once all notes already use the current id).
export async function healNoteUrls(rootId) {
  const prefix = `chrome-extension://${chrome.runtime.id}/app.html#`;
  let healed = 0;
  for (const r of await allNotes(rootId)) {
    if (typeof r.url === 'string' && !r.url.startsWith(prefix)) {
      const payload = payloadFromUrl(r.url);
      if (payload != null) { await updateNote(r.bookmarkId, r.title, payload); healed += 1; }
    }
  }
  return healed;
}

export async function moveNote(bookmarkId, folderId) {
  await chrome.bookmarks.move(bookmarkId, { parentId: folderId });
}

// Re-parent a notebook folder (used by drag-to-re-nest in the sidebar).
export async function moveNotebook(id, parentId) {
  await chrome.bookmarks.move(id, { parentId });
}

export async function deleteNote(bookmarkId) {
  await chrome.bookmarks.remove(bookmarkId);
}

export async function createNotebook(parentId, title) {
  const node = await chrome.bookmarks.create({ parentId, title });
  return node.id;
}

export async function renameFolder(id, title) {
  await chrome.bookmarks.update(id, { title });
}

export async function deleteFolder(id) {
  await chrome.bookmarks.removeTree(id);
}
