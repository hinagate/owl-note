// @vitest-environment node
import { describe, it, expect } from 'vitest';
import zlib from 'node:zlib';
import { zipFiles, crc32 } from '../src/lib/zip.js';

const enc = (s) => new TextEncoder().encode(s);

// Parse a "stored" zip back into [{ name, data, crc, flags }] by walking local headers.
async function readZip(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const dv = new DataView(buf.buffer);
  const files = [];
  let p = 0;
  while (p + 4 <= buf.length && dv.getUint32(p, true) === 0x04034b50) {
    const flags = dv.getUint16(p + 6, true);
    const method = dv.getUint16(p + 8, true);
    const crc = dv.getUint32(p + 14, true);
    const csize = dv.getUint32(p + 18, true); // compressed size
    const nameLen = dv.getUint16(p + 26, true);
    const extraLen = dv.getUint16(p + 28, true);
    const name = new TextDecoder().decode(buf.slice(p + 30, p + 30 + nameLen));
    const dataStart = p + 30 + nameLen + extraLen;
    const comp = buf.slice(dataStart, dataStart + csize);
    const data = method === 0 ? comp : new Uint8Array(zlib.inflateRawSync(Buffer.from(comp)));
    files.push({ name, data, crc, flags, method });
    p = dataStart + csize;
  }
  return files;
}

describe('zip writer', () => {
  it('computes CRC-32 matching node:zlib', () => {
    expect(crc32(enc('hello')) >>> 0).toBe(zlib.crc32(Buffer.from('hello')) >>> 0);
    expect(crc32(enc('')) >>> 0).toBe(zlib.crc32(Buffer.from('')) >>> 0);
  });

  it('round-trips file names and byte-exact contents', async () => {
    const blob = await zipFiles([
      { path: 'Inbox/a.md', data: enc('hello world') },
      { path: 'Recipes/b.md', data: enc('# Soup\nyum') },
    ]);
    const files = await readZip(blob);
    expect(files.map((f) => f.name)).toEqual(['Inbox/a.md', 'Recipes/b.md']);
    expect(new TextDecoder().decode(files[0].data)).toBe('hello world');
    expect(new TextDecoder().decode(files[1].data)).toBe('# Soup\nyum');
  });

  it('sets the UTF-8 flag and preserves Unicode names with a correct CRC', async () => {
    const blob = await zipFiles([{ path: 'Work/反彈分析.md', data: enc('內容') }]);
    const [file] = await readZip(blob);
    expect(file.name).toBe('Work/反彈分析.md');
    expect(file.flags & 0x0800).toBe(0x0800);
    expect(file.crc >>> 0).toBe(zlib.crc32(Buffer.from('內容')) >>> 0);
  });

  it('deflates a large compressible entry (method 8) and round-trips it', async () => {
    const big = 'abcdefgh'.repeat(2000); // 16 KB, highly compressible
    const blob = await zipFiles([{ path: 'big.txt', data: enc(big) }]);
    const [file] = await readZip(blob);
    expect(file.method).toBe(8); // compressed, not stored
    expect(new TextDecoder().decode(file.data)).toBe(big); // inflates back byte-exact
    expect(file.crc >>> 0).toBe(zlib.crc32(Buffer.from(big)) >>> 0);
  });

  it('stores a tiny entry when deflate would not be smaller (method 0)', async () => {
    const blob = await zipFiles([{ path: 'tiny.txt', data: enc('hi') }]);
    const [file] = await readZip(blob);
    expect(file.method).toBe(0); // deflate overhead > 2 bytes -> stored
    expect(new TextDecoder().decode(file.data)).toBe('hi');
  });
});
