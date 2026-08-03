// Bakes yomi-dict into the compact kanji→hiragana table the extension loads at runtime.
//
// Runs at BUILD time only: yomi-dict is a devDependency, so its ~10.5 MB CSV never enters
// the shipped bundle — only the generated table does, fetched lazily the first time a
// reader turns phonetics on for a note that actually contains kanji.
//
// Why a dictionary and not a morphological analyser: kuromoji, the standard choice, ships
// a 40 MB dictionary. Longest-match against a word list costs 1.7 MB and reads ~94% of
// common vocabulary correctly (measured against a hand-checked set), which is the right
// trade for a reading aid that is off by default.
//
// Format matches the IPA table — TSV, gzipped — for the same reasons: no quoting overhead,
// streams straight into a Map, and Chrome inflates it with DecompressionStream for free.
//
// Reading data comes from yomi-dict (https://github.com/marmooo/yomi-dict), which is
// Apache-2.0 — see node_modules/yomi-dict/LICENSE. Apache-2.0 is compatible with this
// repo's GPL-3.0-or-later. The generated table is DATA, not code: no URLs, no executable
// content, so it passes the release audit's remote-code scan.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { MAX_SURFACE } from '../src/lib/segment.js';

const require = createRequire(import.meta.url);
// yomi-dict's "exports" only exposes the module entry, so reach the CSV beside it rather
// than asking Node to resolve a subpath it deliberately hides.
const YOMI_CSV = join(dirname(require.resolve('yomi-dict')), 'yomi.csv');

const HAS_KANJI = /[一-鿿㐀-䶿]/;
const IS_KANA = /[぀-ヿ]/;

/** Readings are stored as hiragana because that is what furigana is written in. */
export function toHiragana(text) {
  return String(text || '').replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

// yomi-dict lists alternates as `surface,reading1,reading2`. The first is normally the
// common one, but not always — these are the cases a hand-check caught, plus entries the
// source omits entirely. Small and hand-verified on purpose: a long generated patch list
// would just be a second dictionary to keep honest.
const OVERRIDES = new Map(Object.entries({
  // Missing from the source altogether.
  日本: 'にほん', 日本人: 'にほんじん', 日本語: 'にほんご',
  // Genuine errors — the correct reading is not listed at all.
  中国: 'ちゅうごく',
  // Correct reading is listed, but not first; these pick the one a learner expects.
  今年: 'ことし', 明日: 'あした', 一昨日: 'おととい', 私: 'わたし',
  // Bare kanji fall back to a single-character lookup, where yomi-dict's primary is often
  // a bound stem (食→くえ, 思→おもえ). These are the standalone readings.
  新: 'しん', 食: 'しょく', 思: 'おも', 待: 'ま', 持: 'も', 立: 'た', 聞: 'き',
  山: 'やま', 火: 'ひ', 水: 'みず', 日: 'ひ', 月: 'つき', 木: 'き', 金: 'かね',
  行: 'い', 来: 'く', 出: 'で', 入: 'はい', 見: 'み', 言: 'い', 読: 'よ', 書: 'か',
  買: 'か', 使: 'つか', 考: 'かんが', 知: 'し', 歩: 'ある', 走: 'はし', 座: 'すわ',
  社: 'しゃ', 間: 'あいだ', 後: 'あと', 上: 'うえ', 下: 'した', 中: 'なか', 大: 'おお',
}));

// Surfaces that are really a word plus a particle. The matcher takes the longest entry it
// can, so leaving these in makes an ordinary sentence read as the greeting: 今日は新しい…
// matches 今日は and puts こんにち over 今日, where きょう is meant. Dropping the entry lets
// the plain 今日 win and costs only the greeting, which reads correctly from its parts
// anyway. Kept to cases where the reading actually changes — 今晩は resolves to こんばん
// either way, so it stays.
const DROP = new Set(['今日は']);

/**
 * @param {string} csv raw yomi-dict CSV (`surface,reading[,alternate...]` per line)
 * @returns {{ text: string, count: number, skipped: number }}
 */
export function buildKanaTable(csv = readFileSync(YOMI_CSV, 'utf8')) {
  const table = new Map();
  let skipped = 0;

  for (const line of String(csv || '').split('\n')) {
    if (!line) continue;
    const parts = line.split(',');
    const surface = parts[0];
    const reading = toHiragana((parts[1] || '').trim()); // primary reading only
    // A kana-only word already reads as written, so annotating it would be noise.
    if (!surface || !reading || !HAS_KANJI.test(surface)) { skipped += 1; continue; }
    if (surface.length > MAX_SURFACE || DROP.has(surface)) { skipped += 1; continue; }
    if (table.has(surface)) { skipped += 1; continue; } // first entry wins, like CMUdict

    table.set(surface, coreReading(surface, reading));
  }

  for (const [surface, reading] of OVERRIDES) table.set(surface, toHiragana(reading));

  const rows = [...table].map(([surface, reading]) => `${surface}\t${reading}`);
  return { text: `${rows.join('\n')}\n`, count: rows.length, skipped };
}

/**
 * Strip the okurigana the surface and its reading already share, so the value holds only
 * the part that sits above the kanji: 食べる/たべる stores `た`, not `たべる`. The key keeps
 * its kana — dropping it would merge 新しい (あたら) into 新 (しん) and lose the distinction.
 */
function coreReading(surface, reading) {
  const kana = toHiragana(surface);
  let head = 0;
  while (head < kana.length && IS_KANA.test(kana[head]) && kana[head] === reading[head]) head += 1;
  let body = kana.slice(head);
  let value = reading.slice(head);
  let tail = 0;
  while (
    tail < body.length
    && IS_KANA.test(body[body.length - 1 - tail])
    && body[body.length - 1 - tail] === value[value.length - 1 - tail]
  ) tail += 1;
  if (tail) value = value.slice(0, -tail);
  return value || reading;
}

export function writeKanaTable(outPath) {
  const { text, count, skipped } = buildKanaTable();
  const gz = gzipSync(Buffer.from(text, 'utf8'), { level: 9 });
  writeFileSync(outPath, gz);
  const kb = Math.round(gz.length / 1024);
  const rawKb = Math.round(Buffer.byteLength(text, 'utf8') / 1024);
  console.log(`kana table -> ${outPath} (${count} entries, ${skipped} skipped, ${kb} KB gzipped from ${rawKb} KB)`);
  return { count, skipped, bytes: gz.length };
}

// Allow `node scripts/build-kana-dict.mjs dist/kana-ja.tsv.gz` standalone as well as via esbuild.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  writeKanaTable(process.argv[2] || 'dist/kana-ja.tsv.gz');
}
