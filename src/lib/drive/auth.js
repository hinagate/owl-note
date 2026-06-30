import { OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, TOKEN_ENDPOINT } from './config.js';
import { tokenRefreshBody } from './pkce.js';

const TOKENS = 'drive:tokens';
const SKEW_MS = 60000; // refresh a minute early

function needsAuth(msg) { const e = new Error(msg || 'Drive not connected'); e.name = 'NeedsAuth'; return e; }

async function readTokens() {
  return (await chrome.storage.local.get(TOKENS))[TOKENS] || null;
}
async function writeTokens(t) {
  await chrome.storage.local.set({ [TOKENS]: t });
}

export async function isConnected() {
  const t = await readTokens();
  return !!(t && t.refreshToken);
}

async function refresh(t) {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenRefreshBody({ clientId: OAUTH_CLIENT_ID, clientSecret: OAUTH_CLIENT_SECRET, refreshToken: t.refreshToken }),
  });
  if (!res.ok) throw needsAuth('Drive token refresh failed');
  const j = await res.json();
  const next = { refreshToken: t.refreshToken, accessToken: j.access_token, expiresAt: Date.now() + (j.expires_in || 3600) * 1000 };
  await writeTokens(next);
  return next.accessToken;
}

export async function getAccessToken() {
  const t = await readTokens();
  if (!t || !t.refreshToken) throw needsAuth();
  if (t.accessToken && t.expiresAt - SKEW_MS > Date.now()) return t.accessToken;
  return refresh(t);
}
