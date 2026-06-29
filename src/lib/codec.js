// src/lib/codec.js
import { bytesToBase64url, base64urlToBytes } from './base64url.js';

export function compressionAvailable() {
  return typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
}

async function deflateRaw(str) {
  const cs = new CompressionStream('deflate-raw');
  const writer = cs.writable.getWriter();
  writer.write(new TextEncoder().encode(str));
  writer.close();
  const buf = await new Response(cs.readable).arrayBuffer();
  return new Uint8Array(buf);
}

async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  // Fire-and-forget: the Response below consumes ds.readable concurrently, so
  // write/close must NOT be awaited here — awaiting close() before the readable
  // is drained deadlocks under backpressure for any non-trivial payload. The
  // .catch keeps an invalid-input rejection from surfacing as an unhandled
  // rejection; the readable also errors, so the awaited Response still throws
  // to callers (who catch it).
  writer.write(bytes).catch(() => {});
  writer.close().catch(() => {});
  const buf = await new Response(ds.readable).arrayBuffer();
  return new TextDecoder().decode(buf);
}

export async function encode(note) {
  const bytes = await deflateRaw(JSON.stringify(note));
  return bytesToBase64url(bytes);
}

export async function decode(payload) {
  const json = await inflateRaw(base64urlToBytes(payload));
  return JSON.parse(json);
}

export async function selfTest(note) {
  try {
    const back = await decode(await encode(note));
    return JSON.stringify(back) === JSON.stringify(note);
  } catch {
    return false;
  }
}
