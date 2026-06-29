// Build the extension icons from the user-provided design at icon.png.
// icon.png is a screenshot; we detect the blue app tile, crop it square,
// round the corners, and downscale to 16/48/128. Pure Node, no deps.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import zlib from 'node:zlib';

// --- PNG decode (8-bit, non-interlaced, colorType 2 or 6) ---
function decodePNG(buf) {
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  const colorType = buf[25];
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error('unsupported PNG colorType ' + colorType);
  const idat = [];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') idat.push(buf.subarray(off + 8, off + 8 + len));
    if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const data = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride), p = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[p++];
    const cur = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const x = raw[p++];
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let val;
      if (filter === 0) val = x;
      else if (filter === 1) val = x + a;
      else if (filter === 2) val = x + b;
      else if (filter === 3) val = x + ((a + b) >> 1);
      else { // Paeth
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        val = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      cur[i] = val & 0xff;
    }
    cur.copy(data, y * stride);
    prev = cur;
  }
  // normalize to RGBA
  if (channels === 4) return { w, h, data };
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = data[i * 3]; rgba[i * 4 + 1] = data[i * 3 + 1];
    rgba[i * 4 + 2] = data[i * 3 + 2]; rgba[i * 4 + 3] = 255;
  }
  return { w, h, data: rgba };
}

// --- PNG encode (RGBA) ---
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = t[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
})();
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const tb = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(CRC(Buffer.concat([tb, data])), 0);
  return Buffer.concat([len, tb, data, crc]);
}
function encodePNG(size, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  const stride = 1 + size * 4;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) { raw[y * stride] = 0; rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4); }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// --- detect the blue app tile via row/column density (ignores the thin
//     "OWL-NOTE" text below the tile, which has few blue pixels per row) ---
function detectTile(img) {
  const { w, h, data } = img;
  const X0 = (w * 0.30) | 0, X1 = (w * 0.70) | 0, Y0 = (h * 0.12) | 0, Y1 = (h * 0.92) | 0;
  const isBlue = (o) => {
    const r = data[o], g = data[o + 1], b = data[o + 2];
    return b > 95 && b >= r + 25 && b >= g + 12 && Math.min(r, g) < 215;
  };
  const longestRun = (count, lo, hi, frac) => {
    const max = Math.max(...count.slice(lo, hi));
    const th = max * frac;
    let b0 = lo, b1 = lo, start = -1;
    for (let i = lo; i <= hi; i++) {
      const on = i < hi && count[i] >= th;
      if (on && start < 0) start = i;
      if (!on && start >= 0) { if (i - start > b1 - b0) { b0 = start; b1 = i; } start = -1; }
    }
    return [b0, b1];
  };
  const rowCount = new Array(h).fill(0);
  for (let y = Y0; y < Y1; y++) { let c = 0; for (let x = X0; x < X1; x++) if (isBlue((y * w + x) * 4)) c++; rowCount[y] = c; }
  const [ty0, ty1] = longestRun(rowCount, Y0, Y1, 0.30);
  const colCount = new Array(w).fill(0);
  for (let x = X0; x < X1; x++) { let c = 0; for (let y = ty0; y < ty1; y++) if (isBlue((y * w + x) * 4)) c++; colCount[x] = c; }
  const [tx0, tx1] = longestRun(colCount, X0, X1, 0.30);
  const cx = (tx0 + tx1) / 2, cy = (ty0 + ty1) / 2;
  const side = Math.max(tx1 - tx0, ty1 - ty0);
  return { sx: cx - side / 2, sy: cy - side / 2, side };
}

// --- crop (square) + box-downscale to S, then round the corners ---
function makeIcon(img, crop, S) {
  const { w, h, data } = img;
  const out = Buffer.alloc(S * S * 4);
  const rad = S * 0.2;
  for (let oy = 0; oy < S; oy++) for (let ox = 0; ox < S; ox++) {
    const fx0 = crop.sx + (ox * crop.side) / S, fx1 = crop.sx + ((ox + 1) * crop.side) / S;
    const fy0 = crop.sy + (oy * crop.side) / S, fy1 = crop.sy + ((oy + 1) * crop.side) / S;
    let r = 0, g = 0, b = 0, a = 0, n = 0;
    for (let yy = Math.floor(fy0); yy < Math.ceil(fy1); yy++) for (let xx = Math.floor(fx0); xx < Math.ceil(fx1); xx++) {
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const o = (yy * w + xx) * 4; r += data[o]; g += data[o + 1]; b += data[o + 2]; a += data[o + 3]; n++;
    }
    const o = (oy * S + ox) * 4;
    if (n) { out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n); out[o + 3] = Math.round(a / n); }
    // rounded-corner alpha mask (drops the screenshot background in the corners)
    const ix = Math.min(Math.max(ox + 0.5, rad), S - rad), iy = Math.min(Math.max(oy + 0.5, rad), S - rad);
    const dd = Math.hypot(ox + 0.5 - ix, oy + 0.5 - iy);
    const cover = Math.max(0, Math.min(1, rad + 0.5 - dd));
    out[o + 3] = Math.round(out[o + 3] * cover);
  }
  return out;
}

const img = decodePNG(readFileSync('icon.png'));
const crop = detectTile(img);
console.log('detected tile crop:', { sx: Math.round(crop.sx), sy: Math.round(crop.sy), side: Math.round(crop.side) });
mkdirSync('dist/icons', { recursive: true });
for (const size of [16, 48, 128]) writeFileSync(`dist/icons/icon-${size}.png`, encodePNG(size, makeIcon(img, crop, size)));
console.log('Icons written to dist/icons/ (from icon.png)');
