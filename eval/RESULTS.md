# Ask evaluation results (Milestone M5)

Committed numbers from the retrieval eval harness. Regenerate with
`npm run eval:retrieval` (deterministic — same corpus produces the same table).

| Field | Value |
| --- | --- |
| Date | 2026-07-02 |
| Corpus | 48 notes / 60 chunks |
| Golden set | 47 questions (39 answerable, 8 unanswerable) |
| MiniSearch | 7.2.0 (`^7.2.0`) |
| Node | v23.9.0 |
| Commit | 0bc8b03 (E1 fixtures; retrieval core unchanged) |
| Config | lexical-only, top-5, CJK bigram tokenizer, no embeddings |

## Retrieval v1

recall@5 = |distinct relevant note titles among the 5 hits| / |relevant notes|
(multi-note scores fractionally). MRR = 1 / rank of the first relevant hit, 0 if
none in the top 5. Unanswerable questions have no relevant notes and are skipped
here (abstention is measured by Answer QA, not retrieval).

```
  tag           n   recall@5    MRR
  ----------  ---  --------  -----
  overall      39    0.846  0.826
  direct       15    1.000  1.000
  paraphrase   11    0.545  0.382
  cjk           6    1.000  1.000
  injection     3    1.000  1.000
  multi-note    4    0.750  1.000
```

### Misses (recall@5 == 0)

All five recall-0 questions are paraphrase — the expected lexical-only weak spot:

```
  [q16] paraphrase  "How much do I put toward housing every month?"
        expected: Budget review — May 2026
  [q17] paraphrase  "How long does the concentrate need to sit before it's drinkable?"
        expected: Cold brew coffee ratios
  [q20] paraphrase  "When are we releasing the download capability to users?"
        expected: Standup 2026-03-04
  [q24] paraphrase  "What was the greatest distance I reached in the buildup before tapering?"
        expected: Marathon training week 16
  [q26] paraphrase  "How long does the cold breakfast need to sit before it's ready?"
        expected: Overnight oats, the base recipe
```

Each miss is a vocabulary mismatch, not an index bug: e.g. q16 asks about
"housing" but the note only ever says "rent" — the token "housing" appears in no
note, so a lexical index cannot match it. The same note retrieves at rank 1 when
queried with its own words ("rent utilities groceries savings").

## Limitations

- **Lexical-only.** MiniSearch matches shared tokens (with prefix/fuzzy), so
  questions phrased with different words than the note (the paraphrase subset,
  recall 0.545) score poorly *by design*. This gap is the headroom the M9
  embedding/fusion upgrade is meant to close — the paraphrase subset is the
  intended before/after benchmark, which is why the CI floor test deliberately
  leaves paraphrase ungated.
- **Synthetic corpus.** All 48 notes are invented for the eval; a real user's
  messy, abbreviation-heavy notes will behave differently. These numbers measure
  the retriever against a clean ground truth, not real-world recall.
- **Note-title-granularity recall.** A hit anywhere in a note counts the whole
  note as retrieved; this does not measure whether the *specific* answer-bearing
  chunk ranked well, only that the right note surfaced.
- **CJK via bigram tokenizer.** Chinese/Japanese/Korean recall (1.000 here) rides
  on the M4.5 overlapping-bigram tokenizer; it is measured on a small subset
  (n=6) of short synthetic notes and should be read as "the tokenizer works," not
  as a precise CJK recall figure.
- **Single embedder-free config.** One retrieval configuration is measured; no
  boost/fuzzy sweep, no fusion, no reranking.

Retrieval is **deterministic** (no embeddings, no randomness), so a single run is
authoritative — the §6 3-run mean±range protocol applies to Answer QA (which
depends on a nondeterministic model), not to this table.

## Answer QA (v1)

_To be filled by Task E4._ (End-to-end answer quality — groundedness, citation
correctness, abstention on unanswerable questions, injection resistance —
measured with the 3-run mean±range protocol against a live model.)
