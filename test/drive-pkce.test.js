import { describe, it, expect } from 'vitest';
import { createPkce, buildAuthUrl, tokenExchangeBody, tokenRefreshBody } from '../src/lib/drive/pkce.js';

describe('drive/pkce', () => {
  it('creates a verifier and an S256 challenge (base64url, no padding)', async () => {
    const { verifier, challenge } = await createPkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).not.toContain('=');
  });
  it('builds an auth URL with code flow, offline access and the challenge', () => {
    const url = buildAuthUrl({ clientId: 'cid', redirectUri: 'https://x.chromiumapp.org/', scope: 'scope', challenge: 'chal' });
    expect(url).toContain('response_type=code');
    expect(url).toContain('access_type=offline');
    expect(url).toContain('prompt=consent');
    expect(url).toContain('code_challenge=chal');
    expect(url).toContain('code_challenge_method=S256');
    expect(url).toContain('client_id=cid');
    expect(url).toContain('redirect_uri=https%3A%2F%2Fx.chromiumapp.org%2F');
  });
  it('builds a token-exchange body with code, verifier and secret', () => {
    const body = tokenExchangeBody({ clientId: 'cid', clientSecret: 'sec', code: 'c', verifier: 'v', redirectUri: 'r' });
    expect(body).toContain('grant_type=authorization_code');
    expect(body).toContain('code=c');
    expect(body).toContain('code_verifier=v');
    expect(body).toContain('client_secret=sec');
  });
  it('builds a refresh body', () => {
    const body = tokenRefreshBody({ clientId: 'cid', clientSecret: 'sec', refreshToken: 'rt' });
    expect(body).toContain('grant_type=refresh_token');
    expect(body).toContain('refresh_token=rt');
    expect(body).toContain('client_secret=sec');
  });
});
