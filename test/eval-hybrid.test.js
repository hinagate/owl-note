// @vitest-environment node
//
// [Task V5] CI floor gate for the M9 HYBRID retrieval config — model-free.
// This is the regression gate that locks in M9's gains WITHOUT a model download
// or network access: it reads committed embeddings from eval/fixtures/vectors.json
// (frozen once by `node eval/run-vector.mjs --write-fixtures`) and fuses them with
// the REAL shipped retrieval math — `rrfFuse`, `FUSION_WEIGHTS`, `RRF_K` imported
// straight from src/lib/fusion.js — over the REAL lexical index (eval/harness.mjs).
// So the numbers gated here are the exact numbers the runtime computes; they cannot
// drift from the shipped config by construction.
//
// The hybrid config = weighted RRF over lexical top-8 + vector top-8 (cosine =
// dot product of the L2-normalized fixture vectors), final cut top-5 — byte-for-byte
// the sweep in eval/run-vector.mjs --sweep, and it REPRODUCES that sweep's chosen
// w_vec=3 row from eval/RESULTS.md exactly:
//
//   Measured THROUGH THE FIXTURES (must match RESULTS.md "Weighted-RRF sweep" w_vec=3):
//     tag         n  | lex R@5  lex MRR | hyb R@5  hyb MRR
//     overall    39  |  0.821    0.821  |  1.000    0.926
//     direct     15  |  1.000    1.000  |  1.000    1.000
//     paraphrase 11  |  0.455    0.364  |  1.000    0.738   ← THE M9 headline (was 0.455)
//     cjk         6  |  1.000    1.000  |  1.000    1.000
//     injection   3  |  1.000    1.000  |  1.000    1.000
//     multi-note  4  |  0.750    1.000  |  1.000    1.000
//   vector sanity: all 107 vectors dim=384, norm ∈ [1.000000, 1.000000] (maxDev 3.6e-7)
//
// Floors are set as LOOSE CI bounds below the measured values (slack catches a
// code/fusion/tokenizer regression, not run-to-run noise — everything here is
// deterministic):
//   overall    R@5 >= 0.95    (measured 1.000)
//   paraphrase R@5 >= 0.90    (measured 1.000) — the before/after headline vs lexical 0.455
//   cjk        R@5 >= 0.90    (measured 1.000)
//   direct     R@5 == 1.000   (exact — no regression on the easy subset)
//   injection  R@5 >= 0.90    (measured 1.000; adversarial notes stay retrievable)
//   hybrid overall R@5 >= live lexical overall R@5   (fusion NEVER worsens retrieval)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  loadCorpus,
  loadGolden,
  buildIndex,
  scoreQuestion,
  primaryTag,
  summarize,
} from '../eval/harness.mjs';
// The REAL fusion math the extension ships — imported, never re-implemented, so the
// gated hybrid numbers are the runtime's numbers. Weight/K changes flow straight in.
import { rrfFuse, FUSION_WEIGHTS, RRF_K } from '../src/lib/fusion.js';

const K = 5; // final recall@5 / MRR cut
const FUSE_K = 8; // breadth of each rank list fed to RRF (the app's k=8; sweep's FUSE_K)

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '..', 'eval', 'fixtures', 'vectors.json');

// --- drift guard: the SAME stable content hash the writer stamps into the fixture
// (eval/run-vector.mjs `corpusHash`). Kept a verbatim copy here on purpose — this
// task must not touch the shared harness.mjs, and if the two copies ever drift the
// hash simply mismatches and this suite fails, which is the safe direction. Sort
// every (chunkId, text) pair, sha256 the join with control-char separators (NUL
// between id/text, SOH between pairs — neither can appear in an id or cleaned text).
function corpusHash(chunks) {
  const SEP = String.fromCharCode(0); // NUL between id and text
  const JOIN = String.fromCharCode(1); // SOH between pairs — neither can appear in ids/text
  const pairs = chunks.map((c) => `${c.id}${SEP}${c.text}`).sort();
  return createHash('sha256').update(pairs.join(JOIN)).digest('hex');
}

// Decode a base64 Float32 blob back to a Float32Array. Copies into a fresh, 4-byte
// aligned ArrayBuffer (a pooled Buffer's byteOffset may not be 4-aligned, which
// would make `new Float32Array(buf.buffer, buf.byteOffset, …)` throw) — the bits are
// the model's exact IEEE-754 output, so scores reproduce the writer's numbers.
function decode(b64) {
  const buf = Buffer.from(b64, 'base64');
  const ab = new ArrayBuffer(buf.length);
  new Uint8Array(ab).set(buf);
  return new Float32Array(ab);
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i];
  return s;
}

// Vector-only ranking — identical to eval/run-vector.mjs: cosine (dot of normalized
// vectors) desc, deterministic tie-break by chunk id ascending. Returns chunk objects.
function vectorRank(queryVec, chunks, chunkVecs) {
  return chunks
    .map((c, i) => ({ chunk: c, sim: dot(queryVec, chunkVecs[i]) }))
    .sort((a, b) => (b.sim - a.sim) || (a.chunk.id < b.chunk.id ? -1 : 1))
    .map((r) => r.chunk);
}

// Score a pre-ranked hit list — the SAME recall@5 / MRR + hit definition as the
// harness scorer (chunk.noteTitle ∈ relevantNotes; multi-note scores fractionally).
function scoreHits(hits, q, k = K) {
  const top = hits.slice(0, k);
  const relevant = new Set(q.relevantNotes);
  const found = new Set();
  let firstRank = 0;
  top.forEach((hit, i) => {
    if (relevant.has(hit.noteTitle)) {
      found.add(hit.noteTitle);
      if (firstRank === 0) firstRank = i + 1;
    }
  });
  const recall = relevant.size ? found.size / relevant.size : 0;
  const mrr = firstRank ? 1 / firstRank : 0;
  return { recall, mrr };
}

