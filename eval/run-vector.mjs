// M9 feasibility spike (Task E15) — measure whether on-device-class embedding
// models actually improve retrieval over the committed lexical baseline, BEFORE
// any extension code is built. Eval-first gate: this script's OUTPUT is numbers,
// not a feature. Pure node; the only new dependency is the DEV-only
// @huggingface/transformers (the extension bundle is untouched).
//
// It reuses the REAL retrieval stack: the lexical index is the same
// createAskIndex() the extension ships (via eval/harness.mjs), and the hit
// definition + summarize() are imported from the harness so the vector/hybrid
// numbers are measured IDENTICALLY to the committed lexical table.
//
// For each candidate model it prints, per model:
//   - a lexical / vector-only / hybrid-RRF table (overall + all 5 answerable tags)
//   - a MISSES diff (lexical misses fixed by hybrid; lexical HITS lost by hybrid)
//   - embedding perf (chunks, total embed time, ms/chunk, model load, dl size)
//
// Determinism: embeddings are deterministic per model version, and the lexical
// index is deterministic, so a SINGLE run is authoritative (no §6 variance loop).
//
// Run with:  node eval/run-vector.mjs   (first run downloads models to the HF
// node cache under node_modules/@huggingface/transformers/.cache — tens of MB,
// allow a few minutes).

import { statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { pipeline, env } from '@huggingface/transformers';

import {
  loadCorpus,
  loadGolden,
  buildIndex,
  scoreQuestion,
  primaryTag,
  summarize,
} from './harness.mjs';

const K = 5; // final cut for recall@5 / MRR
const FUSE_K = 8; // breadth of each rank list fed to RRF (matches the app's k=8)
const RRF_K = 60; // Reciprocal Rank Fusion constant; k=60 is the Cormack et al. convention
const TAG_ORDER = ['direct', 'paraphrase', 'cjk', 'injection', 'multi-note'];

// Candidate models (plan §9). MiniLM is the English-centric default; e5-small is
// the multilingual alternative — and the user's notes are CHINESE, so the cjk
// subset is a kill criterion. E5 was trained with instruction prefixes: passages
// are embedded as "passage: <text>" and queries as "query: <text>". Dropping the
// prefixes measurably CRIPPLES e5 retrieval, so they are mandatory here (MiniLM
// takes no prefix). dtype:'q8' selects the int8-quantized model_quantized.onnx
// (~a third the size of fp32) — the on-device-class artifact the extension would
// actually ship; the installed transformers.js is v4, where 'quantized:true' is
// superseded by the dtype option.
const MODELS = [
  { id: 'Xenova/all-MiniLM-L6-v2', label: 'MiniLM-L6-v2', docPrefix: '', queryPrefix: '' },
  { id: 'Xenova/multilingual-e5-small', label: 'multilingual-e5-small', docPrefix: 'passage: ', queryPrefix: 'query: ' },
];

const f3 = (x) => x.toFixed(3);

// ---------------------------------------------------------------------------
// Scoring on a pre-ranked hit list. This is the SAME recall@5 / MRR + hit
// definition as harness.scoreQuestion (chunk.noteTitle ∈ relevantNotes;
// multi-note questions score fractionally), copied out here because
// scoreQuestion computes its own hits via index.query() — vector-only and hybrid
// supply their OWN ranked hit list, so we score that list directly. Kept
// byte-for-byte equivalent to the harness so lexical/vector/hybrid are comparable.
// ---------------------------------------------------------------------------
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

// Dot product of two L2-normalized Float32 vectors == cosine similarity.
function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i];
  return s;
}

// Vector-only ranking: every chunk scored by cosine to the query embedding,
// sorted desc. Deterministic tie-break by chunk id so equal scores never reorder
// run-to-run. Returns chunk objects (carrying noteTitle) in rank order.
function vectorRank(queryVec, chunks, chunkVecs) {
  return chunks
    .map((c, i) => ({ chunk: c, sim: dot(queryVec, chunkVecs[i]) }))
    .sort((a, b) => (b.sim - a.sim) || (a.chunk.id < b.chunk.id ? -1 : 1))
    .map((r) => r.chunk);
}

