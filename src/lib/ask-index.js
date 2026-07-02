// Lexical retrieval index for Ask-Your-Notes: wraps MiniSearch over per-note
// chunks (see chunker.js) and tracks bookkeeping (content hash + citation
// metadata) so upserts/removals touch exactly the chunks that changed.
// Pure module — no chrome/DOM APIs, no timers. This is the M1 retrieval
// core; embeddings, fusion, and app wiring are later tasks.

import MiniSearch from 'minisearch';
import { chunkNote } from './chunker.js';

// Fields we search over, and the boosts that make title/heading matches
// outrank a plain body match. `prefix`/`fuzzy` give typo- and
// substring-tolerant matching; `combineWith: 'AND'` is the default strategy,
// with an 'OR' retry in query() when AND finds nothing.
const SEARCH_OPTIONS = {
  boost: { noteTitle: 3, heading: 2 },
  prefix: true,
  fuzzy: 0.2,
  combineWith: 'AND',
};

// Chunk shape from chunker.js — stored in full so query() can return
// ready-to-use chunks without a second lookup.
const CHUNK_STORE_FIELDS = ['id', 'noteId', 'noteTitle', 'heading', 'text', 'raw'];

function newMiniSearch() {
  return new MiniSearch({
    fields: ['text', 'noteTitle', 'heading'],
    storeFields: CHUNK_STORE_FIELDS,
    searchOptions: SEARCH_OPTIONS,
  });
}

// Citation metadata captured at index time — a citation click resolves the
// bookmark/folder through this snapshot rather than re-reading the note.
function metaOf(note) {
  return {
    bookmarkId: note.bookmarkId,
    localOnly: note.localOnly,
    folderId: note.folderId,
    title: note.title,
  };
}

export function createAskIndex() {
  let mini = newMiniSearch();
  // noteId -> { hash, meta, chunkIds }
  const notes = new Map();

  function addNote(note) {
    const chunks = chunkNote(note);
    mini.addAll(chunks);
    notes.set(note.id, {
      hash: note.hash,
      meta: metaOf(note),
      chunkIds: chunks.map((c) => c.id),
    });
  }

  // discard() throws for an id no longer in the index, so guard with has().
  function discardChunks(chunkIds) {
    for (const id of chunkIds) {
      if (mini.has(id)) mini.discard(id);
    }
  }

  return {
    // Full (re)build: clears prior state, chunks every note, and indexes
    // them fresh. Used on startup / whenever the whole note set is known.
    build(notesList) {
      mini = newMiniSearch();
      notes.clear();
      for (const note of notesList) addNote(note);
    },

    // Add or refresh one note. If its content hash is unchanged, the chunks
    // are left alone (no reindex cost) but meta is still refreshed, since
    // bookmarkId/folderId can change (e.g. a move between notebooks)
    // without the body changing. A missing hash is treated as always-changed
    // so callers that don't track hashes still get correct behavior.
    upsertNote(note) {
      const existing = notes.get(note.id);
      if (existing && note.hash !== undefined && existing.hash === note.hash) {
        existing.meta = metaOf(note);
        return;
      }
      if (existing) discardChunks(existing.chunkIds);
      addNote(note);
    },

    removeNote(noteId) {
      const existing = notes.get(noteId);
      if (!existing) return; // unknown id: no-op
      discardChunks(existing.chunkIds);
      notes.delete(noteId);
    },

    // Ranked chunks for a query. Tries AND first (precise); if that yields
    // nothing, retries with OR so a query with one matching word and one
    // non-matching word still returns something useful.
    query(q, k = 8) {
      const text = String(q ?? '').trim();
      if (!text) return [];

      let hits = mini.search(text);
      if (hits.length === 0) hits = mini.search(text, { combineWith: 'OR' });

      return hits.slice(0, k).map((hit) => ({
        id: hit.id,
        noteId: hit.noteId,
        noteTitle: hit.noteTitle,
        heading: hit.heading,
        text: hit.text,
        raw: hit.raw,
        score: hit.score,
      }));
    },

    // All indexed chunks, unranked — feeds the embedder (Phase 3).
    allChunks() {
      const out = [];
      for (const entry of notes.values()) {
        for (const id of entry.chunkIds) {
          const stored = mini.getStoredFields(id);
          if (stored) out.push({ ...stored });
        }
      }
      return out;
    },

    noteMeta(noteId) {
      const entry = notes.get(noteId);
      return entry ? entry.meta : undefined;
    },

    stats() {
      let chunks = 0;
      for (const entry of notes.values()) chunks += entry.chunkIds.length;
      return { notes: notes.size, chunks };
    },
  };
}
