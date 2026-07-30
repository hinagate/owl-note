import { describe, it, expect } from 'vitest';
import manifest from '../manifest.json';

describe('manifest', () => {
  it('adds identity but keeps Google APIs as an OPTIONAL host permission', () => {
    expect(manifest.permissions).toContain('identity');
    expect(manifest.host_permissions || []).not.toContain('https://www.googleapis.com/*'); // not at install
    expect(manifest.optional_host_permissions).toContain('https://www.googleapis.com/*');
    expect(manifest.optional_host_permissions).toContain('https://oauth2.googleapis.com/*');
  });

  it('uses temporary active-tab scripting for formatted right-click captures', () => {
    expect(manifest.permissions).toContain('activeTab');
    expect(manifest.permissions).toContain('scripting');
    expect(manifest.host_permissions || []).toEqual([]);
  });

  // tabCapture must be declared up front, not requested later: Chrome folds
  // per-tab capture access into the activeTab grant AT THE MOMENT of the
  // right-click, so a permission granted afterwards cannot reach that grant and
  // the first run would cost a page reload plus a second right-click.
  it('declares tab audio capture up front so one right-click can start', () => {
    expect(manifest.permissions).toContain('offscreen');
    expect(manifest.permissions).toContain('tabCapture');
    expect(manifest.optional_permissions || []).not.toContain('tabCapture');
  });
});
