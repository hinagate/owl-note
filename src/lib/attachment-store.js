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
