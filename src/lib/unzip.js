// src/lib/unzip.js
// Minimal ZIP reader — "stored" (0) and "deflate" (8). Zero dependencies.
// Parses the central directory (robust for foreign zips/data descriptors).

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;

async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  writer.write(bytes).catch(() => {});
  writer.close().catch(() => {});
  const buf = await new Response(ds.readable).arrayBuffer();
  return new Uint8Array(buf);
}

function findEOCD(view, len) {
  const min = Math.max(0, len - 22 - 0xffff);
  for (let i = len - 22; i >= min; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) return i;
  }
  return -1;
}

export async function unzip(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const len = u8.byteLength;
  const eocd = findEOCD(view, len);
  if (eocd < 0) throw new Error('Not a zip file (no end-of-central-directory record)');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);

  const out = [];
  for (let i = 0; i < count; i++) {
    if (p + 46 > len || view.getUint32(p, true) !== CD_SIG) break;
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOff = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue; // directory entry

    const lNameLen = view.getUint16(localOff + 26, true);
    const lExtraLen = view.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = u8.subarray(dataStart, dataStart + compSize);
    const data = method === 0 ? comp.slice() : await inflateRaw(comp);
    out.push({ path: name, bytes: data });
  }
  return out;
}
