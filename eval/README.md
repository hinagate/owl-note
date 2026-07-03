# Ask evaluation fixtures

A synthetic corpus of notes plus a golden question set — the ground truth the
retrieval/answer eval harness measures against. All content is invented: no real
people, no personal data, nothing copyrighted.

## `corpus/*.md`

One note per file. Filename is a kebab-case slug; the loader assigns `id = filename`
(do **not** put ids in frontmatter). Frontmatter is exactly:

```markdown
---
title: "Rye sourdough attempt 3"   # unique across the corpus
lang: en                            # en / zh / ja / ko / es / de …
tags: [recipe]                      # loose human category
---

...markdown body...
```

Titles are unique because `golden.json` references notes by title.

## `golden.json`

`{ "version": 1, "questions": [ … ] }`. Each question:

```json
{ "id": "q01", "question": "…", "relevantNotes": ["<exact corpus title>", …],
  "answerable": true, "tags": ["direct"] }
```

`tags` carries exactly one primary tag: `direct` | `paraphrase` | `cjk` |
`injection` | `unanswerable` | `multi-note`. Every `relevantNotes` entry
string-equals a corpus title. `answerable` is `true` iff `relevantNotes` is
non-empty (unanswerable questions have `[]`).

## `fixtures/vectors.json`

Committed embeddings that let the hybrid retrieval floor gate
(`test/eval-hybrid.test.js`) run in CI with **no model download and no network**.
`node eval/run-vector.mjs --write-fixtures` runs `multilingual-e5-small` (q8) once and
freezes every corpus chunk (`passage: {text}`) and golden question (`query: {text}`)
embedding as a **base64 Float32** blob — 4× smaller than a JSON number array and
exact to the IEEE-754 bit — into `{ model, dim, corpusHash, chunks, questions }`. The
test decodes those vectors and fuses them with the real `src/lib/fusion.js`
(`rrfFuse` / `FUSION_WEIGHTS` / `RRF_K`), so it gates the *shipped* hybrid config
without embedding anything live. `corpusHash` is a stable hash over the sorted
(chunkId, text) pairs: the test recomputes it from the live corpus + chunker and
**fails loudly** if they drift from the frozen vectors — the fix is to regenerate,
`node eval/run-vector.mjs --write-fixtures` (deterministic; produces byte-identical
output). See eval/RESULTS.md "Retrieval v2 — hybrid (shipped config)" for the numbers.

## How the eval consumes them

The retrieval eval loads `corpus/*.md` into the Ask index (chunk → embed →
search), runs each question through retrieval, and scores hits against
`relevantNotes` (recall / MRR). Unanswerable questions check abstention;
injection questions verify the embedded attack is ignored while the real fact is
still retrieved. `test/eval-fixtures.test.js` is the integrity gate over these
files.

## Reproduce these numbers

Everything in `RESULTS.md` is reproducible. The lexical retrieval table and the
CI floors run with **no model download and no network**; only the optional paths
need a model.

### No model required

```bash
npm install                              # dependencies (Node v23.x used for the committed run)
npm run eval:retrieval                   # lexical Retrieval v1 table
npx vitest run test/eval-hybrid.test.js  # hybrid v2 floors over committed vectors
```

- **`npm run eval:retrieval`** prints the per-tag recall@5 / MRR table (overall,
  direct, paraphrase, cjk, injection, multi-note) plus the recall-0 miss list.
  It is deterministic — the same corpus produces the same table — and matches the
  "Retrieval v1" section of `RESULTS.md`.
- **`npx vitest run test/eval-hybrid.test.js`** fuses the committed
  `fixtures/vectors.json` embeddings with the real `src/lib/fusion.js` and asserts
  the "Retrieval v2 — hybrid (shipped config)" floors. Expect a green run; a
  fusion/weight/tokenizer regression or a corpus/chunker drift fails it loudly.
  This is the gate that runs in CI without ever loading a model.

### Model required (optional)

These paths run a real embedding or chat model and are not part of CI. They pull
the `@huggingface/transformers` dev dependency (already installed by `npm
install`) and download model weights on first use.

```bash
node eval/run-vector.mjs                  # spike: MiniLM vs multilingual-e5 hybrid tables
node eval/run-vector.mjs --sweep          # weighted-RRF weight sweep (e5, cached model)
node eval/run-vector.mjs --write-fixtures # regenerate fixtures/vectors.json (deterministic)
```

- **`--write-fixtures`** re-embeds the whole corpus and every golden question with
  `multilingual-e5-small` (q8) once and freezes them into `fixtures/vectors.json`
  (byte-identical output on re-run). Run this after a model or quantization change,
  then re-run the hybrid floors above.

Answer-quality evaluation needs an OpenAI-compatible endpoint (a local Ollama by
default); every knob is env-overridable:

```bash
npm run eval:answers                                      # defaults to http://localhost:11434/v1, llama3.1:8b
ASK_EVAL_BASE_URL=… ASK_EVAL_MODEL=… npm run eval:answers # point at any OpenAI-compatible endpoint
```

- Runs the **real** extension pipeline (fusion → prompt → parser) 3× over all 47
  questions and prints a mean ± range table for grounded rate, citation
  correctness, abstention, and injection non-compliance, stamped with the
  endpoint and model version. If no endpoint is reachable it prints one
  instruction and exits with code 2 — no partial table, no fabricated numbers.
