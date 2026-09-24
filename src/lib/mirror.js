// src/lib/mirror.js
import { deflatedLength } from './codec.js';

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

// A save cut off before its bookmark existed — the service worker stopped mid-upload, a
// browser crash — leaves the new note's first copy complete, full-size, and listed nowhere.
//
// Saves mark that copy `pending` (see saveBackup). When the service worker knows the
// saving worker died, it files the note at once (fileAbandonedSave). Otherwise a pending
// copy counts as abandoned only once it is older than any live save can run: the slowest
// bounded save takes about 50 minutes and the worker's keep-alive gives up at 60, so 90
// is safely past both. Filing a copy whose save is still running would let the user
// edit it into a duplicate.
export const PENDING_GRACE_MS = 90 * 60_000;

// Copies stranded before the marker existed carry no record of intent, so they must
// prove they were made on this device. A note synced in from another device arrived
// through a bookmark, and no build ever wrote a bookmark payload over 64 KB (sync drops
// anything past about 8 KB), so a note that deflates to four times that cannot have come
// from another device. The length of a data URI proves nothing: a blank or half-painted
// page captures as a JPEG that deflates twentyfold and syncs as an ordinary bookmark.
export const LEGACY_MIN_DEFLATED_BYTES = 4 * 65536;
const INLINE_IMAGE = /^data:image\//i;

const withoutPending = ({ pending, ...rest }) => rest;

// The cheap test: 'pending', 'legacy', or null. A legacy match must still prove its size.
export function strandedKind(entry, { now = Date.now(), graceMs = PENDING_GRACE_MS } = {}) {
  if (!entry || entry.localOnly || !entry.current || !entry.current.id) return null;
  if (entry.pending) return now - (Number(entry.pending.at) || 0) > graceMs ? 'pending' : null;
  if (entry.folderId != null || entry.previous !== null) return null;
  const hasImage = (entry.current.attachments || []).some((a) => typeof a?.dataUri === 'string' && INLINE_IMAGE.test(a.dataUri));
  return hasImage ? 'legacy' : null;
}

async function madeOnThisDevice(note, minDeflatedBytes) {
  return (await deflatedLength(JSON.stringify(note))) > minDeflatedBytes;
}

// Recovery writes only after slow work (reading every bookmark), and anything that saved
// the entry in the meantime owns it now. Write only if it is still the copy judged.
function unchanged(fresh, judged) {
  if (!fresh || fresh.localOnly) return false;
  if (judged.pending) return fresh.pending?.at === judged.pending.at;
  return !fresh.pending && fresh.previous === null && fresh.folderId == null
    && fresh.current?.updated === judged.current.updated && fresh.current?.version === judged.current.version;
}

// File every stranded copy as a device-local note. `folderFor(pendingFolderId)` picks
// its notebook (the one it was being saved to, when that still exists). A copy whose
// bookmark DID get made lost only its last write: it is already listed, so it just
// sheds the marker. `bookmarkedIds` is only asked for when there is a candidate, since
// listing it means reading every bookmark. Legacy copies are only considered when
// `includeLegacy` is set: saves no longer create them, so one pass finds them all.
// Returns how many notes came back.
export async function recoverStrandedNotes({
  folderFor, bookmarkedIds, includeLegacy = false, minDeflatedBytes = LEGACY_MIN_DEFLATED_BYTES,
  now = Date.now(), graceMs = PENDING_GRACE_MS,
}) {
  const all = await chrome.storage.local.get(null);
  const candidates = [];
  for (const [k, e] of Object.entries(all)) {
    if (!k.startsWith('note:')) continue;
    const kind = strandedKind(e, { now, graceMs });
    if (kind === 'pending' || (kind === 'legacy' && includeLegacy && await madeOnThisDevice(e.current, minDeflatedBytes))) {
      candidates.push([k, e]);
    }
  }
  if (!candidates.length) return 0;
  const listed = await bookmarkedIds();
  let recovered = 0;
  for (const [k, e] of candidates) {
    const isListed = listed.has(e.current.id);
    if (isListed && !e.pending) continue;
    const next = isListed
      ? withoutPending(e)
      : { ...withoutPending(e), folderId: await folderFor(e.pending?.folderId), localOnly: true };
    const fresh = (await chrome.storage.local.get(k))[k];
    if (!unchanged(fresh, e)) continue;
    await chrome.storage.local.set({ [k]: next });
    if (!isListed) recovered += 1;
  }
  return recovered;
}

// The worker that was saving `id` is known to be gone (its capture marker outlived it),
// so this copy needs no grace period: nothing else is saving a note no list has shown.
// Returns true if the note was filed as device-local.
export async function fileAbandonedSave(id, { bookmarkedIds, folderFor }) {
  const k = KEY(id);
  const entry = (await chrome.storage.local.get(k))[k];
  if (!entry || !entry.pending || entry.localOnly) return false;
  const isListed = (await bookmarkedIds()).has(id);
  const next = isListed
    ? withoutPending(entry)
    : { ...withoutPending(entry), folderId: await folderFor(entry.pending.folderId), localOnly: true };
  const fresh = (await chrome.storage.local.get(k))[k];
  if (!unchanged(fresh, entry)) return false;
  await chrome.storage.local.set({ [k]: next });
  return !isListed;
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
