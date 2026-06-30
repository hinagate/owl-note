import { describe, it, expect } from 'vitest';
import manifest from '../manifest.json';

describe('manifest', () => {
  it('adds identity but keeps Google APIs as an OPTIONAL host permission', () => {
    expect(manifest.permissions).toContain('identity');
    expect(manifest.host_permissions || []).not.toContain('https://www.googleapis.com/*'); // not at install
    expect(manifest.optional_host_permissions).toContain('https://www.googleapis.com/*');
  });
});
