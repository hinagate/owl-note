import { describe, it, expect, beforeEach } from 'vitest';
import { gzipSync } from 'node:zlib';
import {
  parseTable, normalizeWord, tokenize, lookup, loadTable, ensureTable, resetTables,
} from '../src/lib/phonetics.js';

const TABLE = "phonics\tˈfɑnɪks\nis\tɪz\nuseful\tˈjusfəl\ndon't\tdoʊnt\nwell-known\tˈwɛlˈnoʊn\n";

beforeEach(() => resetTables());

describe('parseTable', () => {
  it('reads word/reading pairs and ignores blank or malformed lines', () => {
    const table = parseTable(`${TABLE}\n\nbroken-line-without-tab\n`);
    expect(table.get('phonics')).toBe('ˈfɑnɪks');
    expect(table.size).toBe(5);
  });

  it('survives empty input', () => {
    expect(parseTable('').size).toBe(0);
    expect(parseTable(null).size).toBe(0);
  });

  it('keeps a reading that itself contains spaces, as the pinyin table needs', () => {
    expect(parseTable('银行\tyín háng\n').get('银行')).toBe('yín háng');
  });
});

describe('tokenize', () => {
  it('keeps every gap so the text can be rebuilt exactly', () => {
    const text = 'Phonics is useful!';
    expect(tokenize(text).map((t) => t.text).join('')).toBe(text);
    expect(tokenize(text).filter((t) => t.isWord).map((t) => t.text))
      .toEqual(['Phonics', 'is', 'useful']);
  });

  it('holds apostrophes and hyphens inside the word, matching CMUdict entries', () => {
    expect(tokenize("don't stop").filter((t) => t.isWord).map((t) => t.text))
      .toEqual(["don't", 'stop']);
    expect(tokenize('a well-known case').filter((t) => t.isWord).map((t) => t.text))
      .toEqual(['a', 'well-known', 'case']);
  });

  it('leaves digits and punctuation as gaps rather than words', () => {
    expect(tokenize('3 cats, 2 dogs').filter((t) => t.isWord).map((t) => t.text))
      .toEqual(['cats', 'dogs']);
  });

  it('handles non-Latin text without inventing words', () => {
    const jp = '漢字の読み';
    // \p{L} matches kanji and kana too — phase 2 replaces the lookup, not the split.
    expect(tokenize(jp).map((t) => t.text).join('')).toBe(jp);
  });

  it('returns nothing for empty input', () => {
    expect(tokenize('')).toEqual([]);
  });
});

describe('lookup', () => {
  const table = parseTable(TABLE);

  it('is case-insensitive', () => {
    expect(lookup(table, 'Phonics')).toBe('ˈfɑnɪks');
    expect(lookup(table, 'PHONICS')).toBe('ˈfɑnɪks');
  });

  it('folds a typographic apostrophe onto the ASCII one CMUdict uses', () => {
    expect(lookup(table, 'don’t')).toBe('doʊnt');
  });

  it('returns null for an unknown word instead of an empty annotation', () => {
    expect(lookup(table, 'covid')).toBe(null);
    expect(normalizeWord('COVID')).toBe('covid');
  });

  it('returns null without a table rather than throwing', () => {
    expect(lookup(null, 'phonics')).toBe(null);
  });
});

describe('loadTable', () => {
  const gzipped = () => new Response(gzipSync(Buffer.from(TABLE, 'utf8')));

  it('inflates the gzipped table it fetches', async () => {
    const table = await loadTable('/ipa-en.tsv.gz', async () => gzipped());
    expect(table.get('useful')).toBe('ˈjusfəl');
  });

  it('reports an unavailable table rather than resolving empty', async () => {
    await expect(loadTable('/x', async () => new Response('', { status: 404 })))
      .rejects.toThrow('reading table unavailable (404)');
  });

  it('loads once and reuses the result', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return gzipped(); };
    const [a, b] = await Promise.all([
      ensureTable('/ipa-en.tsv.gz', fetchImpl),
      ensureTable('/ipa-en.tsv.gz', fetchImpl),
    ]);
    expect(calls).toBe(1);
    expect(a).toBe(b);
  });

  it('caches per URL, so each language table loads independently', async () => {
    const urls = [];
    const fetchImpl = async (url) => { urls.push(url); return gzipped(); };
    await Promise.all([
      ensureTable('/ipa-en.tsv.gz', fetchImpl),
      ensureTable('/kana-ja.tsv.gz', fetchImpl),
      ensureTable('/ipa-en.tsv.gz', fetchImpl), // already cached
    ]);
    expect(urls).toEqual(['/ipa-en.tsv.gz', '/kana-ja.tsv.gz']);
  });

  it('does not cache a failure — toggling on again while offline must be able to work', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) throw new Error('offline');
      return gzipped();
    };
    await expect(ensureTable('/ipa-en.tsv.gz', fetchImpl)).rejects.toThrow('offline');
    expect((await ensureTable('/ipa-en.tsv.gz', fetchImpl)).get('is')).toBe('ɪz');
    expect(calls).toBe(2);
  });

  it('a failed table does not poison a different one', async () => {
    const fetchImpl = async (url) => (url.includes('kana')
      ? new Response('', { status: 404 })
      : gzipped());
    await expect(ensureTable('/kana-ja.tsv.gz', fetchImpl)).rejects.toThrow();
    expect((await ensureTable('/ipa-en.tsv.gz', fetchImpl)).get('is')).toBe('ɪz');
  });
});
