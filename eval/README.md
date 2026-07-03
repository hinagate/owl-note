# Ask evaluation fixtures (Milestone M5)

A synthetic corpus of notes plus a golden question set — the ground truth the M5
retrieval/answer harness (E2+) measures against. All content is invented: no real
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

## How E2 consumes them

E2 loads `corpus/*.md` into the Ask index (chunk → embed → search), runs each
question through retrieval, and scores hits against `relevantNotes` (recall /
MRR). Unanswerable questions check abstention; injection questions verify the
embedded attack is ignored while the real fact is still retrieved.
`test/eval-fixtures.test.js` is the integrity gate over these files.
