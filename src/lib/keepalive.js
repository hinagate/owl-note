// src/lib/keepalive.js
// Chrome stops an idle MV3 service worker 30 s after its last extension event or API
// call, and a pending fetch() does not count as activity (measured in Chrome 153). A
// full-page capture's Drive upload routinely outlasts that on an ordinary uplink, so the
// worker was stopped mid-await: no catch ran, and the toolbar badge stayed at 99% for good.
// Any extension API call resets the timer, so ping a cheap one while the work runs.
export const KEEPALIVE_INTERVAL_MS = 20_000;

// Every await on the save path now has its own deadline, so this ceiling should never be
// reached. It exists so that one missed bound cannot pin the worker awake indefinitely:
// past it the worker is allowed to stop, and the next one clears the stale badge.
export const KEEPALIVE_MAX_MS = 20 * 60_000;

function pingExtensionApi() {
  try {
    globalThis.chrome?.runtime?.getPlatformInfo?.()?.catch?.(() => {});
  } catch { /* the worker is already shutting down; there is nothing left to keep */ }
}

export async function withKeepAlive(work, { intervalMs = KEEPALIVE_INTERVAL_MS, maxMs = KEEPALIVE_MAX_MS, ping = pingExtensionApi } = {}) {
  const started = Date.now();
  const timer = setInterval(() => {
    if (Date.now() - started >= maxMs) { clearInterval(timer); return; }
    ping();
  }, intervalMs);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}
