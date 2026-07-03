// On-device embedding worker for M9 (the compute side). Runs Transformers.js +
// multilingual-e5-small entirely in a dedicated Web Worker so the ~130MB one-time
// model load and every embed never touch the app's main thread.
//
// This worker is DUMB on purpose: raw strings in, packed Float32 vectors out. It
// knows nothing about e5's "query:"/"passage:" instruction prefixes — those live
// in src/lib/embed-client.js. Its whole contract is the message protocol below.
//
// Protocol
//   in :  { id, type: 'ensure' }               -> load the pipeline (first ever
//                                                  call downloads the weights);
//                                                  emits untargeted
//                                                  { type: 'progress', ... } events
//         { id, type: 'embed', texts: string[] } -> embed raw strings
//         { id, type: 'dispose' }               -> free the pipeline
//   out:  { id, ok: true,  ...result }
//         { id, ok: false, code, message }      -> errors NEVER kill the worker
//         { type: 'progress', file, progress, loaded, total, status }  (no id)
//   embed result = { vectors: ArrayBuffer[], dim } — each ArrayBuffer is a tight
//   Float32Array buffer, transferred (zero-copy) back to the page.

import { pipeline, env } from '@huggingface/transformers';

// --- MV3 / Chrome Web Store environment lockdown ------------------------------
// Remote CODE is a CWS policy violation; model WEIGHTS are data. So the int8 ONNX
// weights download ONCE from the HF CDN and the browser's Cache API keeps them,
// while the ONNX Runtime WASM binary is PACKAGED in the extension.
env.allowRemoteModels = true;
env.allowLocalModels = false;

// Point ORT at the PACKAGED .wasm. embed-worker.js sits at the extension root, so
// its own directory IS the root. chrome.runtime.getURL is NOT available inside a
// dedicated worker, so we derive the base from self.location instead.
env.backends.onnx.wasm.wasmPaths = new URL('./', self.location.href).href;
// Single-threaded SIMD only. Multi-threaded ORT needs SharedArrayBuffer, which
// needs COOP/COEP headers an extension page cannot set; pinning 1 thread keeps us
// on the single bundled ort-wasm-simd-threaded.asyncify.wasm artifact.
env.backends.onnx.wasm.numThreads = 1;

// Config MUST mirror the E15 spike (eval/run-vector.mjs): multilingual-e5-small,
// int8 (q8) weights, mean pooling + L2 normalize -> 384-dim, dot-product-ready.
// device:'wasm' is the only browser-specific addition — it pins the WASM EP so we
// never fall through to a WebGPU path that would need a different .wasm artifact.
const MODEL_ID = 'Xenova/multilingual-e5-small';
const EXTRACT_OPTS = { pooling: 'mean', normalize: true };

// ONE pipeline instance, created lazily on the first ensure/embed.
let pipePromise = null;

function getPipeline() {
  if (!pipePromise) {
    pipePromise = pipeline('feature-extraction', MODEL_ID, {
      dtype: 'q8',
      device: 'wasm',
      progress_callback: (p) => {
        // Untargeted load-progress; embed-client forwards these to its onProgress.
        self.postMessage({
          type: 'progress',
          status: p.status,
          file: p.file,
          progress: p.progress,
          loaded: p.loaded,
          total: p.total,
        });
      },
    }).catch((err) => {
      // Don't cache a rejected promise: a failed download (offline, etc.) must be
      // retryable by a later 'ensure' rather than poisoning the worker forever.
      pipePromise = null;
      throw err;
    });
  }
  return pipePromise;
}

// Serialize all pipeline work. Transformers.js/ORT WASM sessions are NOT
// re-entrant — overlapping extractor() calls throw "Session already started". A
// single promise chain runs ensure + every embed one-at-a-time in arrival order.
let queue = Promise.resolve();
function serial(task) {
  const result = queue.then(task);
  queue = result.catch(() => {}); // swallow so one failure can't break the chain
  return result;
}

async function handleEnsure() {
  await getPipeline(); // triggers the one-time weights download; progress streamed
  return {};
}

async function handleEmbed(texts) {
  const extractor = await getPipeline();
  const vectors = [];
  let dim = 0;
  for (const text of texts) {
    const out = await extractor(text, EXTRACT_OPTS);
    // out.data is a Float32Array view into a larger pooled buffer; copy into a
    // tight Float32Array so its .buffer is exactly dim*4 bytes and transferable.
    const vec = new Float32Array(out.data);
    dim = vec.length;
    vectors.push(vec.buffer);
  }
  return { vectors, dim };
}

async function handleDispose() {
  if (pipePromise) {
    const p = pipePromise.catch(() => null); // never throw from dispose
    pipePromise = null;
    const pipe = await p;
    if (pipe && typeof pipe.dispose === 'function') await pipe.dispose();
  }
  return {};
}

self.onmessage = async (e) => {
  const { id, type } = e.data || {};
  try {
    let result;
    if (type === 'ensure') {
      result = await serial(handleEnsure);
    } else if (type === 'embed') {
      result = await serial(() => handleEmbed(e.data.texts));
    } else if (type === 'dispose') {
      result = await serial(handleDispose);
    } else {
      const err = new Error(`unknown message type: ${type}`);
      err.code = 'BAD_REQUEST';
      throw err;
    }
    // Transfer the vector buffers (embed only); ensure/dispose carry nothing.
    self.postMessage({ id, ok: true, ...result }, result.vectors || []);
  } catch (err) {
    // Errors NEVER kill the worker — every failure becomes an {ok:false} envelope.
    const code = err && err.code
      ? err.code
      : (type === 'ensure' ? 'MODEL_LOAD_FAILED' : 'EMBED_FAILED');
    self.postMessage({ id, ok: false, code, message: (err && err.message) || String(err) });
  }
};
