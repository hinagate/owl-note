---
title: "Rust ownership notes: borrow checker gotcha"
lang: en
tags: [code]
---

Hit `error[E0499]: cannot borrow \`v\` as mutable more than once at a time` today
and it took me embarrassingly long to see why.

I was holding a mutable reference to an element while also trying to push:

```rust
let first = &mut v[0];
v.push(10);        // E0499: v already borrowed mutably above
*first += 1;
```

`push` might reallocate the whole vector, which would leave `first` dangling —
so the compiler refuses. Two ways out:

1. Finish with the first borrow before the push — wrap it in a block so the
   reference drops:
   ```rust
   { let first = &mut v[0]; *first += 1; }
   v.push(10);
   ```
2. If you genuinely need two disjoint mutable slices at once, `split_at_mut`
   hands you two non-overlapping halves the borrow checker is happy with.

The mental model that finally stuck: the error isn't about *time*, it's about
overlapping lifetimes of exclusive access. Shrink the lifetime, and it compiles.
