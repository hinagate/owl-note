// Retrieval fusion layer for Ask-Your-Notes. In P1 this is a thin, deliberately
// dependency-injected passthrough over the lexical ask index. Its whole reason to
// exist is the seam: the controller depends on `fusion`, never on the index
// directly, so P3 can drop in vector search + reciprocal-rank fusion behind this
// exact shape without touching the controller. Pure module: no DOM/chrome/timers.

/**
 * @param {{ query: (q: string, k?: number) => import('./providers/provider.js').Chunk[] }} index
 * @returns {{ query: (question: string, k?: number) => Promise<import('./providers/provider.js').Chunk[]> }}
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
  };
}
