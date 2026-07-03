// Page-side wrapper around the embed worker (src/workers/embed-worker.js). The
// worker is deliberately DUMB — raw strings in, ArrayBuffer vectors out. Two
// things live here and NOT in the worker:
//
//   1. The e5 instruction prefixes. multilingual-e5-small was trained with
//      "passage: " on documents and "query: " on queries; the E15 spike measured
//      that dropping them measurably CRIPPLES retrieval (see eval/run-vector.mjs).
//      Keeping them page-side keeps the worker a pure embedder with no model-family
//      knowledge.
//   2. Request/response correlation. Every message carries a monotonic id; a reply
//      resolves (or rejects) only the matching call, so out-of-order or concurrent
//      embeds never cross wires, and a single failure rejects only its own call.
//
// This module imports NOTHING from @huggingface/transformers — it uses only the
// Worker API — so it stays out of app.js's bundle (the transformers weight is
// confined to the separate embed-worker.js entry).

/**
 * @param {object} [opts]
 * @param {string} [opts.workerUrl] URL of the bundled worker, resolved relative to
 *   app.html (siblings in dist/). Defaults to 'embed-worker.js'.
 * @param {(url: string) => Worker} [opts.createWorker] Factory seam for tests; the
 *   default spawns a real classic (iife-bundled) Worker.
 */
export function createEmbedClient({
  workerUrl = 'embed-worker.js',
  createWorker = (url) => new Worker(url),
} = {}) {
  let worker = null;
  let ready = false;
  let disposed = false;
  let readyPromise = null;
  let seq = 0;
  const pending = new Map(); // id -> { resolve, reject }
  let onProgress = null;

  function handleMessage(data) {
    // Untargeted progress events (emitted during 'ensure') have no id.
    if (data && data.type === 'progress') {
      if (onProgress) onProgress(data);
      return;
    }
    const entry = pending.get(data.id);
    if (!entry) return; // stale/unknown id — ignore rather than throw.
    pending.delete(data.id);
    if (data.ok) {
      entry.resolve(data);
    } else {
      const err = new Error(data.message || 'embed worker error');
      if (data.code) err.code = data.code;
      entry.reject(err);
    }
  }

  function spawn() {
    worker = createWorker(workerUrl);
    worker.onmessage = (e) => handleMessage(e.data);
    // A worker-level error (uncaught throw / load failure) can't be tied to one
    // call, so fail every in-flight request rather than hang them forever.
    worker.onerror = (e) => {
      const err = new Error((e && e.message) || 'embed worker crashed');
      err.code = 'WORKER_ERROR';
      rejectAll(err);
    };
    return worker;
  }

  function rejectAll(err) {
    for (const entry of pending.values()) entry.reject(err);
    pending.clear();
  }

  // Correlate one request/response round-trip. `transfer` is unused today (the
  // page sends only strings, copied cheaply) but kept for symmetry with the
  // worker, which transfers vector buffers back.
  function post(type, payload, transfer) {
    return new Promise((resolve, reject) => {
      if (disposed) {
        reject(new Error('embed client disposed'));
        return;
      }
      if (!worker) spawn();
      const id = (seq += 1);
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, type, ...payload }, transfer || []);
    });
  }

  async function ensureReady({ onProgress: progressCb } = {}) {
    if (disposed) throw new Error('embed client disposed');
    if (ready) return;
    onProgress = progressCb || null;
    // Collapse concurrent callers onto a single in-flight 'ensure' so the model
    // downloads/loads exactly once.
    if (!readyPromise) {
      readyPromise = post('ensure').then(() => { ready = true; });
    }
    await readyPromise;
  }

  async function embedPassages(texts) {
    // e5 document prefix (see header note).
    const res = await post('embed', { texts: texts.map((t) => `passage: ${t}`) });
    return res.vectors.map((b) => new Float32Array(b));
  }

  async function embedQuery(text) {
    // e5 query prefix (see header note).
    const res = await post('embed', { texts: [`query: ${text}`] });
    return new Float32Array(res.vectors[0]);
  }

  function stats() {
    return { spawned: !!worker, ready };
  }

  function dispose() {
    disposed = true;
    ready = false;
    readyPromise = null;
    rejectAll(new Error('embed client disposed'));
    if (worker) {
      worker.terminate();
      worker = null;
    }
  }

  return { ensureReady, embedPassages, embedQuery, stats, dispose };
}
