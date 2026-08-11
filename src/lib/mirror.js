// src/lib/mirror.js
import { exportKeyring, importKeyring } from './note-key.js';

const KEY = (id) => `note:${id}`;

export async function saveBackup(note, opts = {}) {
  const existing = (await chrome.storage.local.get(KEY(note.id)))[KEY(note.id)];
  const previous = existing ? existing.current : null;
  const folderId = opts.folderId ?? (existing ? existing.folderId : undefined);
  const localOnly = opts.localOnly ?? (existing ? !!existing.localOnly : false);
  await chrome.storage.local.set({ [KEY(note.id)]: { current: note, previous, folderId, localOnly } });
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

// The keyring rides along in the backup. Before encryption, wiping the extension lost
// nothing — the notes were still sitting in the bookmark tree, readable on reinstall.
// Now those surviving bookmarks are ciphertext, so the key is the difference between a
// recoverable profile and an unreadable one. Re-importing the notes alone would create
// fresh duplicates beside bookmarks that stay locked; the keys unlock them in place.
// This adds no exposure: the file already contains every note in plaintext.
export async function exportAll() {
  return JSON.stringify({ version: 1, notes: await allBackups(), keyring: await exportKeyring() }, null, 2);
}

export async function importAll(jsonString) {
  const data = JSON.parse(jsonString);
  const notes = (Array.isArray(data.notes) ? data.notes : []).filter((n) => n && typeof n.id === 'string');
  for (const n of notes) await saveBackup(n);
  // Older backups predate the keyring; a missing field is normal, not an error.
  let keysAdded = 0;
  if (data.keyring) { try { keysAdded = await importKeyring(data.keyring); } catch { /* never fail an import over keys */ } }
  return { imported: notes.length, notes, keysAdded };
}

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

export async function isLocalOnly(id) {
  const e = (await chrome.storage.local.get(KEY(id)))[KEY(id)];
  return !!(e && e.localOnly);
}

export async function setFolder(id, folderId) {
  const e = (await chrome.storage.local.get(KEY(id)))[KEY(id)];
  if (!e) return;
  await chrome.storage.local.set({ [KEY(id)]: { ...e, folderId, localOnly: true } });
}
