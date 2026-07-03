// Retrieval fusion layer for Ask-Your-Notes. Its whole reason to exist is the seam:
// the controller depends on `fusion`, never on the index directly. In E3 this was a
// thin lexical passthrough over the ask index; Task V3 makes it HYBRID — lexical +
// vector retrieval fused with weighted Reciprocal Rank Fusion — WITHOUT changing the
// shape the controller/panel/app depend on. Pure module: no DOM/chrome/timers.

// Reciprocal Rank Fusion constant (Cormack et al. convention). Kept identical to the
// eval's FUSE constant; the eval imports rrfFuse from here so the two can't drift.
export const RRF_K = 60;

// Weighted-RRF weights, TUNED against the eval golden set — see eval/RESULTS.md
// "Weighted-RRF weight sweep (Task V3)". WHY not equal weights: E15 found that with
// equal weights (w_vec = 1) RRF dragged e5's paraphrase R@5 to 0.818, BELOW
// vector-only's 1.000 — fusing a lexical list that is wrong for paraphrase injects
// wrong-note chunks. Up-weighting the vector list to w_vec = 3 restores paraphrase
// R@5 to 1.000 (paraphrase MRR 0.738, overall R@5 1.000) while holding direct = 1.000
// and cjk R@5 = 1.000 — exactly the sweep's selection rule (maximize paraphrase R@5
// then MRR, subject to cjk ≥ 0.9, overall ≥ 0.821, direct = 1.000; tie-break: the
// smallest such w_vec, so lexical keeps maximal influence). The lexical list still
// contributes (w_lex = 1), so it keeps rescuing tags embeddings are weaker on and
// remains the never-fail fallback.
export const FUSION_WEIGHTS = { lexical: 1, vector: 3 };

// Breadth of each rank list fed into fusion — matches the eval's FUSE_K and the app's
// query k=8. The fused list is then cut to the caller's requested k.
const FUSE_WIDTH = 8;

// Neighbor-expansion caps (Task E3). Per-note cap keeps one dense note from
// crowding out the rest of the context; the total cap bounds what packChunks
// then trims to CHUNK_TOKEN_BUDGET.
const MAX_CHUNKS_PER_NOTE = 3;
const MAX_EXPANDED_CHUNKS = 12;

/**
 * Pure weighted Reciprocal Rank Fusion of N chunk-level rank lists.
 *
 * EXPORTED and imported by eval/run-vector.mjs's sweep so the eval that TUNED the
 * weights and the runtime that USES them compute the identical score — they cannot
 * drift. For each distinct chunk id: `score = Σ weights[list] / (k + rank)` over the
 * lists it appears in (rank is 1-based). Sorted by score desc with a deterministic
 * tie-break by chunk id (ascending) so equal scores never reorder run-to-run.
 *
 * On dedupe the FIRST-seen chunk object wins, so passing the lexical list first
 * preserves a lexical chunk's `.weak` flag even when the same chunk also appears in
 * the vector list. Returns shallow copies, each carrying the fused score as `.score`.
 *
 * @param {Array<Array<{id: string}>>} lists  rank lists (best first)
 * @param {number[]} [weights]  per-list weight (aligned to `lists`; missing → 1)
 * @param {number} [k]  RRF damping constant
 * @returns {Array<{id: string, score: number}>}
 */
export function rrfFuse(lists, weights = [], k = RRF_K) {
  const score = new Map();
  const byId = new Map();
  lists.forEach((list, li) => {
    const w = weights[li] == null ? 1 : weights[li];
    list.forEach((chunk, i) => {
      if (!byId.has(chunk.id)) byId.set(chunk.id, chunk); // first-seen wins → keeps lexical .weak
      score.set(chunk.id, (score.get(chunk.id) || 0) + w / (k + i + 1)); // 1-based rank
    });
  });
  return [...score.entries()]
    .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1))
    .map(([id, s]) => ({ ...byId.get(id), score: s }));
}

/**
 * @param {{ query, chunkById?, neighbors? }} index  the lexical ask index
 * @param {{ vector?, embedQuery? }} [deps]  V4 wires these in; omit for pure lexical
 * @returns {{ query: (question: string, k?: number) => Promise<Object[]>, expand: (chunks: Object[]) => Promise<Object[]> }}
 */
export function createFusion(index, { vector, embedQuery } = {}) {
  return {
    // Hybrid when possible, lexical otherwise. Async because the hybrid body awaits an
    // embedder; kept async even on the lexical path so the controller never changes.
    async query(question, k = 8) {
      // No vector deps wired → EXACTLY today's lexical passthrough (byte-identical).
      // WHY: the controller/panel and every existing caller/test depend on this shape;
      // V4 is what injects `vector` + `embedQuery`. createFusion(index) must not drift.
      if (!vector || !embedQuery) return index.query(question, k);

      // Lexical is ALWAYS computed: it is both a fusion input AND the never-fail
      // fallback below. Fetched at FUSE_WIDTH (the breadth the weights were tuned on).
      const lex = index.query(question, FUSE_WIDTH);

      // Hybrid only when the vector index is actually populated and ready. On first
      // run (embeddings still building) or an empty corpus the lexical result IS the
      // answer, and embedQuery must NOT be called — no point paying for an embed we
      // can't fuse against.
      const stats = vector.stats();
      if (!stats.ready || stats.chunks <= 0) return lex.slice(0, k);

      try {
        const qvec = await embedQuery(question);
        const vecHits = vector.query(qvec, FUSE_WIDTH); // [{ chunkId, noteId, score }]
        // Resolve each vector hit (it carries only a chunkId) to a full chunk via the
        // lexical index, DROPPING any id it no longer knows. WHY drop: the vector and
        // lexical indexes commit independently, so a vector row can outlive its note's
        // lexical reindex; surfacing that stale id would be a GHOST chunk that citation
        // and expand() can't resolve. A dropped hit simply doesn't feed fusion.
        const vecChunks = [];
        for (const hit of vecHits) {
          const chunk = index.chunkById(hit.chunkId);
          if (chunk) vecChunks.push(chunk);
        }
        // Lexical list FIRST so a chunk present in both keeps its lexical `.weak` flag;
        // vector-only chunks carry none. Fused score is attached as `.score`.
        return rrfFuse(
          [lex, vecChunks],
          [FUSION_WEIGHTS.lexical, FUSION_WEIGHTS.vector],
          RRF_K,
        ).slice(0, k);
      } catch {
        // ANY hybrid failure (embedQuery throws/rejects, vector.query throws) falls
        // back to the lexical result for THIS query. An ask must NEVER fail because
        // vectors hiccuped — the lexical result is always a valid answer. No retries,
        // no timers: this is a single-shot best-effort upgrade over the baseline.
        return lex.slice(0, k);
      }
    },

    // [Task E3] Enrich the ranked primaries with each hit's adjacent note chunks.
    // Primaries come FIRST, unchanged in rank order; neighbors are APPENDED after
    // ALL primaries, walked in parent-rank order. WHY appended-after: a low-ranked
    // primary is still a direct query match, while neighbors are speculative
    // context — appending lets packChunks (budget 5000, max 10) spend LEFTOVER
    // budget on neighbors without ever displacing a primary. Deduped by id;
    // per-note cap 3 (primaries count toward it and are never dropped); total
    // cap 12. Neighbors carry no `.score` — they're not query hits. Async so the
    // controller (which already awaits it) never changes. UNCHANGED by V3.
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
