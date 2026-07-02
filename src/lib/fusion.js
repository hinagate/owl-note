// Retrieval fusion layer for Ask-Your-Notes. In P1 this is a thin, deliberately
// dependency-injected passthrough over the lexical ask index. Its whole reason to
// exist is the seam: the controller depends on `fusion`, never on the index
// directly, so P3 can drop in vector search + reciprocal-rank fusion behind this
// exact shape without touching the controller. Pure module: no DOM/chrome/timers.

// Neighbor-expansion caps (Task E3). Per-note cap keeps one dense note from
// crowding out the rest of the context; the total cap bounds what packChunks
// then trims to CHUNK_TOKEN_BUDGET.
const MAX_CHUNKS_PER_NOTE = 3;
const MAX_EXPANDED_CHUNKS = 12;

/**
 * @param {{ query: (q: string, k?: number) => import('./providers/provider.js').Chunk[], neighbors?: (id: string) => import('./providers/provider.js').Chunk[] }} index
 * @returns {{ query: (question: string, k?: number) => Promise<import('./providers/provider.js').Chunk[]>, expand: (chunks: import('./providers/provider.js').Chunk[]) => Promise<import('./providers/provider.js').Chunk[]> }}
 */
export function createFusion(index) {
  return {
    // Async even though the P1 body is synchronous: P3's implementation awaits an
    // embedder, so keeping the signature async now means the controller never
    // changes when fusion gains vector retrieval. Returns the ranked Chunk[]
    // (each carrying `.score`) from the index verbatim.
    async query(question, k = 8) {
      return index.query(question, k);
    },

    // [Task E3] Enrich the ranked primaries with each hit's adjacent note chunks.
    // Primaries come FIRST, unchanged in rank order; neighbors are APPENDED after
    // ALL primaries, walked in parent-rank order. WHY appended-after: a low-ranked
    // primary is still a direct query match, while neighbors are speculative
    // context — appending lets packChunks (budget 5000, max 10) spend LEFTOVER
    // budget on neighbors without ever displacing a primary. Deduped by id;
    // per-note cap 3 (primaries count toward it and are never dropped); total
    // cap 12. Neighbors carry no `.score` — they're not query hits. Async so P3
    // can await an embedder; the controller already awaits it.
    async expand(chunks) {
      const primaries = Array.isArray(chunks) ? chunks : [];

      const out = [...primaries];
      const seen = new Set(primaries.map((c) => c.id));
      const perNote = new Map();
      for (const c of primaries) perNote.set(c.noteId, (perNote.get(c.noteId) || 0) + 1);

      const getNeighbors = typeof index.neighbors === 'function' ? index.neighbors : () => [];

      for (const primary of primaries) {
        if (out.length >= MAX_EXPANDED_CHUNKS) break;
        for (const neighbor of getNeighbors(primary.id)) {
          if (out.length >= MAX_EXPANDED_CHUNKS) break;
          if (seen.has(neighbor.id)) continue; // already a primary or earlier neighbor
          const count = perNote.get(neighbor.noteId) || 0;
          if (count >= MAX_CHUNKS_PER_NOTE) continue; // per-note cap: drop excess neighbors
          out.push(neighbor);
          seen.add(neighbor.id);
          perNote.set(neighbor.noteId, count + 1);
        }
      }
      return out;
    },
  };
}
