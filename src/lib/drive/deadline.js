// src/lib/drive/deadline.js
// Every Drive request gets a deadline. Unbounded, a stalled request was never merely slow:
// in the service worker it held a save open until Chrome stopped the worker mid-await,
// with no catch left to run. A missed deadline instead rejects into the caller's normal
// failure path — offloadNote, for one, keeps the note on this device.
export const DRIVE_REQUEST_TIMEOUT_MS = 30_000;

// An upload's progress can't be observed through fetch(), so its deadline is a total:
// the request deadline plus time to push the bytes at a deliberately low floor rate
// (128 kbit/s). Anything that still moves data finishes — a 24 MB capture gets about 26
// minutes — and only a connection that has effectively stopped gives up. A higher floor
// failed uploads on slow links that would have completed.
const MIN_UPLOAD_BYTES_PER_SEC = 16 * 1024;

// A download CAN be watched as it arrives, so it is bounded by silence rather than by
// its total length: slow links and several images loading at once still finish.
export const DRIVE_DOWNLOAD_STALL_MS = 60_000;

export function uploadTimeoutMs(byteLength) {
  return DRIVE_REQUEST_TIMEOUT_MS + Math.ceil((Number(byteLength) || 0) / MIN_UPLOAD_BYTES_PER_SEC) * 1000;
}

// The signal also covers reading the response body, so a reply that stalls halfway
// through a .json() is bounded too.
export function deadlineSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

// Name the deadline in the error: "signal is aborted without reason" says nothing about
// which request gave up, or why.
function timeoutError(message) {
  const err = new Error(message);
  err.name = 'TimeoutError';
  return err;
}

export async function fetchWithDeadline(url, opts, ms) {
  try {
    return await fetch(url, { ...opts, signal: deadlineSignal(ms) });
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw timeoutError(`Drive request timed out after ${Math.round(ms / 1000)} s: ${url}`);
    }
    throw err;
  }
}

// Fetch a whole response body. The reply must begin within `startMs`, and after that
// the only limit is `stallMs` of silence between chunks.
export async function downloadWithStallDeadline(url, opts, { startMs = DRIVE_REQUEST_TIMEOUT_MS, stallMs = DRIVE_DOWNLOAD_STALL_MS } = {}) {
  const controller = new AbortController();
  let limit = startMs;
  let timer;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(), limit); };
  arm();
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    if (!res.ok) throw new Error(`Drive API ${res.status} for ${url}`);
    limit = stallMs;
    arm();
    const reader = res.body?.getReader?.();
    if (!reader) return new Uint8Array(await res.arrayBuffer());
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
      arm();
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
    return bytes;
  } catch (err) {
    if (controller.signal.aborted) {
      throw timeoutError(limit === startMs
        ? `Drive request timed out after ${Math.round(startMs / 1000)} s: ${url}`
        : `Drive download stalled for ${Math.round(stallMs / 1000)} s: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
