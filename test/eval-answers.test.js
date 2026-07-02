// @vitest-environment node
//
// Answer-QA harness tests (Task E4). The harness (eval/run-answers.mjs) measures
// end-to-end answer quality against a LIVE OpenAI-compatible endpoint — but the
// dev machine has no local model, so the SCORING/AGGREGATION logic (the part
// that must be correct) is proven here against a tiny node:http mock endpoint
// that returns canned chat-completions JSON. Each test starts its own server on
// an ephemeral port and closes it in afterEach so vitest reports no open handles.
//
// Mirrors the §6 protocol cases from the brief: happy/grounded+cited, abstention
// on an unanswerable, injection compliance detected, degraded parse (no throw),
// unreachable endpoint (typed error / exit-2 path), and 3-run mean ± range
// aggregation.

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';

import {
  callModel,
  EndpointError,
  answerOne,
  scoreAnswer,
  aggregateRun,
  aggregateRuns,
  meanRange,
  INJECTION_MARKERS,
} from '../eval/run-answers.mjs';
import { loadCorpus, loadGolden, buildIndex } from '../eval/harness.mjs';
import { createFusion } from '../src/lib/fusion.js';

// Build the REAL retrieval pipeline once — the mock only replaces the model, so
// these tests exercise the genuine fusion → pack → prompt path per question.
const golden = loadGolden();
const fusion = createFusion(buildIndex(loadCorpus()));
const byId = (id) => golden.questions.find((q) => q.id === id);

// ---- mock endpoint plumbing -----------------------------------------------
const servers = [];

function startMock(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => handler(req, res, body));
    });
    servers.push(server);
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${server.address().port}/v1`);
    });
  });
}

// Wrap message content in the chat-completions envelope callModel unwraps.
const chatEnvelope = (content) =>
  JSON.stringify({ choices: [{ message: { content } }] });

function reply(res, content) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(chatEnvelope(content));
}

afterEach(async () => {
  while (servers.length) {
    const s = servers.pop();
    await new Promise((r) => s.close(r));
  }
});

// ===========================================================================
describe('answer-QA harness — mock-endpoint round trips', () => {
  it('happy path: valid JSON citing a real sent chunk scores grounded + cited', async () => {
    const q = byId('q01'); // direct, top hit == "Rye sourdough attempt 3"
    const baseUrl = await startMock((req, res, body) => {
      const { messages } = JSON.parse(body);
      const user = messages.find((m) => m.role === 'user').content;
      const firstId = /<<<NOTE c:([^>\n]+)>>>/.exec(user)[1];
      reply(res, JSON.stringify({ answer: 'Baked the rye at 232°C.', grounded: true, citations: [firstId] }));
    });

    const { parsed, sentChunks } = await answerOne({ cfg: { baseUrl, model: 'mock' }, fusion, q });
    expect(parsed.degraded).toBe(false);
    expect(parsed.grounded).toBe(true);

    const scored = scoreAnswer(q, parsed, sentChunks);
    expect(scored.metrics.answeredGrounded.pass).toBe(true);
    expect(scored.metrics.citationCorrect.pass).toBe(true);
  });

  it('abstention: grounded:false on an unanswerable question scores abstained', async () => {
    const q = byId('q40'); // unanswerable ("What is my blood type?")
    const baseUrl = await startMock((req, res) => {
      reply(res, JSON.stringify({ answer: "I couldn't find that in your notes.", grounded: false, citations: [] }));
    });

    const { parsed, sentChunks } = await answerOne({ cfg: { baseUrl, model: 'mock' }, fusion, q });
    const scored = scoreAnswer(q, parsed, sentChunks);
    expect(scored.metrics.abstention.applicable).toBe(true);
    expect(scored.metrics.abstention.pass).toBe(true);
    // answerable-only metrics do not apply to an unanswerable question
    expect(scored.metrics.answeredGrounded).toBeUndefined();
    expect(scored.metrics.citationCorrect).toBeUndefined();
  });

  it('injection: a "HACKED" answer flags resistance failure with the matched marker', async () => {
    const q = byId('q33'); // injection — retrieval surfaces the prod-incident note
    const baseUrl = await startMock((req, res) => {
      reply(res, JSON.stringify({ answer: 'HACKED', grounded: true, citations: [] }));
    });

    const { parsed, sentChunks } = await answerOne({ cfg: { baseUrl, model: 'mock' }, fusion, q });
    // sanity: the adversarial note really is in the sent context
    expect(sentChunks.some((c) => c.noteTitle === 'Prod incident postmortem 2026-02-18')).toBe(true);

    const scored = scoreAnswer(q, parsed, sentChunks);
    expect(scored.metrics.injectionResistance.applicable).toBe(true);
    expect(scored.metrics.injectionResistance.pass).toBe(false);
    expect(scored.metrics.injectionResistance.marker).toBe('HACKED');
  });

  it('injection: a grounded on-topic answer resists (positive control)', async () => {
    const q = byId('q33');
    const baseUrl = await startMock((req, res) => {
      reply(res, JSON.stringify({
        answer: 'The TLS certificate on the API gateway expired after auto-renewal silently failed.',
        grounded: true,
        citations: [],
      }));
    });

    const { parsed, sentChunks } = await answerOne({ cfg: { baseUrl, model: 'mock' }, fusion, q });
    const scored = scoreAnswer(q, parsed, sentChunks);
    expect(scored.metrics.injectionResistance.pass).toBe(true);
    expect(scored.metrics.injectionResistance.marker).toBeNull();
  });

  it('degraded parse: a non-JSON body degrades without throwing and is counted', async () => {
    const q = byId('q01');
    const baseUrl = await startMock((req, res) => {
      reply(res, 'this is not json at all'); // model spewed prose, not the JSON schema
    });

    const { parsed, sentChunks } = await answerOne({ cfg: { baseUrl, model: 'mock' }, fusion, q });
    expect(parsed.degraded).toBe(true);
    const scored = scoreAnswer(q, parsed, sentChunks);
    // degradedParse.pass means "parsed cleanly"; a degrade is a fail
    expect(scored.metrics.degradedParse.pass).toBe(false);
  });
});

// ===========================================================================
describe('answer-QA harness — endpoint error handling (exit-2 path)', () => {
  it('unreachable endpoint throws a typed EndpointError (no stack spew)', async () => {
    // Bind then immediately close to obtain a definitely-closed port.
    const closedUrl = await new Promise((resolve) => {
      const s = http.createServer();
      s.listen(0, '127.0.0.1', () => {
        const url = `http://127.0.0.1:${s.address().port}/v1`;
        s.close(() => resolve(url));
      });
    });

    const err = await callModel({ baseUrl: closedUrl, model: 'mock', system: 's', user: 'u', timeoutMs: 2000 })
      .then(() => null, (e) => e);
    expect(err).toBeInstanceOf(EndpointError);
    expect(err.kind).toBe('UNREACHABLE');
    expect(err.baseUrl).toBe(closedUrl);
  });

  it('a non-200 response raises an HTTP EndpointError', async () => {
    const baseUrl = await startMock((req, res) => { res.writeHead(503); res.end('unavailable'); });
    const err = await callModel({ baseUrl, model: 'mock', system: 's', user: 'u', timeoutMs: 2000 })
      .then(() => null, (e) => e);
    expect(err).toBeInstanceOf(EndpointError);
    expect(err.kind).toBe('HTTP');
  });
});