// --- load everything ONCE at module scope ---
const fixtures = JSON.parse(readFileSync(FIXTURES, 'utf8'));
const corpus = loadCorpus();
const golden = loadGolden();
const index = buildIndex(corpus);
const chunks = index.allChunks(); // { id, noteId, noteTitle, heading, text, raw }
const answerable = golden.questions.filter((q) => q.answerable);

const liveHash = corpusHash(chunks);
// Any chunk id the fixture is missing means the chunker's id scheme drifted — a hard
// drift the hash also catches. Guard the decode so module setup never throws before
// the drift-guard test can report the friendly regeneration message.
const missingChunkIds = chunks.filter((c) => !(c.id in fixtures.chunks)).map((c) => c.id);
const chunkVecs = chunks.map((c) => (c.id in fixtures.chunks
  ? decode(fixtures.chunks[c.id])
  : new Float32Array(fixtures.dim)));

const REGEN = 'regenerate fixtures: node eval/run-vector.mjs --write-fixtures';

// Score every answerable question with the SHIPPED hybrid config.
const scored = answerable.map((q) => {
  const qBlob = fixtures.questions[q.id];
  const qVec = qBlob ? decode(qBlob) : new Float32Array(fixtures.dim);
  const lex = scoreQuestion(index, q, K); // live lexical baseline (harness scorer)
  const lexList = index.query(q.question, FUSE_K); // lexical top-8 for fusion
  const vecList = vectorRank(qVec, chunks, chunkVecs).slice(0, FUSE_K); // vector top-8
  // The REAL runtime fusion: weighted RRF, lexical list first (keeps .weak), vector
  // list up-weighted by FUSION_WEIGHTS.vector — nothing here is re-implemented.
  const fused = rrfFuse(
    [lexList, vecList],
    [FUSION_WEIGHTS.lexical, FUSION_WEIGHTS.vector],
    RRF_K,
  );
  return { q, tag: primaryTag(q), lex: { recall: lex.recall, mrr: lex.mrr }, hyb: scoreHits(fused, q, K) };
});
const byTag = (tag) => scored.filter((r) => r.tag === tag);
const hybOf = (rows) => summarize(rows.map((r) => r.hyb));
const lexOf = (rows) => summarize(rows.map((r) => r.lex));

describe('hybrid fixtures — integrity + drift guard', () => {
  it(`corpusHash matches the live corpus+chunker (else: ${REGEN})`, () => {
    expect(missingChunkIds, `fixture missing chunk vectors — ${REGEN}`).toEqual([]);
    expect(
      liveHash,
      `corpus/chunker changed since fixtures were frozen — ${REGEN}`,
    ).toBe(fixtures.corpusHash);
  });

  it('drift guard is non-vacuous: mutating any chunk text changes the hash', () => {
    const mutated = chunks.map((c, i) => (i === 0 ? { ...c, text: `${c.text} DRIFT` } : c));
    expect(corpusHash(mutated)).not.toBe(fixtures.corpusHash);
  });

  it('fixture is the tuned e5 config: 384-dim, 60 chunks + 47 questions', () => {
    expect(fixtures.model).toContain('e5');
    expect(fixtures.dim).toBe(384);
    expect(Object.keys(fixtures.chunks)).toHaveLength(chunks.length);
    expect(Object.keys(fixtures.questions)).toHaveLength(golden.questions.length);
  });

  it('every fixture vector is 384-dim and L2-normalized (|norm - 1| < 1e-3)', () => {
    const blobs = [...Object.values(fixtures.chunks), ...Object.values(fixtures.questions)];
    expect(blobs.length).toBe(chunks.length + golden.questions.length);
    for (const b64 of blobs) {
      const v = decode(b64);
      expect(v.length).toBe(384);
      const norm = Math.sqrt(dot(v, v));
      expect(Math.abs(norm - 1)).toBeLessThan(1e-3);
    }
  });
});

describe('hybrid retrieval floors (regression gate, model-free)', () => {
  it('overall recall@5 >= 0.95 (measured 1.000)', () => {
    expect(hybOf(scored).recall).toBeGreaterThanOrEqual(0.95);
  });

  it('paraphrase recall@5 >= 0.90 — the M9 headline, was lexical 0.455 (measured 1.000)', () => {
    const s = hybOf(byTag('paraphrase'));
    expect(s.n).toBeGreaterThanOrEqual(10);
    expect(s.recall).toBeGreaterThanOrEqual(0.9);
  });

  it('cjk recall@5 >= 0.90 (measured 1.000)', () => {
    const s = hybOf(byTag('cjk'));
    expect(s.n).toBeGreaterThan(0);
    expect(s.recall).toBeGreaterThanOrEqual(0.9);
  });

  it('direct recall@5 == 1.000 exact — no regression on the easy subset', () => {
    const s = hybOf(byTag('direct'));
    expect(s.n).toBeGreaterThan(0);
    expect(s.recall).toBe(1);
  });

  it('injection recall@5 >= 0.90 — adversarial notes stay retrievable (measured 1.000)', () => {
    const s = hybOf(byTag('injection'));
    expect(s.n).toBeGreaterThan(0);
    expect(s.recall).toBeGreaterThanOrEqual(0.9);
  });

  it('fusion never worsens retrieval: hybrid overall R@5 >= live lexical overall R@5', () => {
    expect(hybOf(scored).recall).toBeGreaterThanOrEqual(lexOf(scored).recall);
  });
});
