// Shared eval harness for the M5 retrieval evaluation (Task E2). Pure node —
// no browser, no model. Loads eval/corpus/*.md + eval/golden.json, builds the
// REAL Ask retrieval index (createAskIndex from src), and scores each golden
// question with recall@5 + MRR. Imported by BOTH eval/run-retrieval.mjs (the
// metrics script) and test/eval-retrieval.test.js (the CI floor gate) so the
// committed numbers and the regression test are measured identically.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createAskIndex } from '../src/lib/ask-index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(HERE, 'corpus');
const GOLDEN = join(HERE, 'golden.json');

// The primary tag vocabulary — kept in lockstep with test/eval-fixtures.test.js.
export const PRIMARY_TAGS = ['direct', 'paraphrase', 'cjk', 'injection', 'multi-note', 'unanswerable'];

// Parse the fixed frontmatter block. Deliberately the SAME strict regex as
// test/eval-fixtures.test.js (title must be quoted; block must open the file)
// so the loader and the integrity gate agree on "exactly this format".
function parseNote(raw) {
  // Normalize CRLF: on Windows, a branch checkout with core.autocrlf rewrites the
  // corpus files with \r\n and the strict `---\n` anchor stops matching (real
  // incident: a main<->feat/ask switch broke all three eval suites at collection).
  const text = String(raw).replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  const [, front, body] = m;
  const title = /^title:\s*"(.+)"\s*$/m.exec(front);
  const lang = /^lang:\s*([a-z-]+)\s*$/m.exec(front);
  const tags = /^tags:\s*\[(.*)\]\s*$/m.exec(front);
  if (!title || !lang || !tags) return null;
  return {
    title: title[1],
    lang: lang[1],
    tags: tags[1].split(',').map((t) => t.trim()).filter(Boolean),
    body,
  };
}

// Load corpus/*.md into notes: id = filename (no .md), title/lang/tags from
// frontmatter, body = everything after the closing `---`. Sorted by filename
// so index build order is deterministic across filesystems.
export function loadCorpus() {
  return readdirSync(CORPUS)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((file) => {
      const raw = readFileSync(join(CORPUS, file), 'utf8');
      const parsed = parseNote(raw);
      if (!parsed) throw new Error(`unparseable frontmatter: ${file}`);
      return {
        id: file.replace(/\.md$/, ''),
        title: parsed.title,
        lang: parsed.lang,
        tags: parsed.tags,
        body: parsed.body,
      };
    });
}

export function loadGolden() {
  return JSON.parse(readFileSync(GOLDEN, 'utf8'));
}

// Build the real Ask index over the corpus. build() wants { id, title, body }
// — the minimum needed to chunk + index (no bookmark meta required here).
export function buildIndex(notes) {
  const index = createAskIndex();
  index.build(notes.map((n) => ({ id: n.id, title: n.title, body: n.body })));
  return index;
}

// The single primary tag on a question (exactly one exists — enforced by the
// eval-fixtures integrity gate).
export function primaryTag(q) {
  return q.tags.find((t) => PRIMARY_TAGS.includes(t));
}

// Score one answerable question against its top-k hits.
//  recall@k = |distinct relevant titles among hit noteTitles| / |relevantNotes|
//             (multi-note questions score fractionally)
//  mrr      = 1 / (1-based rank of the FIRST hit whose noteTitle is relevant),
//             0 if no relevant note appears in the top k.
export function scoreQuestion(index, q, k = 5) {
  const hits = index.query(q.question, k);
  const relevant = new Set(q.relevantNotes);
  const found = new Set();
  let firstRank = 0;
  hits.forEach((hit, i) => {
    if (relevant.has(hit.noteTitle)) {
      found.add(hit.noteTitle);
      if (firstRank === 0) firstRank = i + 1;
    }
  });
  const recall = relevant.size ? found.size / relevant.size : 0;
  const mrr = firstRank ? 1 / firstRank : 0;
  return { hits, recall, mrr, found: [...found] };
}

// Mean recall@5 / MRR over a set of scored rows.
export function summarize(rows) {
  const n = rows.length;
  const sum = (sel) => rows.reduce((a, r) => a + sel(r), 0);
  return {
    n,
    recall: n ? sum((r) => r.recall) / n : 0,
    mrr: n ? sum((r) => r.mrr) / n : 0,
  };
}
