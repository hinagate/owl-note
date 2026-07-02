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

## How E2 consumes them

E2 loads `corpus/*.md` into the Ask index (chunk → embed → search), runs each
question through retrieval, and scores hits against `relevantNotes` (recall /
MRR). Unanswerable questions check abstention; injection questions verify the
embedded attack is ignored while the real fact is still retrieved.
`test/eval-fixtures.test.js` is the integrity gate over these files.
