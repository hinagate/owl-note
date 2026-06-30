import { getAccessToken } from './auth.js';
import { DRIVE_FILES_URL, DRIVE_UPLOAD_URL, ATTACH_FOLDER_NAME, MAX_ATTACH_BYTES } from './config.js';

const FOLDER_KEY = 'drive:folderId';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

async function authedFetch(url, opts = {}) {
  const token = await getAccessToken();
  const headers = { ...(opts.headers || {}), Authorization: `Bearer ${token}` };
  const res = await fetch(url, { ...opts, headers });
  if (!res.ok) throw new Error(`Drive API ${res.status} for ${url}`);
  return res;
}

export async function ensureFolder() {
  const cached = (await chrome.storage.local.get(FOLDER_KEY))[FOLDER_KEY];
  if (cached) return cached;
  // Find an existing folder by name (app-created; drive.file list is auto-scoped to our files).
  const q = encodeURIComponent(`mimeType='${FOLDER_MIME}' and name='${ATTACH_FOLDER_NAME}' and trashed=false`);
  const found = await (await authedFetch(`${DRIVE_FILES_URL}?q=${q}&fields=files(id)`)).json();
  let id = found.files && found.files[0] && found.files[0].id;
  if (!id) {
    const created = await (await authedFetch(DRIVE_FILES_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: ATTACH_FOLDER_NAME, mimeType: FOLDER_MIME }),
    })).json();
    id = created.id;
  }
  await chrome.storage.local.set({ [FOLDER_KEY]: id });
  return id;
}

export async function findByHash(hash) {
  const q = encodeURIComponent(`appProperties has { key='owlHash' and value='${hash}' } and trashed=false`);
  const res = await (await authedFetch(`${DRIVE_FILES_URL}?q=${q}&fields=files(id)`)).json();
  return (res.files && res.files[0] && res.files[0].id) || null;
}

export async function uploadFile({ name, mime, bytes, hash }) {
  if (bytes.length > MAX_ATTACH_BYTES) throw new Error(`Attachment too large (max ${MAX_ATTACH_BYTES} bytes)`);
  const folderId = await ensureFolder();
  const meta = { name, mimeType: mime, parents: [folderId], appProperties: { owlHash: hash } };
  const boundary = 'owlnote' + hash;
  const enc = new TextEncoder();
  const head = enc.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
    `--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`,
  );
  const tail = enc.encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head, 0); body.set(bytes, head.length); body.set(tail, head.length + bytes.length);
  const res = await (await authedFetch(`${DRIVE_UPLOAD_URL}?uploadType=multipart&fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  })).json();
  return res.id;
}

export { authedFetch };
