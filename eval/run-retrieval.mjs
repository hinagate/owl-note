// M5 retrieval evaluation (Task E2). Loads the synthetic corpus + golden
// questions, builds the REAL Ask lexical index, and prints recall@5 + MRR
// overall and per primary tag, plus a MISSES diagnostic listing every
// recall-0 question. Pure node — no browser, no model. Deterministic: same
// input -> same table (no randomness, no timestamps in the table body).
// Exit 0. Run with: npm run eval:retrieval

import {
  loadCorpus,
  loadGolden,
  buildIndex,
  scoreQuestion,
  primaryTag,
  summarize,
} from './harness.mjs';

const K = 5;
// Row order for the per-tag breakdown (unanswerable is not scored here).
const TAG_ORDER = ['direct', 'paraphrase', 'cjk', 'injection', 'multi-note'];

const f3 = (x) => x.toFixed(3);

const corpus = loadCorpus();
const golden = loadGolden();
const index = buildIndex(corpus);
const { notes, chunks } = index.stats();

// Score every answerable question. Unanswerable questions have no relevant
// notes, so recall@5 / MRR are undefined for them — they measure abstention,
// which is Answer-QA's job (E4), not retrieval's. We skip them here and only
// report how many were skipped.
const scored = [];
let skipped = 0;
for (const q of golden.questions) {
  if (!q.answerable) { skipped += 1; continue; }
  const s = scoreQuestion(index, q, K);
  scored.push({ q, tag: primaryTag(q), ...s });
}

const byTag = (tag) => scored.filter((r) => r.tag === tag);

// ---- Table -----------------------------------------------------------------
const rows = [
  ['overall', summarize(scored)],
  ...TAG_ORDER.map((tag) => [tag, summarize(byTag(tag))]),
];

const out = [];
out.push('Retrieval evaluation v1 — recall@5 / MRR (top-5 lexical, MiniSearch)');
out.push('');
out.push(`  corpus: ${notes} notes / ${chunks} chunks   scored: ${scored.length} answerable   skipped: ${skipped} unanswerable`);
out.push('');
out.push('  tag           n   recall@5    MRR');
out.push('  ----------  ---  --------  -----');
for (const [name, s] of rows) {
  out.push(`  ${name.padEnd(10)}  ${String(s.n).padStart(3)}   ${f3(s.recall).padStart(6)}  ${f3(s.mrr).padStart(5)}`);
}

// ---- Misses (diagnostic payload) ------------------------------------------
const misses = scored.filter((r) => r.recall === 0);
out.push('');
out.push(`MISSES (recall@5 == 0): ${misses.length}`);
if (misses.length === 0) {
  out.push('  (none)');
} else {
  for (const r of misses) {
    out.push(`  [${r.q.id}] ${r.tag}  "${r.q.question}"`);
    out.push(`        expected: ${r.q.relevantNotes.join(' | ')}`);
  }
}

process.stdout.write(out.join('\n') + '\n');
