// Vector retrieval index for Ask-Your-Notes: the semantic twin of ask-index.js.
// It stores one L2-normalized embedding per chunk, persists them in IndexedDB
// (embed once, keep forever — re-embedding a whole corpus is the expensive part
// of on-device retrieval), and answers dot-product top-k queries over an in-memory
// mirror. Bookkeeping is per NOTE (content hash + its chunk ids), mirroring
// ask-index's notes-Map so upserts touch exactly the chunks that changed.
//
// This is a PURE store/search module: the embedder is INJECTED (V2 supplies the
// model worker client; tests supply a deterministic fake), so there is no
// model/network code here. IndexedDB is a web API — fine in both the app page and
// tests (via fake-indexeddb). No chrome.* APIs, no timers.

// The model these vectors were produced by. Stored in the `meta` store so a future
// model swap (different dim/geometry) can DETECT the mismatch and rebuild rather
// than silently mixing incompatible vectors. Kept as a constant, not a param —
// V1 has exactly one embedder (spike E15: multilingual-e5-small).
const MODEL_ID = 'Xenova/multilingual-e5-small';
const SCHEMA_VERSION = 1;
const CHUNKS_STORE = 'chunks';
const META_STORE = 'meta';

// Dot product of two vectors. The embedder L2-normalizes every vector, so the dot
// product IS the cosine similarity — no per-query normalization needed. Iterates
// the shorter length as a guard against a mismatched-dim query vector.
function dot(a, b) {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i += 1) s += a[i] * b[i];
  return s;
}

