import { describe, it, expect } from 'vitest';
import { bytesToBase64url, base64urlToBytes } from '../src/lib/base64url.js';

describe('base64url', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255, 62, 63]);
    const s = bytesToBase64url(bytes);
    expect(s).toMatch(/^[A-Za-z0-9_-]*$/);
    expect(Array.from(base64urlToBytes(s))).toEqual(Array.from(bytes));
  });

  it('produces no padding or +/ characters', () => {
    const s = bytesToBase64url(new Uint8Array([255, 255, 255, 255, 255]));
    expect(s.includes('=')).toBe(false);
    expect(s.includes('+')).toBe(false);
    expect(s.includes('/')).toBe(false);
  });
});
