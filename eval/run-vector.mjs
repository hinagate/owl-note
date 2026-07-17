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

import { statSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { pipeline, env } from '@huggingface/transformers';

import {
  loadCorpus,
  loadGolden,
  buildIndex,
  scoreQuestion,
  primaryTag,
  summarize,
} from './harness.mjs';

// The RRF math is imported from the SHIPPED fusion module — the eval that tunes the
// weights and the runtime that uses them share one implementation and cannot drift
// (Task V3). fusion.js is a pure module (no DOM/chrome), so it imports cleanly here.
import { rrfFuse, RRF_K } from '../src/lib/fusion.js';
import {
  EMBEDDING_MODEL_ID,
  EMBEDDING_MODEL_REVISION,
  EMBEDDING_DTYPE,
  EMBEDDING_POOLING,
  EMBEDDING_NORMALIZE,
  EMBEDDING_PASSAGE_PREFIX,
  EMBEDDING_QUERY_PREFIX,
  EMBEDDING_FINGERPRINT,
} from '../src/lib/embedding-config.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const K = 5; // final cut for recall@5 / MRR
const FUSE_K = 8; // breadth of each rank list fed to RRF (matches the app's k=8)
const TAG_ORDER = ['direct', 'paraphrase', 'cjk', 'injection', 'multi-note'];

// [Task V3] --sweep mode: candidate vector weights for weighted RRF (w_lex fixed at
// 1). e5 only — the model is already in the node HF cache from E15.
const SWEEP = process.argv.includes('--sweep');
const SWEEP_WEIGHTS = [1, 1.5, 2, 3, 4];
const E5_LABEL = 'multilingual-e5-small';

// [Task V5] --write-fixtures mode: run e5 ONCE and freeze every corpus-chunk and
// golden-question embedding into eval/fixtures/vectors.json, so the CI hybrid-floor
// suite (test/eval-hybrid.test.js) can reproduce the tuned hybrid numbers with NO
// model download and NO network. e5 only, same q8 config the sweep tuned on.
const WRITE_FIXTURES = process.argv.includes('--write-fixtures');
const FIXTURES_PATH = join(HERE, 'fixtures', 'vectors.json');

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
  {
    id: EMBEDDING_MODEL_ID,
    revision: EMBEDDING_MODEL_REVISION,
    dtype: EMBEDDING_DTYPE,
    label: E5_LABEL,
    docPrefix: EMBEDDING_PASSAGE_PREFIX,
    queryPrefix: EMBEDDING_QUERY_PREFIX,
  },
];
const EXTRACT_OPTS = { pooling: EMBEDDING_POOLING, normalize: EMBEDDING_NORMALIZE };
const pipelineOptions = (model) => ({
  dtype: model.dtype || 'q8',
  ...(model.revision ? { revision: model.revision } : {}),
});

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

// (Reciprocal Rank Fusion now lives in src/lib/fusion.js and is imported above, so
// the eval and the shipped runtime fuse with the identical weighted-RRF math.)

// [Task V5] Stable content hash over the corpus chunks — the DRIFT GUARD stamped
// into vectors.json. Sort every (chunkId, text) pair and sha256 the join with
// control-char separators (NUL between id/text, SOH between pairs — neither can
// appear in a chunk id or cleaned text). test/eval-hybrid.test.js recomputes this
// from the LIVE corpus + chunker and FAILS LOUDLY on any mismatch, so a corpus or
// chunker edit can never let stale embeddings pass silently — it forces a
// regenerate. Duplicated verbatim in that test (this task must not touch the shared
// harness.mjs); if the two copies ever drift the hash simply mismatches and the test
// fails — the safe direction.
export function corpusHash(chunks) {
  const SEP = String.fromCharCode(0); // NUL between id and text
  const JOIN = String.fromCharCode(1); // SOH between pairs — neither can appear in ids/text
  const pairs = chunks.map((c) => `${c.id}${SEP}${c.text}`).sort();
  return createHash('sha256').update(pairs.join(JOIN)).digest('hex');
}

// base64-encode a Float32Array's raw little-endian bytes. WHY base64 over a JSON
// number array: 4× smaller on disk (4 base64 chars per float vs ~10+ decimal chars)
// AND it round-trips the EXACT IEEE-754 bits, so the committed vectors reproduce the
// model's output to the last mantissa bit — the CI floors are measured on identical
// numbers, never re-rounded decimals. Float32Array.from(...) copies into an
// exact-length buffer first, so the encoded bytes are precisely dim×4 (no tensor
// backing-store tail leaks in).
function encodeVec(vec) {
  const f32 = Float32Array.from(vec);
  return Buffer.from(f32.buffer).toString('base64');
}

