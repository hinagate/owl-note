---
title: "Git rescue: recover a deleted branch"
lang: en
tags: [code]
---

Deleted `feature/parser` with `git branch -D` thinking it was merged. It wasn't.
Two days of work, gone from `git branch -a`. Not gone from the repo, though —
git keeps the commits around for a while even with no branch pointing at them.

The move:

```sh
git reflog                       # find the last commit that was on the branch
# ... spotted "commit: parser: handle nested quotes" at a3f9c21
git branch feature/parser a3f9c21
```

`git reflog` lists every position HEAD has been in, including the tip of the
branch right before I nuked it. Once I had the SHA, `git branch <name> <sha>`
just re-created the pointer. Everything was there.

If reflog had already expired I'd have fallen back to `git fsck --lost-found` and
dug through the dangling commits, but reflog is the fast path. Ninety days is the
default expiry, so don't panic.
