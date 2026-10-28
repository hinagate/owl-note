// Bakes rime-cantonese into the compact hanzi→Jyutping table the extension loads at runtime.
//
// Runs at BUILD time only: the source dictionaries (~3 MB, vendor/rime-cantonese) never
// enter the shipped bundle — only the generated table does, fetched lazily the first time
// a reader turns phonetics on for a note that actually contains Chinese characters.
//
// Readings are Jyutping with tone numbers (gwong2 dung1 waa2): the Hong Kong standard, and
// what rime-cantonese, words.hk and CanCLID all use.
//
// The table is small (~260 KB gzipped) because it stores exceptions, not readings. Each
// character gets one default reading, chosen by how often that reading wins across the
// whole word list with the character dictionary's own favourite weighted in; a word is
// stored ONLY when its actual reading differs from what those defaults would produce —
// 銀行/ngan4 hong4 is stored, 行路/haang4 lou6 is not.
//
// Traditional characters only, which is what rime-cantonese covers and what Cantonese is
// written in. Covering Simplified as well measured at +128 KB gzipped.
//
// Pronunciation data comes from rime-cantonese, CC BY 4.0 — see
// vendor/rime-cantonese/README.md, and the README's "Pronunciation data" section for the
// credit. This is DATA, not code: no URLs and no executable content, so it passes the
// release audit's remote-code scan.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { MAX_PHRASE } from '../src/lib/segment.js';

const SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'rime-cantonese');
const read = (name) => readFileSync(path.join(SOURCE, name), 'utf8');

// The characters the runtime matcher can look up (BMP Han and Extension A).
const HAN_ONLY = /^[一-鿿㐀-䶿]+$/;
const SYLLABLE = /^[a-z]+[1-6]$/;

/** The rows of a Rime dict.yaml: everything after the `...` that closes its header. */
export function dictRows(text) {
  const lines = String(text || '').split(/\r?\n/);
  const start = lines.indexOf('...');
  return lines.slice(start + 1)
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split('\t'));
}

// Characters whose commonest use in running Cantonese is one the word list cannot see,
// because it is the character standing alone. Without these, 我會去 read 會 as the wui2 of
// 開會, and every sentence-final 呀 came out aa4. Words keep their own readings regardless:
// 開會, 將軍 and 銀行 differ from these defaults, so they are stored as exceptions.
export const DEFAULT_READINGS = {
  會: 'wui5', // will — 我會去
  呀: 'aa3', // the sentence-final particle — 好呀
  將: 'zoeng1', // 將來, and the formal "will" of 會議將於
  行: 'haang4', // walk — 佢行得好快
};

const syllables = (reading) => {
  const list = String(reading || '').trim().split(/\s+/);
  return list.every((s) => SYLLABLE.test(s)) ? list : null;
};

/**
 * @param {{ chars?: string, words?: string }} [source] the two dict.yaml texts
 * @returns {{ text: string, chars: number, words: number }}
 */
export function buildJyutpingTable({
  chars = read('jyut6ping3.chars.dict.yaml'),
  words = read('jyut6ping3.words.dict.yaml'),
} = {}) {
  // Each character's favourite reading by the dictionary's own weight (no weight means the
  // standard reading, 100%).
  const favourite = new Map();
  for (const [char, reading, weight] of dictRows(chars)) {
    if (!char || char.length !== 1 || !HAN_ONLY.test(char) || !syllables(reading)) continue;
    const w = weight ? parseFloat(weight) : 100;
    const best = favourite.get(char);
    if (!best || w > best[1]) favourite.set(char, [reading, w]);
  }

  // Words: the first reading listed for a surface wins.
  const wordReadings = new Map();
  for (const [surface, reading] of dictRows(words)) {
    const list = syllables(reading);
    if (!list || !HAN_ONLY.test(surface || '') || wordReadings.has(surface)) continue;
    wordReadings.set(surface, list);
  }

  // Default reading per character: how often each reading wins across the word list, with
  // the favourite weighted to win ties. Measured against letting the favourite alone
  // decide, this leaves fewer words that need storing: 260 KB against 312 KB gzipped, for
  // the same accuracy on a hand-checked set.
  const tally = new Map();
  const add = (char, reading, n) => {
    const counts = tally.get(char) ?? new Map();
    counts.set(reading, (counts.get(reading) ?? 0) + n);
    tally.set(char, counts);
  };
  for (const [char, [reading]] of favourite) add(char, reading, 3);
  for (const [surface, reading] of wordReadings) {
    if (reading.length !== surface.length) continue; // can't align; contributes nothing
    [...surface].forEach((char, i) => add(char, reading[i], 1));
  }
  const defaults = new Map();
  for (const [char, counts] of tally) {
    defaults.set(char, [...counts].sort((a, b) => b[1] - a[1])[0][0]);
  }
  for (const [char, reading] of Object.entries(DEFAULT_READINGS)) {
    if (defaults.has(char)) defaults.set(char, reading);
  }

  const rows = [...defaults].map(([char, reading]) => `${char}\t${reading}`);
  const charCount = rows.length;
  for (const [surface, reading] of wordReadings) {
    if (surface.length < 2 || surface.length > MAX_PHRASE) continue;
    if (reading.length !== surface.length) continue;
    // Nothing to store when reading it character by character already gets it right.
    if ([...surface].every((char, i) => defaults.get(char) === reading[i])) continue;
    rows.push(`${surface}\t${reading.join(' ')}`);
  }

  return { text: `${rows.join('\n')}\n`, chars: charCount, words: rows.length - charCount };
}

export function writeJyutpingTable(outPath) {
  const { text, chars, words } = buildJyutpingTable();
  const gz = gzipSync(Buffer.from(text, 'utf8'), { level: 9 });
  writeFileSync(outPath, gz);
  const kb = Math.round(gz.length / 1024);
  const rawKb = Math.round(Buffer.byteLength(text, 'utf8') / 1024);
  console.log(`Jyutping table -> ${outPath} (${chars} chars + ${words} words, ${kb} KB gzipped from ${rawKb} KB)`);
  return { chars, words, bytes: gz.length };
}

// Allow `node scripts/build-jyutping-dict.mjs dist/jyutping-yue.tsv.gz` standalone as well
// as via esbuild.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  writeJyutpingTable(process.argv[2] || 'dist/jyutping-yue.tsv.gz');
}
