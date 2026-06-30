import { OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, TOKEN_ENDPOINT } from './config.js';
import { tokenRefreshBody, createPkce, buildAuthUrl, tokenExchangeBody } from './pkce.js';
import { DRIVE_SCOPE } from './config.js';

const TOKENS = 'drive:tokens';
const SKEW_MS = 60000; // refresh a minute early

function needsAuth(msg) { const e = new Error(msg || 'Drive not connected'); e.name = 'NeedsAuth'; return e; }

function assertConfigured() {
  if (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET) {
    throw needsAuth('Google Drive OAuth is not configured. Add .drive-credentials.json and rebuild.');
  }
}

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
  assertConfigured();
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

function codeFromRedirect(redirectUrl) {
  const u = new URL(redirectUrl);
  const code = u.searchParams.get('code');
  if (!code) throw needsAuth('No authorization code returned');
  return code;
}

export async function connect() {
  assertConfigured();
  const redirectUri = chrome.identity.getRedirectURL();
  const { verifier, challenge } = await createPkce();
  const url = buildAuthUrl({ clientId: OAUTH_CLIENT_ID, redirectUri, scope: DRIVE_SCOPE, challenge });
  const redirectUrl = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
  const code = codeFromRedirect(redirectUrl);
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenExchangeBody({ clientId: OAUTH_CLIENT_ID, clientSecret: OAUTH_CLIENT_SECRET, code, verifier, redirectUri }),
  });
  if (!res.ok) throw needsAuth('Drive token exchange failed');
  const j = await res.json();
  if (!j.refresh_token) throw needsAuth('No refresh token (publish the consent screen to Production)');
  await writeTokens({ refreshToken: j.refresh_token, accessToken: j.access_token, expiresAt: Date.now() + (j.expires_in || 3600) * 1000 });
}

export async function disconnect() {
  await chrome.storage.local.remove(TOKENS);
}
