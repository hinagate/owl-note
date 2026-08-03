// Turns a run of text into the annotated pieces a ruby annotator renders.
//
// English can be tokenized then looked up, because a word's boundaries are visible in the
// text. CJK cannot: 日本 is one reading, not two, and nothing in the string says so. So the
// dictionary decides the boundaries — at each character the matcher takes the longest
// surface the table knows, which is why this replaced the per-word `reading` callback the
// English-only version used.
//
// One pass handles mixed text. A note that quotes English inside Japanese gets IPA on the
// English and kana on the kanji without either table knowing the other exists.

import { tokenize, lookup } from './phonetics.js';

const KANJI = /[一-鿿㐀-䶿]/;
const KANA = /[぀-ヿ]/;

// Longest key the baked tables contain. The builders enforce these, and the matcher trusts
// them: without a bound, one long entry would cost every character in the document a scan
// that deep. Keep in step with scripts/build-{kana,pinyin}-dict.mjs, which import them.
export const MAX_SURFACE = 8;
export const MAX_PHRASE = 6;

/**
 * Han characters alone cannot say whether text is Japanese or Chinese, so decide from the
 * company they keep: any kana at all means Japanese.
 * @returns {'ja'|'zh'}
 */
export function detectHanScript(text) {
  return KANA.test(String(text || '')) ? 'ja' : 'zh';
}

// How much of a kana-less block the Japanese dictionary must account for before we still
// call it Japanese. Real Japanese scores near 1.0; Chinese lands around 0.5, because
// simplified forms (习, 门, 让, 的) match nothing in a Japanese word list.
const JA_COVERAGE = 0.8;
// Below this many Han characters there is not enough signal to overrule the note.
const MIN_HAN = 3;

/**
 * Fraction of the Han characters in `text` that fall inside some Japanese dictionary entry.
 *
 * Deliberately measured by matching whole entries, not by testing characters one at a time:
 * most kanji have no single-character row (概 only ever appears inside words like 概要), so
 * a per-character test rates ordinary Japanese as foreign.
 */
function japaneseCoverage(text, kana) {
  let han = 0;
  let covered = 0;
  let at = 0;
  while (at < text.length) {
    if (!KANJI.test(text[at])) { at += 1; continue; }
    const hit = longestMatch(kana, text, at, MAX_SURFACE);
    if (!hit) { han += 1; at += 1; continue; }
    for (const char of hit.key) {
      if (KANJI.test(char)) { han += 1; covered += 1; }
    }
    at += hit.key.length;
  }
  return { han, ratio: han ? covered / han : 1 };
}

/**
 * Which script THIS block is in, given what the note as a whole looked like.
 *
 * Per block rather than per note because one note really can hold both: a language-learning
 * note setting a Japanese sentence beside its Chinese equivalent is the case this exists
 * for. Kana in the block settles it outright. Without kana the note-level answer usually
 * still applies — a kanji-only heading inside a Japanese note is Japanese — so that is the
 * default, and only a block the Japanese dictionary cannot account for moves to Chinese.
 * @returns {'ja'|'zh'}
 */
export function scriptForBlock(text, kana, fallback = 'zh') {
  if (KANA.test(text)) return 'ja';
  if (fallback === 'zh' || !kana) return fallback;
  const { han, ratio } = japaneseCoverage(text, kana);
  return han >= MIN_HAN && ratio < JA_COVERAGE ? 'zh' : fallback;
}

/** @returns {boolean} whether the text has any Han character worth a CJK table at all. */
export function hasHan(text) {
  return KANJI.test(String(text || ''));
}

/** @returns {boolean} whether fetching the English table would annotate anything. */
export function hasLatin(text) {
  return /\p{Script=Latin}/u.test(String(text || ''));
}

