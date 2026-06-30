import { bytesToBase64url } from '../base64url.js';

function randomVerifier() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToBase64url(bytes); // base64url, no padding -> valid PKCE verifier
}

export async function createPkce() {
  const verifier = randomVerifier();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: bytesToBase64url(new Uint8Array(digest)) };
}

export function buildAuthUrl({ clientId, redirectUri, scope, challenge }) {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope,
    access_type: 'offline',
    prompt: 'consent',
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + q.toString();
}

export function tokenExchangeBody({ clientId, clientSecret, code, verifier, redirectUri }) {
  return new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  }).toString();
}

export function tokenRefreshBody({ clientId, clientSecret, refreshToken }) {
  return new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  }).toString();
}
