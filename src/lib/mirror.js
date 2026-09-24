// src/lib/mirror.js
const KEY = (id) => `note:${id}`;

export async function saveBackup(note, opts = {}) {
  const existing = (await chrome.storage.local.get(KEY(note.id)))[KEY(note.id)];
  const previous = existing ? existing.current : null;
  const folderId = opts.folderId ?? (existing ? existing.folderId : undefined);
  const localOnly = opts.localOnly ?? (existing ? !!existing.localOnly : false);
  const entry = { current: note, previous, folderId, localOnly };
  // Only a new note's first write sets this, and every later write rebuilds the entry
  // without it — so a marker still present long afterwards means the save never finished.
  if ('pendingFolderId' in opts) entry.pending = { folderId: opts.pendingFolderId, at: Date.now() };
  await chrome.storage.local.set({ [KEY(note.id)]: entry });
}

export async function getBackup(id) {
  return (await chrome.storage.local.get(KEY(id)))[KEY(id)] || null;
}

export async function removeBackup(id) {
  await chrome.storage.local.remove(KEY(id));
}

async function allEntries() {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all).filter(([k]) => k.startsWith('note:')).map(([, v]) => v);
}

export async function allBackups() {
  return (await allEntries()).map((e) => e.current);
}

export async function healMissing(existingIds) {
  return (await allBackups()).filter((n) => !existingIds.has(n.id));
}

// exportAll/importAll used to live here and have been removed. exportAll collected
// notes from THIS object — the local mirror — which only holds what this device
// saved itself, so every note synced in from another device was silently absent
// from a file people reasonably treated as a complete backup. The Markdown export
// reads the bookmark tree instead and is complete; the keys ship separately as a
// recovery-key file. Nothing should reconstruct a note backup from the mirror.

export async function localOnlyBackups(folderId) {
  return (await allEntries())
    .filter((e) => e.localOnly && e.folderId === folderId)
    .map((e) => ({ ...e.current, bookmarkId: null, localOnly: true, folderId: e.folderId }));
}

// Every device-local note (with its folderId), for callers that must include
// non-bookmark notes — e.g. the Markdown export, so image notes aren't lost.
export async function allLocalOnly() {
  return (await allEntries())
    .filter((e) => e.localOnly)
    .map((e) => ({ ...e.current, folderId: e.folderId }));
}

// A save cut off before its bookmark existed — the service worker stopped during a slow
// Drive upload — leaves the new note's first copy complete, full-size, and listed nowhere.
//
// Saves now mark that copy `pending` (see saveBackup). It counts as abandoned only once
// it is older than any live save can run: every Drive request has a deadline and the
// worker's keep-alive gives up at 20 minutes, so 30 is safely past both. Filing a copy
// whose save is still running would let the user edit it into a duplicate.
export const PENDING_GRACE_MS = 30 * 60_000;

// Copies from before the marker existed get a stricter test, because nothing records
// their intent. A note synced in from another device arrives through a bookmark, so it
// can carry no more inline bytes than a bookmark holds; an already-compressed image
// (JPEG/PNG/WebP/GIF data does not deflate further) larger than `minInlineChars`
// therefore proves the copy was made on this device. `previous: null` means the save
// that wrote it never reached its second write, and no folder means nothing filed it.
const PRECOMPRESSED_IMAGE = /^data:image\/(?:jpeg|png|webp|gif);base64,/i;

export function isStrandedCopy(entry, { minInlineChars, now = Date.now(), graceMs = PENDING_GRACE_MS } = {}) {
  if (!entry || entry.localOnly || !entry.current || !entry.current.id) return false;
  if (entry.pending) return now - (Number(entry.pending.at) || 0) > graceMs;
  if (entry.folderId != null || entry.previous !== null) return false;
  return (entry.current.attachments || []).some((a) => typeof a?.dataUri === 'string'
    && a.dataUri.length > minInlineChars && PRECOMPRESSED_IMAGE.test(a.dataUri));
}

// File every stranded copy as a device-local note. `folderFor(pendingFolderId)` picks
// its notebook (the one it was being saved to, when that still exists). A copy whose
// bookmark DID get made lost only its last write: it is already listed, so it just
// sheds the marker. `bookmarkedIds` is only asked for when there is a candidate, since
// listing it means reading every bookmark. Returns how many notes came back.
export async function recoverStrandedNotes({ folderFor, bookmarkedIds, minInlineChars, now = Date.now(), graceMs = PENDING_GRACE_MS }) {
  const all = await chrome.storage.local.get(null);
  const candidates = Object.entries(all)
    .filter(([k, e]) => k.startsWith('note:') && isStrandedCopy(e, { minInlineChars, now, graceMs }));
  if (!candidates.length) return 0;
  const listed = await bookmarkedIds();
  const updates = {};
  let recovered = 0;
  for (const [k, e] of candidates) {
    const { pending, ...rest } = e;
    if (listed.has(e.current.id)) {
      if (pending) updates[k] = rest;
      continue;
    }
    updates[k] = { ...rest, folderId: await folderFor(pending?.folderId), localOnly: true };
    recovered += 1;
  }
  if (Object.keys(updates).length) await chrome.storage.local.set(updates);
  return recovered;
}

export async function isLocalOnly(id) {
  const e = (await chrome.storage.local.get(KEY(id)))[KEY(id)];
  return !!(e && e.localOnly);
}

export async function setFolder(id, folderId) {
  const e = (await chrome.storage.local.get(KEY(id)))[KEY(id)];
  if (!e) return;
  await chrome.storage.local.set({ [KEY(id)]: { ...e, folderId, localOnly: true } });
}
