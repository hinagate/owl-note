import { describe, it, expect } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';

describe('toolchain', () => {
  it('fake chrome exposes the Other Bookmarks node', async () => {
    const chrome = installFakeChrome();
    const [other] = await chrome.bookmarks.get('2');
    expect(other.title).toBe('Other Bookmarks');
  });
});