// ---------------------------------------------------------------------------
// [Task V5] --write-fixtures: embed the whole corpus + all golden questions ONCE
// with the exact tuned e5 config (q8, mean-pooled, L2-normalized, 'passage: ' /
// 'query: ' prefixes) and freeze them into eval/fixtures/vectors.json. Runs the
// model in node (HF cache warm from E15/V3); the CI test that consumes the file
// never touches a model or the network.
// ---------------------------------------------------------------------------
async function writeFixtures({ index, chunks, golden }) {
  const model = MODELS.find((m) => m.label === E5_LABEL);
  process.stderr.write(
    `\n[write-fixtures] loading ${model.label} (q8) + embedding ${chunks.length} chunks + ${golden.questions.length} questions...\n`,
  );
  const extractor = await pipeline('feature-extraction', model.id, pipelineOptions(model));
  const embed = async (text) => (await extractor(text, EXTRACT_OPTS)).data;

  // Corpus chunks — embed the SAME cleaned `text` field the lexical index tokenizes
  // (never the raw markdown), with e5's mandatory 'passage: ' prefix.
  const chunkVecs = {};
  let dim = 0;
  for (const c of chunks) {
    const v = await embed(model.docPrefix + c.text);
    dim = v.length;
    chunkVecs[c.id] = encodeVec(v);
  }

  // Every golden question (all 47 — answerable + unanswerable), 'query: ' prefix.
  const questionVecs = {};
  for (const q of golden.questions) {
    questionVecs[q.id] = encodeVec(await embed(model.queryPrefix + q.question));
  }

  const fixture = {
    model: model.id, // Xenova/multilingual-e5-small, dtype q8 (int8) — see eval/RESULTS.md
    revision: model.revision,
    fingerprint: EMBEDDING_FINGERPRINT,
    dim, // 384
    corpusHash: corpusHash(chunks),
    chunks: chunkVecs, // { [chunkId]: base64 Float32 }
    questions: questionVecs, // { [qid]: base64 Float32 }
  };

  mkdirSync(dirname(FIXTURES_PATH), { recursive: true });
  writeFileSync(FIXTURES_PATH, JSON.stringify(fixture));
  const bytes = statSync(FIXTURES_PATH).size;
  process.stdout.write(
    `[write-fixtures] wrote ${FIXTURES_PATH}\n`
    + `  model: ${fixture.model} (q8)   dim: ${dim}\n`
    + `  chunks: ${Object.keys(chunkVecs).length}   questions: ${Object.keys(questionVecs).length}\n`
    + `  corpusHash: ${fixture.corpusHash}\n`
    + `  size: ${(bytes / 1024).toFixed(1)} KB\n`,
  );
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
  const extractor = await pipeline('feature-extraction', model.id, pipelineOptions(model));
  const loadMs = performance.now() - t0;

  const embed = async (text) => {
    const out = await extractor(text, EXTRACT_OPTS);
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

    // hybrid RRF(lexical top-8, vector top-8) — E15 measured EQUAL weights [1, 1]
    // (the --sweep mode below is what tunes w_vec); made explicit for the shared helper.
    const fused = rrfFuse([lexList.slice(0, FUSE_K), vecList.slice(0, FUSE_K)], [1, 1], RRF_K);
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
// [Task V3] Weight sweep. Embed the corpus + queries ONCE with e5, then fuse each
// question's lexical top-8 + vector top-8 with weighted RRF for every candidate
// w_vec (w_lex fixed at 1) and aggregate overall + per-tag recall@5 / MRR. Uses the
// SHARED rrfFuse imported from src/lib/fusion.js so the chosen weight and the shipped
// runtime cannot drift. Returns one row per weight.
async function runSweep({ index, chunks, answerable }) {
  const model = MODELS.find((m) => m.label === E5_LABEL);
  process.stderr.write(`\n[sweep] loading e5 + embedding ${chunks.length} chunks + ${answerable.length} queries...\n`);
  const extractor = await pipeline('feature-extraction', model.id, pipelineOptions(model));
  const embed = async (text) => (await extractor(text, EXTRACT_OPTS)).data;

  const chunkVecs = [];
  for (const c of chunks) chunkVecs.push(await embed(model.docPrefix + c.text));
  const queryVecs = new Map();
  for (const q of answerable) queryVecs.set(q.id, await embed(model.queryPrefix + q.question));

  // The lexical + vector rank lists are weight-INDEPENDENT, so build them once.
  const lists = answerable.map((q) => ({
    q,
    tag: primaryTag(q),
    lexList: index.query(q.question, FUSE_K),
    vecList: vectorRank(queryVecs.get(q.id), chunks, chunkVecs).slice(0, FUSE_K),
  }));

  const rows = [];
  for (const wVec of SWEEP_WEIGHTS) {
    const scored = lists.map(({ q, tag, lexList, vecList }) => {
      // Lexical list first (weight 1), vector list second (weight w_vec) — the exact
      // order and helper the runtime uses.
      const fused = rrfFuse([lexList, vecList], [1, wVec], RRF_K);
      return { tag, ...scoreHits(fused, q, K) };
    });
    const byTag = (tag) => scored.filter((r) => r.tag === tag);
    rows.push({
      wVec,
      overall: summarize(scored),
      byTag: Object.fromEntries(TAG_ORDER.map((t) => [t, summarize(byTag(t))])),
    });
  }
  return rows;
}

// Selection rule (Task V3 brief): maximize paraphrase R@5, then paraphrase MRR,
// among the weights that satisfy cjk R@5 ≥ 0.9, overall R@5 ≥ 0.821 (baseline), and
// direct R@5 = 1.000 (no regression). Tie-break: smallest w_vec — the least
// departure from equal-weight fusion, so the lexical list keeps maximal influence on
// the tags embeddings are weaker at. Float comparisons use a small epsilon.
function selectWeight(rows) {
  const EPS = 1e-9;
  const eligible = rows.filter((r) =>
    r.byTag.cjk.recall >= 0.9 - EPS
    && r.overall.recall >= 0.821 - EPS
    && r.byTag.direct.recall >= 1 - EPS);
  const ranked = [...eligible].sort((a, b) =>
    (b.byTag.paraphrase.recall - a.byTag.paraphrase.recall)
    || (b.byTag.paraphrase.mrr - a.byTag.paraphrase.mrr)
    || (a.wVec - b.wVec));
  return { chosen: ranked[0], eligible };
}

function renderSweep(rows, chosen) {
  const out = [];
  out.push('  w_vec |  overall        |  direct  | paraphrase      |   cjk    | injection| multi-note');
  out.push('        | R@5     MRR     |  R@5     | R@5     MRR     |  R@5     |  R@5     |  R@5    MRR');
  out.push('  ----- | ------  ------  |  ------  | ------  ------  |  ------  |  ------  | ------  ------');
  for (const r of rows) {
    const t = r.byTag;
    const mark = chosen && r.wVec === chosen.wVec ? ' <= chosen' : '';
    out.push(
      `  ${String(r.wVec).padEnd(5)} | ${f3(r.overall.recall)}   ${f3(r.overall.mrr)}  |  `
      + `${f3(t.direct.recall)}  | ${f3(t.paraphrase.recall)}   ${f3(t.paraphrase.mrr)}  |  `
      + `${f3(t.cjk.recall)}  |  ${f3(t.injection.recall)}  | ${f3(t['multi-note'].recall)}   ${f3(t['multi-note'].mrr)}${mark}`,
    );
  }
  return out.join('\n');
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

  // [Task V5] --write-fixtures: freeze the e5 embeddings into eval/fixtures/vectors.json
  // for the model-free CI hybrid-floor suite, then stop.
  if (WRITE_FIXTURES) {
    await writeFixtures({ index, chunks, golden });
    return;
  }

  // [Task V3] --sweep: tune the vector weight for weighted RRF, then stop.
  if (SWEEP) {
    const rows = await runSweep({ index, chunks, answerable });
    const { chosen, eligible } = selectWeight(rows);
    const block = [];
    block.push('M9 weighted-RRF weight sweep (Task V3) — multilingual-e5-small, q8');
    block.push('');
    block.push(`  corpus: ${index.stats().notes} notes / ${chunks.length} chunks   scored: ${answerable.length} answerable`);
    block.push(`  weighted RRF: k=${RRF_K}, w_lex=1, w_vec ∈ {${SWEEP_WEIGHTS.join(', ')}}, lists top-${FUSE_K}, cut top-${K}`);
    block.push('  selection: max paraphrase R@5 then MRR, s.t. cjk R@5 ≥ 0.9, overall ≥ 0.821, direct = 1.000');
    block.push('');
    block.push(renderSweep(rows, chosen));
    block.push('');
    block.push(`  eligible weights (pass all constraints): ${eligible.map((r) => r.wVec).join(', ') || '(none)'}`);
    block.push(chosen
      ? `  CHOSEN w_vec = ${chosen.wVec}  → paraphrase R@5 ${f3(chosen.byTag.paraphrase.recall)}, MRR ${f3(chosen.byTag.paraphrase.mrr)}; overall R@5 ${f3(chosen.overall.recall)}`
      : '  CHOSEN: (none satisfied the constraints)');
    block.push('');
    process.stdout.write(block.join('\n') + '\n');
    return;
  }

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
