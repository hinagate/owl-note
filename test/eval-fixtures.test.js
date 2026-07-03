// @vitest-environment node
//
// Integrity gate for the M5 evaluation fixtures (Task E1). This is a MACHINE
// CHECK on the corpus + golden question set's cross-references, not a test of
// app code: it reads eval/ straight off disk and asserts the composition and
// referential rules the brief requires, so a fixture typo (a misspelled note
// title in golden.json, a missing category, an unanswerable question that
// smuggled in a relevantNote) fails CI instead of silently poisoning E2's
// numbers. Frontmatter is parsed with a tiny regex on purpose — no new deps,
// and it mirrors the "exactly this format" the E2 loader will itself parse.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const EVAL = join(HERE, '..', 'eval');
const CORPUS = join(EVAL, 'corpus');

const CJK_LANGS = new Set(['zh', 'ja', 'ko']);
const PRIMARY_TAGS = new Set(['direct', 'paraphrase', 'cjk', 'injection', 'unanswerable', 'multi-note']);
const INJECTION_RE = /ignore (all )?previous instructions/i;

// Parse the fixed frontmatter block (title/lang/tags) + body. Deliberately
// strict: the block must open the file with `---`, and title must be quoted.
function parseNote(raw) {
  // CRLF-normalized like eval/harness.mjs's twin parser: a Windows checkout with
  // core.autocrlf materializes the corpus with \r\n, which must not fail the gate.
  const text = String(raw).replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  const [, front, body] = m;
  const title = /^title:\s*"(.+)"\s*$/m.exec(front);
  const lang = /^lang:\s*([a-z-]+)\s*$/m.exec(front);
  const tags = /^tags:\s*\[(.*)\]\s*$/m.exec(front);
  if (!title || !lang || !tags) return null;
  return {
    title: title[1],
    lang: lang[1],
    tags: tags[1].split(',').map((t) => t.trim()).filter(Boolean),
    body,
  };
}

function loadCorpus() {
  const files = readdirSync(CORPUS).filter((f) => f.endsWith('.md'));
  return files.map((file) => {
    const raw = readFileSync(join(CORPUS, file), 'utf8');
    const parsed = parseNote(raw);
    return { file, raw, parsed };
  });
}

function loadGolden() {
  return JSON.parse(readFileSync(join(EVAL, 'golden.json'), 'utf8'));
}

