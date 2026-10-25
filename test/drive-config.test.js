globalThis.__OWL_DRIVE_CLIENT_ID__ = '';
globalThis.__OWL_DRIVE_CLIENT_SECRET__ = '';

import { describe, it, expect } from 'vitest';
import * as cfg from '../src/lib/drive/config.js';

describe('drive/config', () => {
  it('asks for drive.file and, for the key backup, drive.appdata — nothing broader', () => {
    expect(cfg.DRIVE_SCOPE.split(' ')).toEqual([
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/drive.appdata',
    ]);
  });
  it('exposes the endpoints', () => {
    expect(cfg.TOKEN_ENDPOINT).toBe('https://oauth2.googleapis.com/token');
    expect(cfg.DRIVE_UPLOAD_URL).toContain('/upload/drive/v3/files');
  });
  it('caps attachments at 25 MB', () => { expect(cfg.MAX_ATTACH_BYTES).toBe(25 * 1024 * 1024); });
  it('does not throw when build-time creds are undefined (test env)', () => {
    expect(typeof cfg.OAUTH_CLIENT_ID).toBe('string');
  });
});
