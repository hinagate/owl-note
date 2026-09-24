// src/lib/drive/deadline.js
// Every Drive request gets a deadline. Unbounded, a stalled request was never merely slow:
// in the service worker it held a save open until Chrome stopped the worker mid-await,
// with no catch left to run. A missed deadline instead rejects into the caller's normal
// failure path — offloadNote, for one, keeps the note on this device.
export const DRIVE_REQUEST_TIMEOUT_MS = 30_000;

// Uploads get the request deadline plus time to push their bytes at a deliberately slow
// floor rate (512 kbit/s), so a poor-but-working uplink still finishes and only a stalled
// one fails. A 24 MB capture gets about 7 minutes.
const MIN_UPLOAD_BYTES_PER_SEC = 64 * 1024;

// A download's size is unknown up front: this is generous enough for a 25 MB file on a
// slow line, and still finite.
export const DRIVE_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

export function uploadTimeoutMs(byteLength) {
  return DRIVE_REQUEST_TIMEOUT_MS + Math.ceil((Number(byteLength) || 0) / MIN_UPLOAD_BYTES_PER_SEC) * 1000;
}

// The signal also covers reading the response body, so a reply that stalls halfway
// through a .json() or .arrayBuffer() is bounded too.
export function deadlineSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

// Name the deadline in the error: "signal is aborted without reason" says nothing about
// which request gave up, or why.
export async function fetchWithDeadline(url, opts, ms) {
  try {
    return await fetch(url, { ...opts, signal: deadlineSignal(ms) });
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      const timeout = new Error(`Drive request timed out after ${Math.round(ms / 1000)} s: ${url}`);
      timeout.name = 'TimeoutError';
      throw timeout;
    }
    throw err;
  }
}
