import { describe, it, expect, beforeEach } from 'vitest';
import { createEmbedClient } from '../src/lib/embed-client.js';

// ---------------------------------------------------------------------------
// The worker itself (transformers.js + WASM) is exercised for real in V4's
// browser smoke; here we unit-test the CLIENT's protocol logic in isolation by
// INJECTING a FakeWorker factory (`createWorker`). A constructable global would
// also work, but an injected factory is the cleaner seam: no global mutation, and
// each test gets a fresh instance list. The fake records every posted message and
// lets the test hand-deliver replies (in any order) via `w.deliver(...)`, which
// is exactly how a real Worker would call `onmessage`.
// ---------------------------------------------------------------------------
class FakeWorker {
  constructor(url) {
    this.url = url;
    this.posted = []; // { msg, transfer }
    this.terminated = false;
    this.onmessage = null;
    this.onerror = null;
    FakeWorker.instances.push(this);
  }

  postMessage(msg, transfer) {
    this.posted.push({ msg, transfer });
  }

  terminate() {
    this.terminated = true;
  }

  // Test helper: simulate the worker posting a message back to the page.
  deliver(data) {
    if (this.onmessage) this.onmessage({ data });
  }

  // Test helper: reply to the Nth posted message with an ok/err envelope.
  replyTo(index, extra) {
    this.deliver({ id: this.posted[index].msg.id, ...extra });
  }
}
FakeWorker.instances = [];

const factory = (url) => new FakeWorker(url);
const buf = (arr) => new Float32Array(arr).buffer;

beforeEach(() => {
  FakeWorker.instances = [];
});

