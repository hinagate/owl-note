import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import manifest from '../manifest.json';

const localesOf = () => readdirSync('_locales');
const messagesOf = (locale) => JSON.parse(readFileSync(`_locales/${locale}/messages.json`, 'utf8'));
const keyOf = (value) => value.match(/^__MSG_(\w+)__$/)?.[1];

describe('manifest', () => {
  describe.each(localesOf())('listing text in %s', (locale) => {
    const text = (field) => messagesOf(locale)[keyOf(manifest[field])]?.message;

    it('has every message the manifest asks for', () => {
      for (const field of ['name', 'short_name', 'description']) {
        expect(keyOf(manifest[field])).toBeTruthy();
        expect(text(field)).toBeTruthy();
      }
    });

    it('stays inside the limits Chrome enforces', () => {
      expect([...text('name')].length).toBeLessThanOrEqual(75);
      expect([...text('short_name')].length).toBeLessThanOrEqual(12);
      expect([...text('description')].length).toBeLessThanOrEqual(132);
    });
  });

  it('declares a default locale that exists, and offers a listing in Traditional Chinese', () => {
    expect(existsSync(`_locales/${manifest.default_locale}/messages.json`)).toBe(true);
    expect(localesOf()).toContain('zh_TW');
  });

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
