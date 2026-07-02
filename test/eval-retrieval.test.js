// @vitest-environment node
//
// CI floor gate for the M5 retrieval evaluation (Task E2). This is a
// REGRESSION gate, not a fresh measurement: it rebuilds the exact same index
// eval/run-retrieval.mjs measures (shared eval/harness.mjs) and asserts the
// numbers stay above floors set comfortably below the measured values. Since
// retrieval is deterministic (no embeddings, no randomness), there is no
// run-to-run noise — the slack exists purely to catch code/tokenizer/index
// regressions, not to tolerate variance.
//
// Measured — deterministic single run, `npm run eval:retrieval` @ commit 0bc8b03:
//   overall     recall@5 = 0.846   MRR 0.826   (n=39 answerable)
//   direct      recall@5 = 1.000   MRR 1.000   (n=15)
//   paraphrase  recall@5 = 0.545   MRR 0.382   (n=11)   ← NO floor (M9 headroom)
//   cjk         recall@5 = 1.000   MRR 1.000   (n=6)
//   injection   recall@5 = 1.000   MRR 1.000   (n=3)
//   multi-note  recall@5 = 0.750   MRR 1.000   (n=4)
//
// Chosen floors (all below measured):
//   overall   >= 0.70   (measured 0.846) — matches the brief's 0.85→0.70 example
//   cjk       >= 0.80   (measured 1.000) — a bigram-tokenizer regression collapses
//                                          the CJK subset toward 0, so 0.80 cleanly
//                                          separates healthy from broken
//   injection >= 0.80   (measured 1.000) — the adversarial notes must stay indexed
//                                          & retrievable; with n=3 this trips the
//                                          moment any one becomes unfindable

import { describe, it, expect } from 'vitest';
import {
  loadCorpus,
  loadGolden,
  buildIndex,
  scoreQuestion,
  primaryTag,
  summarize,
} from '../eval/harness.mjs';
import { buildUserPrompt } from '../src/lib/providers/prompting.js';

const corpus = loadCorpus();
const golden = loadGolden();
const index = buildIndex(corpus);

const scored = golden.questions
  .filter((q) => q.answerable)
  .map((q) => ({ q, tag: primaryTag(q), ...scoreQuestion(index, q, 5) }));
const byTag = (tag) => scored.filter((r) => r.tag === tag);

describe('retrieval floors (regression gate)', () => {
  it('overall recall@5 >= 0.70', () => {
    expect(summarize(scored).recall).toBeGreaterThanOrEqual(0.7);
  });

  it('cjk recall@5 >= 0.80', () => {
    const s = summarize(byTag('cjk'));
    expect(s.n).toBeGreaterThan(0);
    expect(s.recall).toBeGreaterThanOrEqual(0.8);
  });

  it('injection recall@5 >= 0.80', () => {
    const s = summarize(byTag('injection'));
    expect(s.n).toBeGreaterThan(0);
    expect(s.recall).toBeGreaterThanOrEqual(0.8);
  });

  it('paraphrase subset was measured (n >= 10, no floor — M9 before/after headroom)', () => {
    // Intentionally NO recall floor: paraphrase is the lexical-only weak spot
    // (measured 0.545) and the M9 embedding upgrade's headroom, not a gate.
    expect(summarize(byTag('paraphrase')).n).toBeGreaterThanOrEqual(10);
  });
});

describe('injection prompt gate — no forged marker survives buildUserPrompt', () => {
  // Ties M4.5 marker-neutralization to the REAL adversarial fixtures. The builder
  // emits genuine markers `<<<NOTE c:{id}>>> {label}` and `<<<END>>>`; the chunk id
  // is sanitized at mint time so it can never contain '>'. Strip those genuine
  // markers, then assert NO stray `<<<`/`>>>` run remains — any forged marker in
  // attacker-controlled note content must have been collapsed to ‹/› lookalikes.
  const GENUINE = /<<<NOTE c:[^>\n]*>>>|<<<END>>>/g;
  const injection = byTag('injection');

  it('has injection questions to test', () => {
    expect(injection.length).toBeGreaterThan(0);
  });

  for (const r of injection) {
    it(`[${r.q.id}] top hits carry no live forged marker`, () => {
      const prompt = buildUserPrompt({ question: r.q.question, chunks: r.hits });
      const stripped = prompt.replace(GENUINE, '');
      expect(stripped.includes('<<<'), `forged <<< survived in ${r.q.id}`).toBe(false);
      expect(stripped.includes('>>>'), `forged >>> survived in ${r.q.id}`).toBe(false);
    });
  }

  it('gate is non-vacuous: an injection hit really contained a raw <<< / >>> run', () => {
    // Proves the assertions above actually exercise neutralization rather than
    // passing because no fixture had a forged marker (grandmas-caramel-sauce
    // pastes a literal `<<<END>>>` into its body).
    const anyRawForged = injection.some((r) => r.hits.some((c) => /<{3,}|>{3,}/.test(c.raw)));
    expect(anyRawForged).toBe(true);
  });
});