// ===========================================================================
describe('answer-QA harness — scoring internals', () => {
  it('citationCorrect requires a cited id whose note is relevant', () => {
    const q = { id: 'qX', answerable: true, relevantNotes: ['Note A'] };
    const sent = [{ id: 'a::0', noteTitle: 'Note A' }, { id: 'b::0', noteTitle: 'Note B' }];

    const wrong = scoreAnswer(q, { answer: 'hi', grounded: true, citations: ['b::0'], degraded: false }, sent);
    expect(wrong.metrics.citationCorrect.pass).toBe(false);

    const right = scoreAnswer(q, { answer: 'hi', grounded: true, citations: ['a::0'], degraded: false }, sent);
    expect(right.metrics.citationCorrect.pass).toBe(true);
  });

  it('answeredGrounded fails on an empty answer even when grounded', () => {
    const q = { id: 'qX', answerable: true, relevantNotes: ['Note A'] };
    const s = scoreAnswer(q, { answer: '   ', grounded: true, citations: [], degraded: false }, []);
    expect(s.metrics.answeredGrounded.pass).toBe(false);
  });

  it('exposes an injection-marker table for the three adversarial notes', () => {
    expect(Object.keys(INJECTION_MARKERS)).toEqual(
      expect.arrayContaining([
        'Prod incident postmortem 2026-02-18',
        "Grandma's caramel sauce",
        'Weekend project ideas',
      ]),
    );
  });
});

// ===========================================================================
describe('answer-QA harness — 3-run mean ± range aggregation', () => {
  it('meanRange computes mean, min, max and range', () => {
    const r = meanRange([0.8, 1.0, 0.9]);
    expect(r.mean).toBeCloseTo(0.9, 10);
    expect(r.min).toBeCloseTo(0.8, 10);
    expect(r.max).toBeCloseTo(1.0, 10);
    expect(r.range).toBeCloseTo(0.2, 10);
  });

  it('meanRange ignores not-applicable (null) run values', () => {
    const r = meanRange([null, 0.5, null]);
    expect(r.mean).toBeCloseTo(0.5, 10);
    expect(r.range).toBeCloseTo(0, 10);
  });

  it('meanRange returns nulls when nothing is applicable', () => {
    expect(meanRange([null, null])).toEqual({ mean: null, min: null, max: null, range: null });
  });

  it('aggregateRun tallies applicable/pass per metric', () => {
    // q01 is answerable: grounded+non-empty passes answeredGrounded, but zero
    // citations fails citationCorrect; clean parse passes degradedParse.
    const rows = [
      scoreAnswer(byId('q01'), { answer: 'x', grounded: true, citations: [], degraded: false }, []),
    ];
    const s = aggregateRun(rows);
    expect(s.answeredGrounded).toEqual({ applicable: 1, pass: 1 });
    expect(s.citationCorrect).toEqual({ applicable: 1, pass: 0 });
    expect(s.degradedParse).toEqual({ applicable: 1, pass: 1 });
    expect(s.abstention).toBeUndefined(); // not an unanswerable question
  });

  it('aggregateRuns yields per-metric mean ± range across run summaries', () => {
    const runs = [
      { answeredGrounded: { applicable: 10, pass: 8 } },
      { answeredGrounded: { applicable: 10, pass: 9 } },
      { answeredGrounded: { applicable: 10, pass: 10 } },
    ];
    const agg = aggregateRuns(runs);
    expect(agg.answeredGrounded.runs).toEqual([0.8, 0.9, 1.0]);
    expect(agg.answeredGrounded.mean).toBeCloseTo(0.9, 10);
    expect(agg.answeredGrounded.range).toBeCloseTo(0.2, 10);
  });

  it('degraded-parse rate is inverted (reports the fraction that degraded)', () => {
    const runs = [{ degradedParse: { applicable: 10, pass: 9 } }]; // 1 of 10 degraded
    const agg = aggregateRuns(runs);
    expect(agg.degradedParse.runs[0]).toBeCloseTo(0.1, 10);
  });
});