// Reciprocal Rank Fusion of two chunk-level rank lists. score(d) = Σ 1/(k+rank_i(d))
// over the lists in which d appears (1-based ranks, k=60). Documents = chunks
// (both input lists are chunk lists), so the fused top-5 is scored by noteTitle
// exactly like the other two columns. Deterministic tie-break by chunk id.
function rrfFuse(lists, k = RRF_K) {
  const score = new Map();
  const byId = new Map();
  for (const list of lists) {
    list.forEach((chunk, i) => {
      byId.set(chunk.id, chunk);
      score.set(chunk.id, (score.get(chunk.id) || 0) + 1 / (k + i + 1));
    });
  }
  return [...score.entries()]
    .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1))
    .map(([id]) => byId.get(id));
}

// Approximate on-disk download size of a cached model (sum of every file under
// cacheDir/<owner>/<name>). Reported as "approximate download size".
function dirSizeBytes(dir) {
  let total = 0;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += dirSizeBytes(p);
    else {
      try { total += statSync(p).size; } catch { /* ignore */ }
    }
  }
  return total;
}
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

// ---------------------------------------------------------------------------
// Embed one model over the whole corpus + queries and score all three configs.
// Returns { perf, rowsByConfig, perQuestion } or throws (caller reports + skips).
// ---------------------------------------------------------------------------
async function runModel(model, { corpus, golden, index, chunks, answerable }) {
  // --- load ---
  const t0 = performance.now();
  const extractor = await pipeline('feature-extraction', model.id, { dtype: 'q8' });
  const loadMs = performance.now() - t0;

  const embed = async (text) => {
    const out = await extractor(text, { pooling: 'mean', normalize: true });
    return out.data; // Float32Array (mean-pooled, L2-normalized)
  };

  // --- embed every chunk's cleaned `text` field (the SAME field the lexical
  //     index tokenizes — never the raw markdown), timed for ms/chunk ---
  const te0 = performance.now();
  const chunkVecs = [];
  for (const c of chunks) chunkVecs.push(await embed(model.docPrefix + c.text));
  const embedMs = performance.now() - te0;

  // --- embed every answerable question (query prefix for e5) ---
  const queryVecs = new Map();
  for (const q of answerable) queryVecs.set(q.id, await embed(model.queryPrefix + q.question));

  // --- score each answerable question across the three configs ---
  const perQuestion = [];
  for (const q of answerable) {
    const qv = queryVecs.get(q.id);

    // lexical baseline — recomputed LIVE via the real index (harness scorer)
    const lex = scoreQuestion(index, q, K);
    // the lexical top-8 rank list for RRF (chunk objects, in rank order)
    const lexList = index.query(q.question, FUSE_K);

    // vector-only
    const vecList = vectorRank(qv, chunks, chunkVecs);
    const vec = scoreHits(vecList, q, K);

    // hybrid RRF(lexical top-8, vector top-8)
    const fused = rrfFuse([lexList.slice(0, FUSE_K), vecList.slice(0, FUSE_K)]);
    const hyb = scoreHits(fused, q, K);

    perQuestion.push({
      q,
      tag: primaryTag(q),
      lex: { recall: lex.recall, mrr: lex.mrr },
      vec,
      hyb,
    });
  }

  // --- aggregate into the per-tag table rows (overall + 5 tags) ---
  const rowsFor = (rows) => ({
    lex: summarize(rows.map((r) => r.lex)),
    vec: summarize(rows.map((r) => r.vec)),
    hyb: summarize(rows.map((r) => r.hyb)),
  });
  const byTag = (tag) => perQuestion.filter((r) => r.tag === tag);
  const table = [
    ['overall', rowsFor(perQuestion)],
    ...TAG_ORDER.map((tag) => [tag, rowsFor(byTag(tag))]),
  ];

  const dlBytes = dirSizeBytes(join(env.cacheDir, ...model.id.split('/')));

  return {
    table,
    perQuestion,
    perf: {
      chunks: chunks.length,
      embedMs,
      msPerChunk: embedMs / chunks.length,
      loadMs,
      dlBytes,
    },
  };
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------
function renderTable(label, table) {
  const out = [];
  out.push(`model: ${label}`);
  out.push('  tag           n  | lex R@5  lex MRR | vec R@5  vec MRR | hyb R@5  hyb MRR');
  out.push('  ----------  ---  |  ------   ------  |  ------   ------  |  ------   ------');
  for (const [name, s] of table) {
    out.push(
      `  ${name.padEnd(10)}  ${String(s.lex.n).padStart(3)}  |  `
      + `${f3(s.lex.recall)}   ${f3(s.lex.mrr)}  |  `
      + `${f3(s.vec.recall)}   ${f3(s.vec.mrr)}  |  `
      + `${f3(s.hyb.recall)}   ${f3(s.hyb.mrr)}`,
    );
  }
  return out.join('\n');
}

function renderMissesDiff(perQuestion) {
  const out = [];
  // lexical MISSES fixed by hybrid (recall 0 -> >0)
  const fixed = perQuestion.filter((r) => r.lex.recall === 0 && r.hyb.recall > 0);
  // lexical HITS lost by hybrid (any drop; regressions matter as much as gains)
  const lost = perQuestion.filter((r) => r.hyb.recall < r.lex.recall);
  out.push(`  lexical misses FIXED by hybrid: ${fixed.length}`);
  for (const r of fixed) {
    out.push(`    [${r.q.id}] ${r.tag}  lex ${f3(r.lex.recall)} -> hyb ${f3(r.hyb.recall)}  "${r.q.question}"`);
  }
  out.push(`  lexical hits LOST by hybrid (regressions): ${lost.length}`);
  if (lost.length === 0) out.push('    (none)');
  for (const r of lost) {
    out.push(`    [${r.q.id}] ${r.tag}  lex ${f3(r.lex.recall)} -> hyb ${f3(r.hyb.recall)}  "${r.q.question}"`);
  }
  return out.join('\n');
}

function renderPerf(perf) {
  return [
    `  chunks embedded: ${perf.chunks}`,
    `  total embed time: ${(perf.embedMs / 1000).toFixed(2)} s   ms/chunk: ${perf.msPerChunk.toFixed(1)} ms`,
    `  model load time: ${(perf.loadMs / 1000).toFixed(2)} s`,
    `  approx download size (int8/q8, on disk): ${mb(perf.dlBytes)}`,
    '  NOTE: node CPU (onnxruntime-node) — browser WASM runs ~2-4x slower.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
async function main() {
  // Quiet the transformers.js progress spam so the tables are readable.
  env.allowLocalModels = false;

  const corpus = loadCorpus();
  const golden = loadGolden();
  const index = buildIndex(corpus);
  const chunks = index.allChunks(); // { id, noteId, noteTitle, heading, text, raw }
  const answerable = golden.questions.filter((q) => q.answerable);

  const out = [];
  out.push('M9 semantic-retrieval spike (Task E15) — lexical vs vector-only vs hybrid RRF');
  out.push('');
  out.push(`  corpus: ${index.stats().notes} notes / ${chunks.length} chunks   scored: ${answerable.length} answerable`);
  out.push(`  RRF: k=${RRF_K}, fusing lexical top-${FUSE_K} + vector top-${FUSE_K}; final cut top-${K}`);
  out.push('  Determinism: embeddings + lexical index are deterministic — single run is authoritative.');
  out.push('');
  process.stdout.write(out.join('\n') + '\n\n');

  for (const model of MODELS) {
    process.stderr.write(`\n[${model.label}] loading + embedding ${chunks.length} chunks + ${answerable.length} queries...\n`);
    try {
      const res = await runModel(model, { corpus, golden, index, chunks, answerable });
      const block = [];
      block.push('='.repeat(76));
      block.push(renderTable(model.label, res.table));
      block.push('');
      block.push('  MISSES diff (lexical vs hybrid):');
      block.push(renderMissesDiff(res.perQuestion));
      block.push('');
      block.push('  PERF:');
      block.push(renderPerf(res.perf));
      block.push('');
      process.stdout.write(block.join('\n') + '\n');
    } catch (err) {
      process.stdout.write(
        `\n[${model.label}] FAILED to load/run in node: ${err && err.message ? err.message : err}\n`
        + '  (reported as a finding; continuing with the other model)\n\n',
      );
      process.stderr.write(`${err && err.stack ? err.stack : err}\n`);
    }
  }
}

main().catch((err) => { process.stderr.write(`${err && err.stack ? err.stack : err}\n`); process.exit(1); });
