// src/lib/copied-attachments.js
// The attachments behind the owl-img/owl-file references last copied or cut out of a
// note. A reference carries only an id, and cutting one out of a note drops the note's
// own copy of the bytes on its next save — so a paste into another note found nothing
// to recover the image from. Kept like a clipboard: the latest copy replaces the last,
// in memory for this page and in local storage for another OWL-Note page (a second
// tab, the side panel). Ids are content hashes, so an entry can never stand for a
// different file than the reference that asks for it.
const KEY = 'owl:copied-attachments';

let latest = [];

export function rememberCopiedAttachments(attachments) {
  latest = (attachments || []).filter(Boolean);
  try {
    Promise.resolve(chrome.storage.local.set({ [KEY]: latest })).catch(() => { /* this page still has them */ });
  } catch { /* no extension storage (tests) — this page still has them */ }
}

// Bytes fetched after the copy (a Drive file the page had not downloaded) fill in its
// entry — unless a newer copy has replaced it meanwhile.
export function addCopiedBytes(id, dataUri) {
  if (!dataUri || !latest.some((a) => a.id === id && !a.dataUri)) return;
  rememberCopiedAttachments(latest.map((a) => (a.id === id && !a.dataUri ? { ...a, dataUri } : a)));
}

export async function copiedAttachments() {
  let stored = [];
  try { stored = (await chrome.storage.local.get(KEY))[KEY] || []; } catch { /* best-effort */ }
  return [...latest, ...(Array.isArray(stored) ? stored : [])];
}

export function _resetCopiedAttachments() { latest = []; }