describe('createEmbedClient', () => {
  describe('ensureReady', () => {
    it('spawns the worker once, posts {type:ensure}, resolves on ok, and forwards progress', async () => {
      const client = createEmbedClient({ createWorker: factory });
      const progress = [];
      const p = client.ensureReady({ onProgress: (e) => progress.push(e) });

      expect(FakeWorker.instances).toHaveLength(1);
      const w = FakeWorker.instances[0];
      expect(w.url).toBe('embed-worker.js');
      expect(w.posted[0].msg.type).toBe('ensure');

      // Untargeted progress events (no id) forward to onProgress.
      w.deliver({ type: 'progress', file: 'model_quantized.onnx', loaded: 50, total: 100, progress: 0.5 });
      w.replyTo(0, { ok: true });
      await p;

      expect(progress).toHaveLength(1);
      expect(progress[0]).toMatchObject({ file: 'model_quantized.onnx', progress: 0.5 });
      expect(client.stats()).toEqual({ spawned: true, ready: true });

      // Second call spawns nothing new and resolves immediately.
      await client.ensureReady();
      expect(FakeWorker.instances).toHaveLength(1);
    });

    it('collapses concurrent ensureReady calls onto a single in-flight ensure', async () => {
      const client = createEmbedClient({ createWorker: factory });
      const p1 = client.ensureReady();
      const p2 = client.ensureReady();
      expect(FakeWorker.instances).toHaveLength(1);
      const w = FakeWorker.instances[0];
      // Exactly one 'ensure' posted despite two callers.
      expect(w.posted.filter((m) => m.msg.type === 'ensure')).toHaveLength(1);
      w.replyTo(0, { ok: true });
      await Promise.all([p1, p2]);
      expect(client.stats().ready).toBe(true);
    });
  });

  describe('embedding + e5 prefixes', () => {
    it('embedPassages prefixes "passage: " and reconstructs Float32Array[] from the ArrayBuffers', async () => {
      const client = createEmbedClient({ createWorker: factory });
      const p = client.embedPassages(['hello', '世界']);
      const w = FakeWorker.instances[0];
      expect(w.posted[0].msg).toMatchObject({ type: 'embed', texts: ['passage: hello', 'passage: 世界'] });

      w.replyTo(0, { ok: true, dim: 3, vectors: [buf([1, 2, 3]), buf([4, 5, 6])] });
      const out = await p;
      expect(out).toHaveLength(2);
      expect(out[0]).toBeInstanceOf(Float32Array);
      expect(Array.from(out[0])).toEqual([1, 2, 3]);
      expect(Array.from(out[1])).toEqual([4, 5, 6]);
    });

    it('embedQuery prefixes "query: " and returns a single Float32Array', async () => {
      const client = createEmbedClient({ createWorker: factory });
      const p = client.embedQuery('how to tamp');
      const w = FakeWorker.instances[0];
      expect(w.posted[0].msg).toMatchObject({ type: 'embed', texts: ['query: how to tamp'] });

      w.replyTo(0, { ok: true, dim: 3, vectors: [buf([7, 8, 9])] });
      const out = await p;
      expect(out).toBeInstanceOf(Float32Array);
      expect(Array.from(out)).toEqual([7, 8, 9]);
    });
  });

  describe('correlation', () => {
    it('routes out-of-order replies to their own callers by id', async () => {
      const client = createEmbedClient({ createWorker: factory });
      const pA = client.embedQuery('A');
      const pB = client.embedQuery('B');
      const w = FakeWorker.instances[0];
      expect(w.posted).toHaveLength(2);
      expect(w.posted[0].msg.id).not.toBe(w.posted[1].msg.id);

      // Reply to B first, then A — each promise gets its OWN result.
      w.replyTo(1, { ok: true, dim: 1, vectors: [buf([2])] });
      w.replyTo(0, { ok: true, dim: 1, vectors: [buf([1])] });

      expect(Array.from(await pA)).toEqual([1]);
      expect(Array.from(await pB)).toEqual([2]);
    });
  });

  describe('error isolation', () => {
    it('rejects only the failing call; a subsequent call still succeeds', async () => {
      const client = createEmbedClient({ createWorker: factory });
      const pFail = client.embedQuery('x');
      const w = FakeWorker.instances[0];
      w.replyTo(0, { ok: false, code: 'EMBED_FAILED', message: 'boom' });
      await expect(pFail).rejects.toThrow('boom');

      const pOk = client.embedQuery('y');
      w.replyTo(1, { ok: true, dim: 1, vectors: [buf([5])] });
      expect(Array.from(await pOk)).toEqual([5]);
    });

    it('surfaces the worker error code on the rejected error', async () => {
      const client = createEmbedClient({ createWorker: factory });
      const p = client.embedQuery('x');
      const w = FakeWorker.instances[0];
      w.replyTo(0, { ok: false, code: 'MODEL_LOAD_FAILED', message: 'no net' });
      await expect(p).rejects.toMatchObject({ code: 'MODEL_LOAD_FAILED', message: 'no net' });
    });
  });

  describe('dispose', () => {
    it('terminates the worker, rejects in-flight calls, and rejects calls made after dispose', async () => {
      const client = createEmbedClient({ createWorker: factory });
      const pending = client.embedQuery('in-flight');
      const w = FakeWorker.instances[0];

      client.dispose();
      expect(w.terminated).toBe(true);
      await expect(pending).rejects.toThrow();

      // Calls after dispose reject cleanly (no new worker spawned).
      await expect(client.embedQuery('after')).rejects.toThrow();
      await expect(client.ensureReady()).rejects.toThrow();
      expect(FakeWorker.instances).toHaveLength(1);
    });
  });

  describe('stats', () => {
    it('reports spawned/ready as the worker lifecycle progresses', async () => {
      const client = createEmbedClient({ createWorker: factory });
      expect(client.stats()).toEqual({ spawned: false, ready: false });

      const p = client.ensureReady();
      expect(client.stats()).toEqual({ spawned: true, ready: false });
      FakeWorker.instances[0].replyTo(0, { ok: true });
      await p;
      expect(client.stats()).toEqual({ spawned: true, ready: true });
    });
  });
});
