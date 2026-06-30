import * as client from './drive/client.js';

const cacheKey = (id) => `owlcache:${id}`;
const MAP_KEY = 'drive:map';

export function mimeFromDataUri(dataUri) {
  const m = /^data:([^;,]+)[;,]/.exec(String(dataUri || ''));
  return (m && m[1]) || 'application/octet-stream';
}

export function dataUriToBytes(dataUri) {
  const i = String(dataUri).indexOf(',');
  const b64 = dataUri.slice(i + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) out[k] = bin.charCodeAt(k);
  return out;
}

export function bytesToDataUri(bytes, mime) {
  let bin = '';
  for (let k = 0; k < bytes.length; k++) bin += String.fromCharCode(bytes[k]);
  return `data:${mime};base64,${btoa(bin)}`;
}

async function rememberFile(hash, fileId) {
  const map = (await chrome.storage.local.get(MAP_KEY))[MAP_KEY] || {};
  map[hash] = fileId;
  await chrome.storage.local.set({ [MAP_KEY]: map });
}

export async function putAttachment(att) {
  if (att.driveFileId && !att.dataUri) {
    return { id: att.id, name: att.name, mime: att.mime || 'application/octet-stream', driveFileId: att.driveFileId };
  }
  const mime = att.mime || mimeFromDataUri(att.dataUri);
  let fileId = await client.findByHash(att.id);
  if (!fileId) {
    fileId = await client.uploadFile({ name: att.name, mime, bytes: dataUriToBytes(att.dataUri), hash: att.id });
  }
  await rememberFile(att.id, fileId);
  await chrome.storage.local.set({ [cacheKey(att.id)]: att.dataUri }); // keep origin device's bytes for instant display
  return { id: att.id, name: att.name, mime, driveFileId: fileId };
}

export async function getBytes(att) {
  if (att.dataUri) return att.dataUri;
  const cached = (await chrome.storage.local.get(cacheKey(att.id)))[cacheKey(att.id)];
  if (cached) return cached;
  let fileId = att.driveFileId;
  if (!fileId) {
    const map = (await chrome.storage.local.get(MAP_KEY))[MAP_KEY] || {};
    fileId = map[att.id];
  }
  if (!fileId) return null;
  try {
    const bytes = await client.getMedia(fileId);
    const uri = bytesToDataUri(bytes, att.mime || 'application/octet-stream');
    await chrome.storage.local.set({ [cacheKey(att.id)]: uri });
    return uri;
  } catch {
    return null; // offline / revoked / deleted — caller shows a placeholder
  }
}

export async function offloadNote(note) {
  const enabled = (await chrome.storage.local.get('drive:enabled'))['drive:enabled'];
  if (!enabled) return note;
  const atts = note.attachments || [];
  if (!atts.some((a) => a.dataUri)) return note; // nothing to offload
  try {
    const next = [];
    for (const a of atts) next.push(await putAttachment(a));
    return { ...note, attachments: next };
  } catch {
    return note; // any failure -> leave inline so the note stays device-local (today's behavior)
  }
}

// PURE — no network. The note's shape AFTER offload, for the live size meter only:
// each attachment with bytes becomes a reference-sized stand-in (a ~33-char fake
// fileId matches a real Drive id's length) so the meter shows what WOULD sync,
// without uploading anything on every keystroke.
export function offloadShape(note) {
  const atts = note.attachments || [];
  if (!atts.some((a) => a.dataUri)) return note;
  return {
    ...note,
    attachments: atts.map((a) => (a.dataUri
      ? { id: a.id, name: a.name, mime: a.mime || 'application/octet-stream', driveFileId: a.driveFileId || 'x'.repeat(33) }
      : a)),
  };
}
