import { getAccessToken } from './auth.js';
import { DRIVE_FILES_URL, DRIVE_UPLOAD_URL, ATTACH_FOLDER_NAME } from './config.js';

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

export { authedFetch };
