import { connect, disconnect } from './drive/auth.js';
import { ensureFolder } from './drive/client.js';

const ENABLED = 'drive:enabled';
const ORIGINS = ['https://www.googleapis.com/*', 'https://oauth2.googleapis.com/*'];

export async function isEnabled() {
  return !!(await chrome.storage.local.get(ENABLED))[ENABLED];
}

export async function enable() {
  const granted = await chrome.permissions.request({ origins: ORIGINS });
  if (!granted) throw new Error('Google API access was not granted');
  await connect(); // interactive consent; throws if cancelled (flag stays false)
  await chrome.storage.local.set({ [ENABLED]: true });
  // Create the Drive folder now so it's visible immediately; otherwise it's made lazily
  // on the first upload. Best-effort — the lazy path still covers a transient failure here.
  try { await ensureFolder(); } catch { /* created later on first upload */ }
}

export async function disable() {
  await chrome.storage.local.set({ [ENABLED]: false });
  await disconnect();
}
