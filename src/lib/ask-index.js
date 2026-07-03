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

// [T10/M4.5 Part 2a] CJK bigram tokenizer. MiniSearch's default splits on
// whitespace/punctuation (SPACE_OR_PUNCTUATION), which leaves an unspaced CJK run
// as ONE token — so a query term can't line up with it and the note is unfindable.
// We wrap the default tokenizer: latin/other tokens pass through UNCHANGED (this is
// a strict SUPERSET, keeping every existing latin test byte-identical), while CJK
// runs are re-emitted as overlapping character bigrams so a query's bigrams overlap
// the note's. Used for BOTH indexing and search: it's set as the constructor
// `tokenize`, which MiniSearch also inherits at query time (no searchOptions.tokenize
// override is present), so index and query tokenization always agree.
//
// CJK codepoint ranges (Plan §5.2): Han (+ Ext-A / compatibility), the Kana block
// (Hiragana/Katakana, incl. the prolonged-sound mark), and Hangul (syllables + Jamo).
const CJK_CODEPOINT =
  /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯ᄀ-ᇿ㄰-㆏ꥠ-꥿]/;
const defaultTokenize = MiniSearch.getDefault('tokenize');

// Overlapping 2-char shingles of a CJK run; a single CJK char emits itself.
function cjkBigrams(run) {
  const chars = Array.from(run); // split by code point (astral-safe)
  if (chars.length < 2) return chars;
  const grams = [];
  for (let i = 0; i < chars.length - 1; i += 1) grams.push(chars[i] + chars[i + 1]);
  return grams;
}

function tokenize(text, fieldName) {
  const base = defaultTokenize(text, fieldName);
  const out = [];
  for (const token of base) {
    if (!CJK_CODEPOINT.test(token)) { out.push(token); continue; } // pure-latin: untouched
    // Mixed token: walk it into maximal CJK / non-CJK runs, bigramming only the CJK.
    let run = '';
    let runIsCjk = false;
    const flush = () => {
      if (!run) return;
      if (runIsCjk) out.push(...cjkBigrams(run));
      else out.push(run);
      run = '';
    };
    for (const ch of token) {
      const isCjk = CJK_CODEPOINT.test(ch);
      if (run && isCjk !== runIsCjk) flush();
      run += ch;
      runIsCjk = isCjk;
    }
    flush();
  }
  return out;
}

// Chunk shape from chunker.js — stored in full so query() can return
// ready-to-use chunks without a second lookup.
const CHUNK_STORE_FIELDS = ['id', 'noteId', 'noteTitle', 'heading', 'text', 'raw'];

function newMiniSearch() {
  return new MiniSearch({
    fields: ['text', 'noteTitle', 'heading'],
    storeFields: CHUNK_STORE_FIELDS,
    searchOptions: SEARCH_OPTIONS,
    tokenize, // CJK-aware superset; inherited for query-time tokenization too
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
      // The OR retry rescues partial matches — but for a conversational, non-note
      // request ("draft an email to my boss…") it matches pure stopword noise
      // ("to", "a"). Tag those hits `weak` so the UI can avoid presenting them as
      // meaningful "Related notes" when the model also found nothing to cite.
      let weak = false;
      if (hits.length === 0) { hits = mini.search(text, { combineWith: 'OR' }); weak = true; }

      return hits.slice(0, k).map((hit) => ({
        id: hit.id,
        noteId: hit.noteId,
        noteTitle: hit.noteTitle,
        heading: hit.heading,
        text: hit.text,
        raw: hit.raw,
        score: hit.score,
        ...(weak ? { weak: true } : {}),
      }));
    },

    // [Task E3] Adjacent stored chunks of the SAME note — the one before and the
    // one after `chunkId` in the note's ordered chunkIds — for fusion.expand's
    // neighbor context (answers often straddle a chunk boundary). Position comes
    // from the chunkIds array, NEVER from string-parsing the `::n` suffix, because
    // a note id may itself contain '::'. Unknown/malformed id → [] (never throws).
    neighbors(chunkId) {
      const stored = mini.getStoredFields(chunkId); // undefined for unknown/malformed id
      if (!stored) return [];
      const entry = notes.get(stored.noteId);
      if (!entry) return [];
      const ids = entry.chunkIds;
      const pos = ids.indexOf(chunkId);
      if (pos === -1) return [];
      const out = [];
      for (const offset of [-1, 1]) { // prev then next, in that order
        const neighborId = ids[pos + offset];
        if (neighborId === undefined) continue; // edge chunk: no prev / no next
        const neighbor = mini.getStoredFields(neighborId);
        if (neighbor) out.push({ ...neighbor });
      }
      return out;
    },

    // [Task E7] The ordered stored chunks of ONE note (its full chunk set, in the
    // note's document order via chunkIds) — used to pin the currently-open note into
    // the model context. Same notes-Map → getStoredFields pattern as neighbors() and
    // allChunks(); an unknown/undefined id → [] (never throws), mirroring neighbors().
    chunksOf(noteId) {
      const entry = notes.get(noteId);
      if (!entry) return [];
      const out = [];
      for (const id of entry.chunkIds) {
        const stored = mini.getStoredFields(id);
        if (stored) out.push({ ...stored });
      }
      return out;
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
