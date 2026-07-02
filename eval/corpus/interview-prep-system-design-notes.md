---
title: "Interview prep: system design notes"
lang: en
tags: [code]
---

# System design — the URL shortener

Rehearsing the classic one out loud until it's boring.

The core: take a long URL, hand back a short code, redirect on lookup.

- **Encoding:** generate a unique 64-bit id, then **base62** encode it (a–z, A–Z,
  0–9) to keep the code short and URL-safe. Seven base62 chars covers ~3.5
  trillion links.
- **Storage:** a key-value store mapping `code -> long_url`. Reads massively
  outnumber writes.
- **Cache:** put **Redis** in front for the hot links — the long tail is fine to
  hit the DB, the popular 20% should never touch it.
- **Scale:** shard the DB by a hash of the code so no single node is a hotspot.
- **Abuse:** rate limit new-link creation with a **token bucket** per API key.

Things they always poke at: collision handling (retry on the rare dup), custom
aliases (separate namespace, check-then-set), and analytics (fire the click event
async, never block the redirect).