/** Longest table entry starting at `from`, or null. */
function longestMatch(table, text, from, limit) {
  const max = Math.min(limit, text.length - from);
  for (let length = max; length >= 1; length -= 1) {
    const key = text.slice(from, from + length);
    const value = table.get(key);
    if (value !== undefined) return { key, value };
  }
  return null;
}

/**
 * Build a segmenter over whichever tables are loaded.
 * @param {{ ipa?: Map|null, kana?: Map|null, pinyin?: Map|null, script?: 'ja'|'zh' }} tables
 *   `script` is the note-level reading, used as the default for blocks that hold no kana
 *   of their own; each block is still classified individually.
 * @returns {(text: string) => { text: string, reading: string|null }[]} runs whose `text`
 *   concatenates back to the input exactly — the annotator relies on that to keep the
 *   rendered document byte-identical apart from the readings it adds.
 */
export function makeSegmenter({ ipa = null, kana = null, pinyin = null, script = 'zh' } = {}) {
  return function segment(input) {
    const text = String(input || '');
    // The annotator calls this once per text node, so "block" is a paragraph or smaller —
    // fine enough that a Chinese line inside a Japanese note is judged on its own.
    const blockScript = scriptForBlock(text, kana, script);
    const cjk = blockScript === 'ja' ? kana : pinyin;
    const limit = blockScript === 'ja' ? MAX_SURFACE : MAX_PHRASE;
    // Where a dictionary entry may begin. Japanese has to include kana, because entries
    // like お茶 and ご飯 start with one — matching only at kanji would leave those forever
    // unread. The kana table only holds kanji-bearing surfaces, so trying at a kana costs
    // a miss at worst, never a wrong reading. Pinyin keys are Han-only, so Chinese needs
    // no such rule.
    const startsEntry = blockScript === 'ja' ? /[一-鿿㐀-䶿぀-ヿ]/ : KANJI;

    const runs = [];
    let plain = '';
    const keep = (piece) => { plain += piece; };
    const flush = () => {
      if (!plain) return;
      runs.push({ text: plain, reading: null });
      plain = '';
    };

    let at = 0;
    while (at < text.length) {
      if (cjk && startsEntry.test(text[at])) {
        const hit = longestMatch(cjk, text, at, limit);
        if (hit) {
          if (blockScript === 'ja') emitJapanese(hit, keep, flush, runs);
          else emitChinese(hit, flush, runs);
          at += hit.key.length;
          continue;
        }
        keep(text[at]);
        at += 1;
        continue;
      }

      // Everything up to the next CJK character is ordinary text: hand it to the English
      // tokenizer, which leaves punctuation alone as gaps.
      let end = at;
      while (end < text.length && !(cjk && startsEntry.test(text[end]))) end += 1;
      for (const run of tokenize(text.slice(at, end))) {
        const reading = run.isWord && ipa ? lookup(ipa, run.text) : null;
        if (!reading) { keep(run.text); continue; }
        flush();
        runs.push({ text: run.text, reading });
      }
      at = end;
    }

    flush();
    return runs;
  };
}

/**
 * The stored reading covers only the kanji core, so the okurigana the key carries stays
 * bare: 食べる annotates 食 with た and leaves べる alone, which is where furigana belongs.
 */
function emitJapanese({ key, value }, keep, flush, runs) {
  let start = 0;
  while (start < key.length && KANA.test(key[start])) start += 1;
  let end = key.length;
  while (end > start && KANA.test(key[end - 1])) end -= 1;

  keep(key.slice(0, start));
  const core = key.slice(start, end);
  if (!core) return; // all kana after all — nothing to annotate
  flush();
  runs.push({ text: core, reading: value, lang: 'ja' });
  keep(key.slice(end));
}

/** Pinyin is written per character, so a matched phrase becomes one ruby per hanzi. */
function emitChinese({ key, value }, flush, runs) {
  const syllables = value.split(' ');
  flush();
  [...key].forEach((char, i) => {
    runs.push({ text: char, reading: syllables[i] ?? null, lang: 'zh' });
  });
}
