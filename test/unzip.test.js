// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { zipFiles, crc32 } from '../src/lib/zip.js';
import { unzip } from '../src/lib/unzip.js';

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);

async function storedZipBytes(entries) {
  const blob = await zipFiles(entries.map((e) => ({ path: e.path, data: enc(e.text) })));
  return new Uint8Array(await blob.arrayBuffer());
}

// Build a one-entry deflate (method 8) zip by hand to exercise the inflate path.
async function deflateZip(name, text) {
  const data = enc(text);
  const cs = new CompressionStream('deflate-raw');
  const w = cs.writable.getWriter(); w.write(data); w.close();
  const comp = new Uint8Array(await new Response(cs.readable).arrayBuffer());
  const nameB = enc(name);
  const out = [];
  const u16 = (n) => out.push(n & 255, (n >> 8) & 255);
  const u32 = (n) => out.push(n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255);
  u32(0x04034b50); u16(20); u16(0); u16(8); u16(0); u16(0); u32(crc32(data)); u32(comp.length); u32(data.length); u16(nameB.length); u16(0);
  out.push(...nameB, ...comp);
  const cdOff = out.length;
  u32(0x02014b50); u16(20); u16(20); u16(0); u16(8); u16(0); u16(0); u32(crc32(data)); u32(comp.length); u32(data.length); u16(nameB.length); u16(0); u16(0); u16(0); u16(0); u32(0); u32(0);
  out.push(...nameB);
  const cdLen = out.length - cdOff;
  u32(0x06054b50); u16(0); u16(0); u16(1); u16(1); u32(cdLen); u32(cdOff); u16(0);
  return new Uint8Array(out);
}

describe('unzip', () => {
  it('round-trips stored entries (names + byte-exact contents)', async () => {
    const bytes = await storedZipBytes([
      { path: 'Inbox/a.md', text: 'hello' },
      { path: 'Recipes/b.md', text: '# Soup\nyum' },
    ]);
    const files = await unzip(bytes);
    const byPath = Object.fromEntries(files.map((f) => [f.path, dec(f.bytes)]));
    expect(Object.keys(byPath).sort()).toEqual(['Inbox/a.md', 'Recipes/b.md']);
    expect(byPath['Inbox/a.md']).toBe('hello');
    expect(byPath['Recipes/b.md']).toBe('# Soup\nyum');
  });

  it('preserves Unicode paths and contents', async () => {
    const bytes = await storedZipBytes([{ path: 'Work/反彈.md', text: '內容' }]);
    const [file] = await unzip(bytes);
    expect(file.path).toBe('Work/反彈.md');
    expect(dec(file.bytes)).toBe('內容');
  });

  it('inflates deflate (method 8) entries', async () => {
    const bytes = await deflateZip('big.md', 'x'.repeat(1000));
    const [file] = await unzip(bytes);
    expect(dec(file.bytes)).toBe('x'.repeat(1000));
  });

  it('skips directory entries', async () => {
    const bytes = await storedZipBytes([
      { path: 'Recipes/', text: '' },
      { path: 'Recipes/a.md', text: 'a' },
    ]);
    const files = await unzip(bytes);
    expect(files.map((f) => f.path)).toEqual(['Recipes/a.md']);
  });

  it('throws on non-zip input', async () => {
    await expect(unzip(enc('not a zip at all'))).rejects.toThrow();
  });
});