describe('eval corpus', () => {
  const notes = loadCorpus();

  it('has 40–60 markdown notes', () => {
    expect(notes.length).toBeGreaterThanOrEqual(40);
    expect(notes.length).toBeLessThanOrEqual(60);
  });

  it('every note has parseable title/lang/tags frontmatter', () => {
    for (const n of notes) {
      expect(n.parsed, `frontmatter failed to parse: ${n.file}`).not.toBeNull();
      expect(n.parsed.title.length, `empty title: ${n.file}`).toBeGreaterThan(0);
      expect(n.parsed.body.trim().length, `empty body: ${n.file}`).toBeGreaterThan(0);
    }
  });

  it('uses kebab-case .md filenames', () => {
    for (const n of notes) {
      expect(n.file, `not kebab-case: ${n.file}`).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*\.md$/);
    }
  });

  it('titles are unique', () => {
    const titles = notes.map((n) => n.parsed.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('has ≥5 non-English notes, including ≥3 CJK', () => {
    const nonEnglish = notes.filter((n) => n.parsed.lang !== 'en');
    const cjk = notes.filter((n) => CJK_LANGS.has(n.parsed.lang));
    expect(nonEnglish.length).toBeGreaterThanOrEqual(5);
    expect(cjk.length).toBeGreaterThanOrEqual(3);
  });

  it('has at least one very long note (≥8,000 chars)', () => {
    const longest = Math.max(...notes.map((n) => n.parsed.body.length));
    expect(longest).toBeGreaterThanOrEqual(8000);
  });

  it('has ≥3 injection fixtures (adversarial instruction in the body)', () => {
    const injected = notes.filter(
      (n) => INJECTION_RE.test(n.parsed.body) || n.parsed.body.includes('<<<'),
    );
    expect(injected.length).toBeGreaterThanOrEqual(3);
  });

  it('covers the required human categories (via tags)', () => {
    const count = (tag) => notes.filter((n) => n.parsed.tags.includes(tag)).length;
    expect(count('code'), 'code-heavy').toBeGreaterThanOrEqual(5);
    expect(count('recipe'), 'recipes').toBeGreaterThanOrEqual(5);
    expect(count('meeting'), 'meeting minutes').toBeGreaterThanOrEqual(5);
    expect(count('journal'), 'journal').toBeGreaterThanOrEqual(5);
    expect(count('math'), 'math/katex').toBeGreaterThanOrEqual(2);
  });
});

describe('eval golden.json', () => {
  const notes = loadCorpus();
  const titleSet = new Set(notes.map((n) => n.parsed.title));
  const golden = loadGolden();
  const questions = golden.questions;

  it('is version 1 with 40–50 questions', () => {
    expect(golden.version).toBe(1);
    expect(Array.isArray(questions)).toBe(true);
    expect(questions.length).toBeGreaterThanOrEqual(40);
    expect(questions.length).toBeLessThanOrEqual(50);
  });

  it('every question is well-formed with exactly one primary tag', () => {
    for (const q of questions) {
      expect(typeof q.id, `id: ${q.id}`).toBe('string');
      expect(q.question.trim().length, `question text: ${q.id}`).toBeGreaterThan(0);
      expect(Array.isArray(q.relevantNotes), `relevantNotes array: ${q.id}`).toBe(true);
      expect(typeof q.answerable, `answerable bool: ${q.id}`).toBe('boolean');
      const primaries = q.tags.filter((t) => PRIMARY_TAGS.has(t));
      expect(primaries.length, `exactly one primary tag: ${q.id}`).toBe(1);
    }
  });

  it('ids are unique', () => {
    const ids = questions.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every relevantNotes title exists in the corpus', () => {
    for (const q of questions) {
      for (const title of q.relevantNotes) {
        expect(titleSet.has(title), `unknown note "${title}" in ${q.id}`).toBe(true);
      }
    }
  });

  it('answerable ⇔ non-empty relevantNotes; unanswerable ⇔ empty', () => {
    for (const q of questions) {
      expect(q.answerable, `answerable/relevantNotes mismatch: ${q.id}`).toBe(q.relevantNotes.length > 0);
      const isUnanswerableTag = q.tags.includes('unanswerable');
      expect(isUnanswerableTag, `unanswerable tag vs answerable: ${q.id}`).toBe(!q.answerable);
    }
  });

  it('multi-note questions cite ≥2 notes', () => {
    for (const q of questions.filter((q) => q.tags.includes('multi-note'))) {
      expect(q.relevantNotes.length, `multi-note needs 2+ notes: ${q.id}`).toBeGreaterThanOrEqual(2);
    }
  });

  it('meets the per-tag minimums', () => {
    const count = (tag) => questions.filter((q) => q.tags.includes(tag)).length;
    expect(count('paraphrase'), 'paraphrase').toBeGreaterThanOrEqual(10);
    expect(count('cjk'), 'cjk').toBeGreaterThanOrEqual(6);
    expect(count('unanswerable'), 'unanswerable').toBeGreaterThanOrEqual(8);
    expect(count('injection'), 'injection').toBeGreaterThanOrEqual(3);
    expect(count('multi-note'), 'multi-note').toBeGreaterThanOrEqual(3);
  });

  it('cjk questions point at CJK notes', () => {
    const cjkTitles = new Set(
      notes.filter((n) => CJK_LANGS.has(n.parsed.lang)).map((n) => n.parsed.title),
    );
    for (const q of questions.filter((q) => q.tags.includes('cjk'))) {
      expect(q.relevantNotes.length, `cjk question needs a note: ${q.id}`).toBeGreaterThan(0);
      for (const title of q.relevantNotes) {
        expect(cjkTitles.has(title), `cjk question ${q.id} cites non-CJK note "${title}"`).toBe(true);
      }
    }
  });
});
