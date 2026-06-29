import { describe, it, expect } from 'vitest';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import SparkMD5 from 'spark-md5';

describe('enex deps', () => {
  it('turndown converts basic HTML with ATX headings', () => {
    const td = new TurndownService({ headingStyle: 'atx' });
    expect(td.turndown('<h1>Hi</h1>')).toBe('# Hi');
  });
  it('gfm is a function and spark-md5 hashes', () => {
    expect(typeof gfm).toBe('function');
    expect(typeof SparkMD5.ArrayBuffer.hash(new Uint8Array([1, 2, 3]).buffer)).toBe('string');
  });
});
