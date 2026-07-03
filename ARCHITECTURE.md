# Ask Owl — Architecture & Decision Log

This is the design-review document for OWL-Note's on-device question-answering
feature, **Ask Owl**. It is written decisions-first: each entry states the
context, the options weighed, the choice made, and the evidence behind it —
because the *why* is the part that does not survive in the code. Line and file
references point at the codebase; treat them as pointers, not contracts.

One sentence: **retrieval-augmented answers over your own notes, with the entire
AI stack running inside the extension page — generation on the browser's
built-in model, semantic search on a bundled WASM embedding runtime — no server,
no account, no API key, and no new data leaving the device.**

## Why this is an unusual system (read this first)

Almost every "AI feature" shipping today is a wrapper around a cloud API: text
goes out to a vendor, tokens come back, and a monthly bill accrues per user.
Ask Owl is the other kind. The whole pipeline is local:

- **Generation** runs on the browser's built-in model — Gemini Nano in Chrome,
  Phi in Edge — reached through the Prompt API `LanguageModel` global. That API
  surface is itself rarely used in shipped products.
- **Semantic retrieval** runs a quantized multilingual embedding model on a
  WASM runtime that is **bundled in the extension package**, not fetched as
  remote code.
- There are **no API keys, no server, no per-query cost**, and once the models
  are on the device the feature works **fully offline** — you can answer
  questions in airplane mode.

The consequence is that privacy here is *structural*, not a promise: there is no
endpoint that could receive a note even in principle. The engineering that this
buys — model-lifecycle handling, consent-gated downloads, WASM plumbing under
Manifest V3, storage-quota and eviction handling, and a graceful degradation
ladder for machines without a local model — is the substance of this document.

## Contents

