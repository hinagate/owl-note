---
title: "Debugging the CSV import off-by-one"
lang: en
tags: [code]
---

Spent most of the afternoon chasing this. The `load_transactions` function was
silently dropping the very first row of every uploaded file. No crash, just one
transaction missing from the totals — which is the worst kind of bug.

The culprit: I called `next(reader)` to skip the header, but I was *also* using
`enumerate(reader, start=1)` and slicing `rows[1:]` further down. So the header
got consumed once, then the first real data row got treated as a header and
thrown away.

```python
def load_transactions(path):
    with open(path, newline="") as f:
        reader = csv.reader(f)
        next(reader)          # skip header — this line was the problem when
        rows = list(reader)   # combined with the rows[1:] slice below
        return [parse_row(r) for r in rows]   # was: rows[1:]
```

Fix was to delete the `rows[1:]` slice and keep the single `next(reader)`. Added
a regression test that feeds a two-line CSV (header + one row) and asserts the
result has length 1. Before the fix it returned an empty list and, on malformed
input, an `IndexError: list index out of range` from `parse_row`.

Lesson: pick ONE place to skip the header. Don't defend against the header twice.
