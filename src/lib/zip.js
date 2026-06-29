// src/lib/zip.js
// Minimal ZIP writer — per entry "deflate" (8) when it's smaller, else "stored" (0).
// Zero dependencies. Produces a downloadable Blob. Filenames are UTF-8 (flag bit 11).

const textEncoder = new TextEncoder();
const FLAG_UTF8 = 0x0800;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Raw DEFLATE (zip method 8) via the platform CompressionStream — the same primitive
// the codec/unzip use, available both in the extension and in Node.
async function deflateBytes(bytes) {
  const cs = new CompressionStream('deflate-raw');
  const writer = cs.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const buf = await new Response(cs.readable).arrayBuffer();
  return new Uint8Array(buf);
}

export async function zipFiles(entries) {
  const chunks = [];   // local headers + file data, in order
  const central = [];  // central directory records
  let offset = 0;      // running byte offset (for local-header positions)

  for (const entry of entries) {
    const nameBytes = textEncoder.encode(entry.path);
    const raw = entry.data;
    const crc = crc32(raw);
    const usize = raw.length;            // uncompressed size

    // Compress; fall back to "stored" when deflate doesn't actually help
    // (tiny/already-compressed data — deflate carries a few bytes of overhead).
    const deflated = await deflateBytes(raw);
    const useDeflate = deflated.length < usize;
    const data = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const csize = data.length;           // compressed size

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // local file header signature
    lv.setUint16(4, 20, true);         // version needed
    lv.setUint16(6, FLAG_UTF8, true);  // general purpose flags (UTF-8)
    lv.setUint16(8, method, true);     // 8 = deflate, 0 = stored
    lv.setUint16(10, 0, true);         // mod time (fixed)
    lv.setUint16(12, 0, true);         // mod date (fixed)
    lv.setUint32(14, crc, true);       // crc-32 (of the uncompressed data)
    lv.setUint32(18, csize, true);     // compressed size
    lv.setUint32(22, usize, true);     // uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);         // extra field length
    local.set(nameBytes, 30);
    chunks.push(local, data);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true); // central directory signature
    cv.setUint16(4, 20, true);         // version made by
    cv.setUint16(6, 20, true);         // version needed
    cv.setUint16(8, FLAG_UTF8, true);  // flags
    cv.setUint16(10, method, true);    // method
    cv.setUint16(12, 0, true);         // mod time
    cv.setUint16(14, 0, true);         // mod date
    cv.setUint32(16, crc, true);       // crc-32
    cv.setUint32(20, csize, true);     // compressed size
    cv.setUint32(24, usize, true);     // uncompressed size
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);         // extra field length
    cv.setUint16(32, 0, true);         // file comment length
    cv.setUint16(34, 0, true);         // disk number start
    cv.setUint16(36, 0, true);         // internal attrs
    cv.setUint32(38, 0, true);         // external attrs
    cv.setUint32(42, offset, true);    // local header offset
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += local.length + data.length;
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const centralOffset = offset;

  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);      // end of central directory signature
  ev.setUint16(4, 0, true);               // disk number
  ev.setUint16(6, 0, true);               // disk with central dir
  ev.setUint16(8, central.length, true);  // records on this disk
  ev.setUint16(10, central.length, true); // total records
  ev.setUint32(12, centralSize, true);    // central dir size
  ev.setUint32(16, centralOffset, true);  // central dir offset
  ev.setUint16(20, 0, true);              // comment length

  return new Blob([...chunks, ...central, end], { type: 'application/zip' });
}