1. [Constraints — the forcing functions](#1-constraints)
2. [System overview](#2-system-overview)
3. [The degradation ladder](#3-the-degradation-ladder)
4. [Decision log](#4-decision-log)
5. [Privacy architecture](#5-privacy-architecture)
6. [What the evaluation said](#6-what-the-evaluation-said)
7. [Known limitations](#7-known-limitations-by-design)
8. [Module map](#8-module-map)

---

## 1. Constraints

Every decision below traces back to one of these. When a choice looks odd, check
it against this list before assuming it is an accident.

- **C1 — The product promise.** OWL-Note's pitch is "no server, no account, no
  subscription." An AI feature that needed any of the three would contradict the
  product it lives in. Corollary: **$0 marginal cost per question, forever.**
- **C2 — Chrome Web Store, Manifest V3.** No remotely hosted *code* — JavaScript
  or WASM — may execute; all logic ships in the reviewed package. Model
  *weights* fetched at runtime are data, not code, but that line has sharp edges
  (§4.14).
- **C3 — The corpus is tiny.** Notes live in bookmark URLs with an ~8 KB sync
  ceiling; even a heavy user has low thousands of notes — a few thousand
  retrieval chunks. Most "RAG infrastructure" exists to solve problems that
  first appear at 10⁶–10⁹ documents. We are at 10³, and that single fact deletes
  most of the usual architecture.
- **C4 — Heterogeneous hardware.** The built-in models are gated on RAM/VRAM and
  free disk. Some users will never have a local model. The feature has to be
  honestly useful anyway.
- **C5 — House style.** Small pure modules in `src/lib/` with vitest coverage,
  thin DOM glue in `src/app/`, no frameworks, comments that explain *why*. The
  Ask code should be indistinguishable from the code around it.

---

## 2. System overview

```
                       app.html (extension page)
┌────────────────────────────────────────────────────────────────────┐
│ notes[]  ← decoded from bookmark URLs on open (root scope)          │
│    │  save / delete / external bookmark change (coalesced)          │
│    ▼                                                                │
│ chunker ─► ask-index (MiniSearch, in-memory)          [lexical]     │
│    │            └─► embed-worker (WASM e5) ─► vectors (IndexedDB)    │
│    ▼                     │                                          │
│ fusion (weighted RRF; lexical passthrough until vectors exist)      │
│    ▼                                                                │
│ ask-controller (state machine, cancellation)                        │
│    ▼                                                                │
│ Provider interface ──► builtin (Prompt API: Gemini Nano / Phi)      │
│    ▼                                                                │
│ ask-panel (drawer UI; grounded answer; citations → open note)       │
└────────────────────────────────────────────────────────────────────┘
```

Request lifecycle: question → ranked chunks → token-budgeted packing → one model
session → validated, cited answer → citations resolve back to the source notes.
Every arrow degrades: no model → ranked snippets; malformed model output → plain
answer without citations; nothing matches → an honest "not found" without the
model ever being invoked.

---

## 3. The degradation ladder

The ladder is a first-class design object, not an error path. It is re-checked
fresh on **every** question (§4.3).

| Condition | Behavior |
|---|---|
| Built-in model `available` | Full grounded answer with citations |
| Built-in model `downloadable` / `downloading` | Ranked snippets now, one-click opt-in with progress |
| No usable model (C4) | Ranked snippets with jump-to-note links — no nagging |
| Zero retrieval hits | "Nothing in your notes matches" — model never invoked |

Because retrieval *is* the feature on a machine with no local model, retrieval
quality earns more engineering attention than generation.

---

## 4. Decision log

Format: **context → options → decision → evidence/consequences.**

### 4.1 Notes are bookmarks — the pre-existing foundation

**Context.** OWL-Note stores each note as a compressed payload in a bookmark
URL, synced for free by the user's Chrome/Microsoft account, with a local
`chrome.storage.local` mirror per device. This predates Ask; the AI feature is a
guest in that house.

**Decision.** Ask reads notes the same way the rest of the app does and adds no
new storage of user content. The one derived artifact it keeps — the retrieval
index and its vectors — is device-local and never synced.

**Consequence.** The ~8 KB bookmark ceiling is the origin of C3: the corpus is
small by construction, which is what makes an in-page, in-memory retriever
viable (§4.2) and a vector database pointless (§4.13).

### 4.2 The index lives in the app page, in memory, rebuilt on open

**Decision.** `createAskIndex()` builds from a root-scope read of all notes when
`app.html` opens (deferred past first paint), upserts incrementally on save
using each note's existing content hash, and fully rebuilds on external bookmark
changes.

**Rejected.**
- *Index in the MV3 service worker* — service workers die after ~30 s idle;
  keeping an index there means keepalive hacks or constant rebuilds.
- *Persisted index with invalidation* — persistence buys startup time we do not
  need (see the build number below) at the price of staleness machinery that
  would have to understand every mutation path, including cross-device sync.
  Rebuild-on-open **is** the invalidation strategy.

**Evidence.** On a synthetic 2,000-note corpus (~6,000 chunks) the lexical index
builds in **209.8 ms** and answers a query in **9.7 ms** — comfortably under a
half-second budget, so there is nothing to optimize by persisting.

**Where the real repo pushed back.** The app's in-memory note list holds only
the *active folder's* notes, so the index is built from an explicit root-scope
read (Trash excluded); indexing the active-folder list would have silently
shrunk the corpus whenever a sub-notebook was open. External changes funnel
through the app's existing coalescing live-refresh hook, so a sync burst
collapses to one rebuild.

### 4.3 Feature detection, and availability is never cached

**Decision.** The only capability question asked is "does
`globalThis.LanguageModel` exist, and what does `availability()` say" —
re-asked on every question, the result never cached. No user-agent sniffing.

**Why the no-cache rule.** Availability is a lifecycle, not a boolean:
`available / downloadable / downloading / unavailable`, and it moves in **both**
directions — Edge deletes its built-in model when free disk drops below its
threshold. A cached `available` is a future crash. The cost is one extra probe
per question, which is negligible next to a model call.

### 4.4 Retrieval is lexical-first; embeddings must earn their way in

**Context.** The default "RAG tutorial" architecture is embeddings-first. On a
*personal* corpus that instinct is wrong: the author half-remembers their own
vocabulary, so keyword matching is unusually strong, and it works on every
machine instantly (C4). Embeddings-first would have front-loaded ~130 MB of
weights, WASM plumbing, and IndexedDB for a benefit nobody had measured.

**Decision.** v1 retrieval is MiniSearch (BM25-style) over heading-aware chunks
— a small dependency, zero downloads, zero setup. Semantic embeddings were
deferred and made *conditional on measured need*.

**The discipline that matters.** The evaluation harness (§4.7) was built
**before** the semantic layer, precisely so the decision to add embeddings would
cite numbers rather than vibes — and so that a negligible delta could have been
shipped as a documented negative result. The harness exists to be allowed to say
no.

### 4.5 Heading-aware chunking, ~350-token chunks, code fences atomic

**Decision.** Split the note body on markdown headings; within a section pack
whole paragraphs up to a ~1,400-character cap (`MAX_CHUNK_CHARS`); never split
inside a fenced code block; every chunk carries its heading breadcrumb and note
title.

**Rejected.** Fixed-size sliding windows — cheaper to write, but citations then
point at arbitrary byte ranges. A citation the user clicks should land on
something *humanly meaningful* ("Rye sourdough attempt 3 › Bake"), and the
heading breadcrumb is what makes the citations UI legible.

**Two details that came out of practice.** Code fences are treated as atomic
even when a line inside them looks like a heading (a `# comment` in a shell
snippet), so heading detection skips fence spans. And a fence's language tag is
stripped from the indexable text but the code body is kept verbatim — people
search for identifiers.

### 4.6 CJK is a first-class corpus, not an edge case

**Context.** MiniSearch's default tokenizer splits on whitespace and
punctuation. An unspaced Chinese/Japanese/Korean run therefore becomes a single
giant token that no query term can line up with — the note is effectively
unsearchable, silently.

**Decision.** Wrap the default tokenizer with a **strict superset**: Latin and
other whitespace-delimited tokens pass through byte-identically, while runs in
the Han / Kana / Hangul codepoint ranges are re-emitted as overlapping character
bigrams, so a query's bigrams overlap the note's. The same tokenizer is set on
the index constructor, which MiniSearch also uses at query time, so index and
query tokenization can never disagree.

**Why superset, specifically.** Making Latin behavior byte-identical means every
existing English test stays green and the change carries zero risk for the
common case; only genuinely multilingual text takes a different path. A parallel
fix lives in the token *estimator* (§4.8): a `chars/4` estimate undercounts CJK
by 3–4×, so the estimator counts CJK codepoints at ~1 token each to keep a
CJK-heavy context from silently overflowing the model window.

**Evidence.** CJK questions carry their own subset in the golden set with a CI
floor, so a tokenizer regression fails the build rather than a user in Tokyo.

### 4.7 The evaluation harness is the decision engine

This is the load-bearing decision of the whole feature. Retrieval quality is not
argued; it is measured against a committed ground truth.

**Decision.** A committed golden set — **47 questions** (39 answerable, 8
deliberately unanswerable) over a **48-note / 60-chunk synthetic corpus** (never
real user data) — with tagged subsets: `direct`, `paraphrase`, `cjk`,
`injection`, `unanswerable`, `multi-note`. Retrieval metrics (recall@5, MRR) run
in CI against an enforced floor. Every reported number lives in `eval/RESULTS.md`
with its limitations attached.

**Rejected.**
- *LLM-as-judge scoring* — a judge model adds its own error bar and a
  dependency; substring-level expected-fact checks plus a committed golden set
  are reproducible and challengeable.
- *Pretending the browser models run in CI* — they cannot run in Node.
  Answer-quality evaluation runs through an OpenAI-compatible client against a
  local model, and any number is stamped with the exact model/endpoint that
  produced it. Saying so plainly beats implying coverage that does not exist.

**The credibility story — measuring *down*.** A semantic pass over the golden
set found that 5 of 11 paraphrase questions were leaking a corpus-unique keyword
from their target note (a question about a make-ahead drink literally contained
the word `concentrate`), letting the *lexical* index win questions that were
meant to require semantic matching. Those five were reworded — answerability
preserved — and the table regenerated. Paraphrase recall@5 dropped **0.545 →
0.455** and overall **0.846 → 0.821**. Publishing the *lower* number is the
point: the honest baseline is the one that makes the later semantic improvement
mean something.

**CI floors that run with no model.** The shipped hybrid config is floor-gated
without any model download: every corpus-chunk and golden-question embedding is
frozen into `eval/fixtures/vectors.json` (base64 Float32, ~217 KB), and the
floor test fuses those committed vectors with the **real** fusion module to
reproduce the results table and assert loose bounds under it. A `corpusHash`
stamped into the fixture — and recomputed live by the test from the corpus plus
chunker — fails the build **loudly** if either drifts, so a stale fixture can
never pass silently. Because the eval and the runtime import the *same* fusion
code, a fusion, weight, or tokenizer regression turns the build red without
anyone re-running a model.

### 4.8 An auditable token budget; one session per question

**Decision.** The built-in context window is a fixed, small window (~9 K tokens).
Packing is explicit arithmetic, not hope: a ranked greedy pack up to a
**5,000-token chunk budget** (`CHUNK_TOKEN_BUDGET`), capped at **10 chunks**,
leaving generous headroom for the system prompt, the length-capped question,
framing, and output. Every question gets a **fresh session, destroyed in a
`finally` block** — no chat accumulation.

**Rejected.** A persistent conversational session. In a ~9 K window, history is a
memory leak: a few follow-ups in, retrieved context and history compete and both
lose. Multi-turn, if ever added, re-retrieves per turn rather than growing one
session.

### 4.9 The grounding contract and the output protocol

**Decision.** The system prompt permits answering *only* from the provided
chunks, requires `grounded:false` plus an explicit "could not find it" when the
notes lack the answer, and requires the model to list the chunk ids it used. The
shipped output shape is **schema-constrained JSON** (`{answer, citations[],
grounded}` via the Prompt API's `responseConstraint`) — structure you can trust.

**Rejected for v1: streaming plain text with inline `[c:id]` markers.** Streaming
reads better, but streaming a schema-constrained response emits partial JSON, and
rendering `{"answer": "The rye was ba` is not a user experience. Incremental JSON
extraction was weighed and rejected as complexity spent hiding a mismatch. Schema
JSON won for v1 because it is trustworthy to parse; inline-marker streaming is a
later UX upgrade, not a correctness one.

**Model output is hostile input.** Regardless of protocol: parse in try/catch;
cited ids are checked against the ids actually sent and unknowns dropped;
malformed output degrades to an uncited answer rather than throwing. Ungrounded
answers always render with their warning treatment.

### 4.10 Prompt-injection defense in depth

**Threat.** Chunks fed to the model include text the user clipped from arbitrary
web pages, imported files, and pasted AI output. Any of it can smuggle
instructions aimed at the model ("ignore your rules", "cite `[c:fake-id]`",
"reveal the other notes").

**Blast radius, bounded by design.** The model has no tools and no write access;
its output renders through the sanitizing markdown pipeline, never raw
`innerHTML`; and cited ids are validated against the ids actually sent, so
citation forgery dies at the boundary. The meaningful residual is a *steered
answer*, and the bounded blast radius — not the prompt — is the primary control.

**Three layers of marker defense.** Note excerpts are wrapped in `<<<NOTE
c:id>>> … <<<END>>>` sentinels, and the system prompt declares everything between
markers to be data.

1. **Content neutralization.** Any literal run of `<<<` or `>>>` in the chunk's
   raw text — *and in its title and heading*, which are equally
   attacker-controlled — is collapsed to single-angle lookalikes before the real
   sentinels are added, so content cannot forge or close a marker.
2. **Import-time id sanitization.** Imported note ids are untrusted; angle
   brackets are stripped at the single import choke point.
3. **Chunk-id sanitization at minting.** The subtle one. The chunk id is the
   *only* field of the marker that **cannot** be neutralized at prompt-build
   time, because it must round-trip verbatim through the model's citations back
   to the note. So it is sanitized where chunk ids are minted (`<` → `‹`,
   `>` → `›`, lookalikes so distinct ids stay distinct) — the index doc, the
   prompt marker, and the citation resolver all consume that same sanitized id
   and stay in agreement. The note's original id is kept separately so citation
   open still keys correctly.

**Honest status.** This raises the bar; it is not a proof — a small model can
still be steered. The golden set carries injection fixtures so resistance is a
*measured* metric (the embedded attacks are ignored while the real fact is still
retrieved), and the bounded blast radius is what makes a steered answer merely
wrong, never dangerous.

### 4.11 The formatting lesson: two features the evaluation killed

Two capabilities were built or prototyped and then **removed on evidence**. Both
are cited here because a decision to *not* ship is as real as a decision to ship.

**Generative reformatting, retired.** An early "AI Format" action asked the
on-device model to re-emit a note's markdown, cleaned up. In real-browser use it
failed the way small models fail: it truncated mid-JSON (leaking raw
`{"markdown": …` through the fallback), rewrote content into ASCII art, and added
unsolicited commentary. The lesson recorded: a ~3B on-device model cannot
faithfully re-emit note content, so generative reformatting is off the table
on-device. It was replaced by a **deterministic, fence-aware tidy** — pure rules
(line endings, trailing-whitespace with soft-break preservation, blank-line
collapse, heading spacing, unicode bullets), applied synchronously with a
single-undo, and **fuzz-tested for idempotence** so running it twice is a no-op.
The model proposes; it never destroys.

**LLM-as-classifier, dropped after a build-nothing gate.** A follow-up idea kept
the deterministic applier but let the model act only as a *classifier* — propose
fence line-ranges as tiny JSON, then wrap the user's own bytes, never re-emit
them. Before writing extension code, it was evaluated live against the real
on-device model on four fixtures with **pre-declared pass/fail criteria**.
Result: English SQL and English JavaScript were classified exactly; but non-Latin
prose was misclassified as code, and a mixed CJK/SQL fixture bled its range into
a trailing sentence. The pre-declared zero-tolerance criterion tripped, and the
feature was dropped — the design is sound, the on-device model's grasp of
non-Latin structure is not. Eval-gated feature decisions, in both directions.

### 4.12 Semantic retrieval — feasibility measured before it was built

This is the headline upgrade, and it followed the discipline of §4.4: it was
*measured before it was built*.

**The spike.** Two on-device-class embedding models were run in Node against the
same corpus and golden set, with no extension code written yet:
`all-MiniLM-L6-v2` (an English-centric default) and `multilingual-e5-small`
(genuinely multilingual), both int8-quantized. Hybrid retrieval fused each
model's vector list with the lexical list.

**Model chosen by multilingual MRR, not recall.** Both models pushed recall@5 to
1.000 on this corpus — but that is a small-corpus artifact: with only 60 chunks
the metric *saturates* and cannot discriminate them (see §6). The discriminating
metric is **MRR**, and there the English-centric model exposed its weakness: on
the CJK subset it scored **MRR 0.700** (the right note not reliably ranked first)
versus **1.000** for the multilingual model. The multilingual model was chosen
for that robustness despite being the larger download (~130 MB vs ~23 MB) — a
deliberate trade of bundle economy for correctness on non-Latin scripts.

**Fusion weight from a committed sweep, not a guess.** Equal-weight RRF actually
*hurt* paraphrase retrieval — fusing a lexical list that is wrong for paraphrase
injects wrong-note chunks. A weight sweep over the golden set (vector weight ∈
{1, 1.5, 2, 3, 4}) selected **`w_vec = 3`** by a stated rule: maximize paraphrase
recall@5, then paraphrase MRR, subject to holding the direct/cjk/overall
constraints, tie-broken toward the *smallest* weight so lexical keeps maximal
influence. The runtime (`src/lib/fusion.js`) and the sweep import the same
`rrfFuse` function, so the tuned number and the shipped math cannot drift.

**Result.** Paraphrase recall@5 went **0.455 → 1.000** and paraphrase MRR
**0.364 → 0.738**, with **zero regressions** on any other tag — the full numbers
and caveats are in §6.

**How it ships.** The embedder runs in a Web Worker (§4.14). Vectors are
L2-normalized `Float32Array`s persisted in **IndexedDB** — embed once, keep
forever, because re-embedding a whole corpus is the expensive part of on-device
retrieval. Sync is **embed-once-sync-forever via hash diffing**: on each change
only notes whose content hash moved are re-embedded; a folder move or a
title-only touch re-embeds nothing. The lexical path is always computed and is
the never-fail fallback, so an embed hiccup degrades a single query rather than
failing it.

**Consent-gated, always.** None of this happens until an explicit one-time
opt-in (the panel's *Build* button). Before that click there is **no worker
spawn, no download, no embedding** — the machinery is a null singleton
constructed only inside the one consent-gated entry point, and the opt-in is
persisted so later sessions silently catch the index up to the live corpus.

### 4.13 No vector database

**Decision.** Similarity is a brute-force dot product over the in-memory mirror
of normalized vectors; there is no ANN index and no hosted vector store.

**The math that deletes the database (C3).** A heavy corpus of ~3,000 chunks ×
384 dimensions is ~1.1 M multiply-adds per query — microseconds to low
milliseconds in a Web Worker, no index structure required. HNSW/IVF and hosted
vector stores solve a recall-versus-latency trade-off that begins orders of
magnitude above this corpus size. The honest statement is not "we kept it
simple" but "the problem that tool solves is not present."

### 4.14 Manifest V3 realities: bundled WASM, worker isolation, offline-first

**Code versus data, precisely (C2).** Remotely hosted *code* (JS and WASM) is
forbidden; remotely fetched *data* is fine, and ML model weights are data. How
that cashes out:

| Thing | Class | Handling |
|---|---|---|
| MiniSearch, Transformers.js, our own code | code | npm + esbuild, in the package |
| ONNX Runtime `.wasm` (+ its `.mjs` loader) | **code** | **bundled** — the trap below |
| e5 embedding weights (~130 MB, int8) | data | fetched once on opt-in, cached by the browser |
| Gemini Nano / Phi | not ours | browser components; zero package or policy surface |

**The bundled-WASM trap, and a real shipping bug.** ONNX Runtime fetches its
WASM from a CDN *by default*; a default-config build would fail Web Store review
legitimately, so `wasmPaths` is overridden to the extension's own root and the
`.wasm` is copied into the package at build time. The subtle part: the `.wasm`
alone is **not enough** — the runtime *dynamically imports a companion `.mjs`
loader* from the same path at first use. Shipping only the `.wasm` fails at
runtime with "no available backend found / failed to fetch dynamically imported
module", *after* the weights have already downloaded successfully. Both artifacts
now ship together, and the build **hard-errors** if either is missing rather than
producing a package that boots blank. This is the kind of failure that green unit
tests never catch and only a real-browser smoke run surfaces.

**Worker isolation keeps the app bundle honest.** The embedder is a *second*,
self-contained bundle entry (`embed-worker.js`); it is the only module that
imports Transformers.js, so the ~1 MB library and the ONNX runtime stay entirely
out of `app.js`. The application bundle is byte-identical whether or not a user
ever opts into semantic search, and the semantic feature added exactly one line
to the app's Manifest V3 CSP: `'wasm-unsafe-eval'`, the sanctioned directive for
bundled WASM. There is no `eval` and no `new Function` anywhere — the build is
auditable by grepping `dist/` for remote references.

**Why a Web Worker and not an offscreen document.** An offscreen document is the
usual MV3 answer for background compute, but embedding is only needed while the
app is open — the same reasoning as the in-page index (§4.2). Threaded WASM was
also rejected: it needs cross-origin isolation an extension page cannot set, so
the worker is pinned to single-threaded SIMD.

**Offline-first outcome.** Once the built-in model and the embedding weights are
on the device, everything — search, fusion, generation, summaries — runs with
the network unplugged. The airplane-mode demo is not a gimmick; it is the
architecture stated as a user-visible fact.

---

## 5. Privacy architecture

The privacy claim is **structural, not a policy**. There is no server to send a
note to, so "we cannot see your notes" is a statement about the system's shape,
not a promise about our conduct.

| Flow | Carries | Introduced by |
|---|---|---|
| Browser bookmark sync (the user's own account) | Notes ≤ ~8 KB as compressed bookmark URLs | The product, from day one |
| Optional Google Drive sync (the user's own Drive) | Attachments; oversized note bodies | Existing opt-in |
| AI service | *nothing* | — |

Ask adds **no** data flow. The question and the matching excerpts are processed
on-device; the derived index and vectors are device-local and never synced.

**The deliberate decision not to add a cloud path.** A "bring your own key" mode
pointing at a hosted model was considered and **declined**. It would have turned
the structural privacy guarantee back into a "trust the endpoint" promise, added
a per-query cost and a network dependency, and contradicted C1. On-device
generation is not a limitation we are apologizing for — it is the product. See
[`PRIVACY.md`](PRIVACY.md) for the user-facing statement.

---

## 6. What the evaluation said

All numbers are from [`eval/RESULTS.md`](eval/RESULTS.md); their caveats travel
with them. The corpus is 48 synthetic notes / 60 chunks; the golden set is 47
questions.

**Retrieval, lexical v1 → hybrid v2 (shipped):**

| Metric | v1 · lexical-only | v2 · hybrid (shipped) |
|---|---|---|
| overall recall@5 | 0.821 | **1.000** |
| overall MRR | 0.821 | **0.926** |
| paraphrase recall@5 | 0.455 | **1.000** |
| paraphrase MRR | 0.364 | **0.738** |
| direct recall@5 | 1.000 | 1.000 |
| cjk recall@5 | 1.000 | 1.000 |
| injection recall@5 | 1.000 | 1.000 |
| multi-note recall@5 | 0.750 | **1.000** |

The headline is **paraphrase recall@5 0.455 → 1.000**: the entire lexical miss
list — questions like *"what do I pay for housing?"* against a note that only
ever says *"rent"* — is now retrieved, with **zero regressions** on any tag.

**Model selection (spike):** the English-centric candidate scored CJK **MRR
0.700** versus the multilingual model's **1.000**; the multilingual model was
chosen for that robustness despite its larger download.

**Read every number with these caveats (from `RESULTS.md`):**

- **Recall saturates on this corpus.** With only 60 chunks, hybrid recall@5
  reaches 1.000 on every tag — the metric cannot discriminate configurations at
  this scale, which is exactly why **MRR** is the sensitive metric and the one
  the weight sweep optimized. These numbers show the *direction* (embeddings
  close the paraphrase gap), not a precise ceiling; on a larger, messier corpus
  the configurations would spread further.
- **Synthetic corpus.** All 48 notes are invented, with clean ground truth. A
  real user's abbreviation-heavy notes will behave differently; read v2 as
  "hybrid closes the paraphrase gap on a clean benchmark," not as a real-world
  recall figure.
- **Note-granularity recall.** A hit anywhere in a note counts the whole note as
  retrieved; the metric confirms the right note surfaced, not that the
  answer-bearing chunk ranked best.
- **CJK subset is small (n = 6).** The CJK recall figure should be read as "the
  tokenizer works," not a precise CJK recall number.

Answer-quality evaluation (grounding, citation correctness, abstention,
injection non-compliance) has a full harness and scoring protocol —
non-streaming, 3-run mean ± range against an OpenAI-compatible endpoint — but no
live numbers are committed, because no local model was available on the
development machine and fabricating them would defeat the purpose. See
`eval/RESULTS.md` for the protocol and how to fill that section.

---

## 7. Known limitations (by design)

- **Small-model honesty.** Nano and Phi are summarize-and-cite engines, not
  reasoners. The grounding contract narrows them to what they are good at;
  multi-hop synthesis questions will produce honest "not found"s more often than
  clever answers. Preferring refusal over confabulation is the design.
- **Preview-only devices.** A note too large for bookmark sync is indexed in full
  only where it was written (or anywhere with Drive sync on); other devices index
  its synced preview, so deep questions about it can legitimately miss there.
- **The context ceiling.** Evidence genuinely spread across many notes can lose
  to the packing limit. Better ranking helps; a bigger window is the browsers'
  move, not ours.
- **Availability churn.** The built-in model can vanish (Edge disk eviction),
  handled by never caching availability at the cost of one probe per question.
- **Silent model drift.** Browsers auto-update the built-in models, so identical
  code can behave differently after a browser major. The mitigation is ritual,
  not code: rerun the answer evals and version-stamp every results row.

---

## 8. Module map

| Module | Responsibility |
|---|---|
| `src/lib/chunker.js` | note → heading-aware chunks (pure) |
| `src/lib/ask-index.js` | MiniSearch lifecycle, CJK tokenizer, `noteMeta`, stats |
| `src/lib/vector-index.js` | IndexedDB vectors, brute-force dot-product query |
| `src/lib/fusion.js` | weighted RRF merge, neighbor expansion |
| `src/lib/ask-controller.js` | state machine, cancellation |
| `src/lib/providers/provider.js` | the provider interface + `AskError` |
| `src/lib/providers/prompting.js` | token-budget packing, grounding prompt, hostile-output parsing, injection neutralization |
| `src/lib/providers/builtin.js` | Prompt API adapter (Gemini Nano / Phi) |
| `src/workers/embed-worker.js` | Transformers.js embedding on bundled WASM |
| `src/app/ask-panel.js` | drawer UI, citations, semantic-build opt-in |
| `eval/` | golden set, corpus fixtures, metric runners, committed vectors, `RESULTS.md` |