// Promise wrappers for the callback-based IDB API. A request resolves with its
// result; a transaction resolves on commit (the point at which writes are durable).
function reqDone(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function createVectorIndex({ dbName = 'owl-ask-vectors' } = {}) {
  let db = null;
  // chunkId -> { noteId, vector: Float32Array } — the search mirror (hot path).
  const chunks = new Map();
  // noteId -> { hash, chunkIds: string[] } — the incremental-diff bookkeeping,
  // rebuilt from the chunk rows on open (each row carries its note's hash).
  const notes = new Map();

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, SCHEMA_VERSION);
      req.onupgradeneeded = () => {
        const idb = req.result;
        if (!idb.objectStoreNames.contains(CHUNKS_STORE)) {
          const store = idb.createObjectStore(CHUNKS_STORE, { keyPath: 'id' });
          // byNote lets removeNote find a note's rows without scanning the store.
          store.createIndex('byNote', 'noteId', { unique: false });
        }
        if (!idb.objectStoreNames.contains(META_STORE)) {
          const meta = idb.createObjectStore(META_STORE, { keyPath: 'key' });
          meta.put({ key: 'schema', version: SCHEMA_VERSION });
          meta.put({ key: 'model', model: MODEL_ID });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // Load every stored chunk into the in-memory mirror (a few hundred chunks ×
  // 384 floats — tiny). Vectors round-trip as { ArrayBuffer, dim }; reconstruct
  // the Float32Array view here.
  async function loadMirror() {
    const tx = db.transaction(CHUNKS_STORE, 'readonly');
    const rows = await reqDone(tx.objectStore(CHUNKS_STORE).getAll());
    chunks.clear();
    notes.clear();
    for (const row of rows) {
      chunks.set(row.id, { noteId: row.noteId, vector: new Float32Array(row.vector) });
      let entry = notes.get(row.noteId);
      if (!entry) { entry = { hash: row.hash, chunkIds: [] }; notes.set(row.noteId, entry); }
      entry.chunkIds.push(row.id);
    }
  }

  // Write ONE note atomically: in a single transaction, delete its old chunk rows
  // (so a shrunk note's stale chunks can't linger) and put the fresh vectors. The
  // transaction is all-or-nothing — a failed request aborts it and touches nothing.
  // The in-memory mirror is updated only AFTER commit, keeping memory == db.
  function writeNote(note, vectors) {
    const existing = notes.get(note.id);
    const oldChunkIds = existing ? existing.chunkIds : [];
    // Copy each embedding into its OWN ArrayBuffer: it may be a view into a larger
    // buffer the embedder reuses, and IDB persists the value as an ArrayBuffer.
    const copies = note.chunks.map((c, i) => new Float32Array(vectors[i]));

    const tx = db.transaction(CHUNKS_STORE, 'readwrite');
    const store = tx.objectStore(CHUNKS_STORE);
    for (const id of oldChunkIds) store.delete(id);
    note.chunks.forEach((c, i) => {
      const vec = copies[i];
      store.put({ id: c.id, noteId: note.id, hash: note.hash, vector: vec.buffer, dim: vec.length });
    });

    return txDone(tx).then(() => {
      for (const id of oldChunkIds) chunks.delete(id);
      const chunkIds = [];
      note.chunks.forEach((c, i) => {
        chunks.set(c.id, { noteId: note.id, vector: copies[i] });
        chunkIds.push(c.id);
      });
      notes.set(note.id, { hash: note.hash, chunkIds });
    });
  }

  return {
    // Open/upgrade the db and load all vectors into memory. Idempotent — a second
    // call is a no-op (the mirror is already populated).
    async open() {
      if (db) return;
      db = await openDb();
      await loadMirror();
    },

    // The incremental diff. notes = [{ id, hash, chunks: [{ id, text }] }].
    // Unchanged hash → skipped (embed NOT called). Changed/new → embed its chunk
    // texts, then replace the note's rows. Notes ABSENT from the list are left
    // alone (removal is explicit, via removeNote).
    //
    // Atomicity: each note is embedded THEN written on its own — IDB transactions
    // cannot span an await, so this is unavoidable, and we lean on it. If embed()
    // rejects, the loop propagates the rejection: notes already written stay
    // committed, the failing note keeps its OLD rows (or stays absent if new), and
    // later notes are NOT attempted. Callers re-run upsertMissing to resume.
    async upsertMissing(notesList, embed, { onProgress } = {}) {
      if (!db) throw new Error('vector-index: call open() before upsertMissing()');
      const toEmbed = notesList.filter((n) => {
        const existing = notes.get(n.id);
        return !(existing && n.hash !== undefined && existing.hash === n.hash);
      });
      const total = toEmbed.length;
      let done = 0;
      for (const note of toEmbed) {
        // embed FIRST (the await) — a rejection here happens before any write, so
        // this note's prior data is untouched and no later note is attempted.
        const vectors = await embed(note.chunks.map((c) => c.text));
        await writeNote(note, vectors);
        done += 1;
        if (onProgress) onProgress(done, total);
      }
    },

    // Delete a note's chunk vectors from db + memory. Unknown id → no-op.
    async removeNote(noteId) {
      const existing = notes.get(noteId);
      if (!existing) return;
      const tx = db.transaction(CHUNKS_STORE, 'readwrite');
      const store = tx.objectStore(CHUNKS_STORE);
      for (const id of existing.chunkIds) store.delete(id);
      await txDone(tx);
      for (const id of existing.chunkIds) chunks.delete(id);
      notes.delete(noteId);
    },

    // Dot-product top-k over the memory mirror → [{ chunkId, noteId, score }]
    // descending, tie-broken by chunkId (ascending) so equal scores never reorder
    // run-to-run. [] when not open, empty, or given no query vector.
    query(queryVec, k = 8) {
      if (!db || chunks.size === 0 || !queryVec || queryVec.length === 0 || k <= 0) return [];
      const results = [];
      for (const [chunkId, entry] of chunks) {
        results.push({ chunkId, noteId: entry.noteId, score: dot(queryVec, entry.vector) });
      }
      results.sort((a, b) => (b.score - a.score) || (a.chunkId < b.chunkId ? -1 : 1));
      return results.slice(0, k);
    },

    stats() {
      return { notes: notes.size, chunks: chunks.size, ready: !!db };
    },

    // Wipe every chunk vector (db + memory) — the full-rebuild path. The meta row
    // (model id) is identity, not data, so it is left in place.
    async clear() {
      if (db) {
        const tx = db.transaction(CHUNKS_STORE, 'readwrite');
        tx.objectStore(CHUNKS_STORE).clear();
        await txDone(tx);
      }
      chunks.clear();
      notes.clear();
    },
  };
}
