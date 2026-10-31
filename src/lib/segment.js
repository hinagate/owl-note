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

import { tokenize } from './phonetics.js';
import { pronunciationCues, holdFinalStop, startsWithConsonant } from './ipa-cues.js';
import { readEnglish, readNumber, PREFIX_READINGS } from './english-forms.js';
import { heteronymReading, isHeteronym, isSkipped } from './heteronyms.js';

const KANJI = /[一-鿿㐀-䶿]/;
const KANA = /[぀-ヿ]/;

// Longest key the baked tables contain. The builders enforce these, and the matcher trusts
// them: without a bound, one long entry would cost every character in the document a scan
// that deep. Keep in step with scripts/build-{kana,jyutping}-dict.mjs, which import them.
export const MAX_SURFACE = 8;
export const MAX_PHRASE = 6;

/**
 * Han characters alone cannot say whether text is Japanese or Chinese, so decide from the
 * company they keep: any kana at all means Japanese. Chinese is read in Cantonese — the
 * only Chinese reading this app offers.
 * @returns {'ja'|'yue'}
 */
export function detectHanScript(text) {
  return KANA.test(String(text || '')) ? 'ja' : 'yue';
}

// How much of a kana-less block the Japanese dictionary must account for before we still
// call it Japanese. Real Japanese scores near 1.0; written Cantonese lands far lower,
// because its own characters (嘅, 咗, 佢, 哋) and Traditional forms Japanese simplified
// (們, 個, 這) match nothing in a Japanese word list.
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

// Every character any Japanese entry is written with, per loaded kana table. Built once —
// a pass over its ~374k keys — the first time a kana-less block needs judging.
const japaneseChars = new WeakMap();
function charsJapaneseUses(kana) {
  let chars = japaneseChars.get(kana);
  if (!chars) {
    chars = new Set();
    for (const key of kana.keys()) for (const char of key) chars.add(char);
    japaneseChars.set(kana, chars);
  }
  return chars;
}

/**
 * Which script THIS block is in, given what the note as a whole looked like.
 *
 * Per block rather than per note because one note really can hold both: a language-learning
 * note setting a Japanese sentence beside its Cantonese equivalent is the case this exists
 * for. Kana in the block settles it outright. Without kana the note-level answer usually
 * still applies — a kanji-only heading inside a Japanese note is Japanese — so that is the
 * default, and only a block the Japanese dictionary cannot account for moves to Cantonese.
 *
 * Coverage alone was fooled by 得閒出來飲茶: the dictionary knows 出來 (an old spelling of
 * 出来) and 飲茶, so five of six characters "were Japanese". A character that no Japanese
 * entry is written with at all settles it instead — written Cantonese (佢, 哋, 嘅) and
 * Traditional forms Japanese replaced (閒, 們). Japanese has no reading for such a character
 * anyway, so even a lone one is better read as Cantonese.
 * @returns {'ja'|'yue'}
 */
export function scriptForBlock(text, kana, fallback = 'yue') {
  if (KANA.test(text)) return 'ja';
  if (fallback === 'yue' || !kana) return fallback;
  const japanese = charsJapaneseUses(kana);
  for (const char of text) if (KANJI.test(char) && !japanese.has(char)) return 'yue';
  const { han, ratio } = japaneseCoverage(text, kana);
  return han >= MIN_HAN && ratio < JA_COVERAGE ? 'yue' : fallback;
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
 * @param {{ ipa?: Map|null, kana?: Map|null, jyutping?: Map|null, script?: 'ja'|'yue' }} tables
 *   `script` is the note-level reading, used as the default for blocks that hold no kana
 *   of their own; each block is still classified individually.
 * @returns {(text: string) => { text: string, reading: string|null, parts?: object[] }[]}
 *   runs whose `text` concatenates back to the input exactly — the annotator relies on
 *   that to keep the rendered document byte-identical apart from the readings it adds.
 *   English runs may carry `parts`, the reading split into pronunciation cues
 *   (see ./ipa-cues.js).
 */
export function makeSegmenter({ ipa = null, kana = null, jyutping = null, script = 'yue' } = {}) {
  return function segment(input) {
    const text = String(input || '');
    // The annotator calls this once per text node, so "block" is a paragraph or smaller —
    // fine enough that a Cantonese line inside a Japanese note is judged on its own.
    const blockScript = scriptForBlock(text, kana, script);
    const cjk = blockScript === 'ja' ? kana : jyutping;
    const limit = blockScript === 'ja' ? MAX_SURFACE : MAX_PHRASE;
    // Where a dictionary entry may begin. Japanese has to include kana, because entries
    // like お茶 and ご飯 start with one — matching only at kanji would leave those forever
    // unread. The kana table only holds kanji-bearing surfaces, so trying at a kana costs
    // a miss at worst, never a wrong reading. Jyutping keys are Han-only, so Cantonese
    // needs no such rule.
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
          else emitCantonese(hit, flush, runs);
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
      // `text` is what the ruby covers when it is more than the word itself (see below).
      const emitEnglish = (word, reading, text = word) => {
        if (!reading) { keep(text); return; }
        flush();
        // English readings also say how to say the word — where the stress falls, which
        // vowel to hold, which final consonant to sound. Function words have none of
        // that to say and stay a bare {text, reading}.
        const parts = pronunciationCues(reading, word);
        runs.push(parts ? { text, reading, parts } : { text, reading });
      };
      // A number is read in English only in English company: 8 in "for about 8 years" is
      // eight, but in 我有8個 or a line with no Latin letters at all it is not English.
      const latinBlock = hasLatin(text);
      let offset = at;
      for (const run of tokenize(text.slice(at, end))) {
        const from = offset;
        offset += run.text.length;
        if (run.isNumber) {
          const touchesCjk = startsEntry.test(text[from - 1] || '') || startsEntry.test(text[offset] || '');
          const number = ipa && latinBlock && !touchesCjk ? readNumber(ipa, run.text) : null;
          if (!number) { keep(run.text); continue; }
          // One word (8 → eight) gets that word's cues; several (25) read plainly.
          emitEnglish(number.words.length === 1 ? number.words[0] : run.text, number.reading, run.text);
          continue;
        }
        if (!run.isWord || !ipa) { keep(run.text); continue; }
        const reading = readEnglish(ipa, run.text);
        if (reading || !run.text.includes('-')) { emitEnglish(run.text, reading); continue; }
        // The tokenizer keeps a hyphenated word whole because the dictionary lists ~1000 of
        // them (well-known, e-mail). One it doesn't list — high-availability — is read
        // part by part. Each hyphen rides with the word before it (high- over haɪ): left
        // loose between two rubies, it let Chrome break BEFORE it, opening a line on
        // "-enter". Inside the ruby the only break is after it, where hyphens break.
        // The tokenizer's word pattern guarantees single hyphens between letter runs.
        const pieces = run.text.split('-');
        pieces.forEach((piece, i) => {
          const last = i === pieces.length - 1;
          const prefix = last ? null : PREFIX_READINGS[piece.toLowerCase()];
          emitEnglish(piece, prefix || readEnglish(ipa, piece), last ? piece : `${piece}-`);
        });
      }
      at = end;
    }

    flush();
    return markHeldStops(applyHeteronyms(runs));
  };
}

const isEnglishRun = (run) => Boolean(run?.reading) && !run.lang;

/**
 * Give each heteronym (use, read, live …) the reading its neighbours call for — see
 * ./heteronyms.js. Runs before markHeldStops, which depends on how the word now ends.
 */
function applyHeteronyms(runs) {
  runs.forEach((run, i) => {
    if (!isEnglishRun(run) || !isHeteronym(run.text)) return;
    const reading = heteronymReading(run.text, neighbours(runs, i));
    if (!reading || reading === run.reading) return;
    run.reading = reading;
    const parts = pronunciationCues(reading, run.text);
    if (parts) run.parts = parts;
    else delete run.parts;
  });
  return runs;
}

/**
 * The words either side of runs[i]. Looking back, adverbs are passed over (We also use →
 * We); a pause, a word with no reading, or CJK text ends the search with nothing found,
 * and a sentence end — or the start of the text — also says the word opens a sentence.
 * Looking forward, only spaces may come between.
 */
function neighbours(runs, i) {
  let prev = null;
  let sentenceStart = false;
  for (let j = i - 1; ; j -= 1) {
    if (j < 0) { sentenceStart = true; break; }
    const run = runs[j];
    if (isEnglishRun(run)) {
      if (isSkipped(run.text)) continue;
      prev = run.text;
      break;
    }
    if (run.lang) break;
    const gap = run.text.trim();
    if (!gap) continue;
    if (/^[.!?…"”’)\]]+$/.test(gap)) sentenceStart = true;
    break;
  }
  let next = null;
  for (let j = i + 1; j < runs.length; j += 1) {
    const run = runs[j];
    if (isEnglishRun(run)) { next = run.text; break; }
    if (run.lang || /\S/.test(run.text)) break;
  }
  return { prev, next, sentenceStart };
}

/**
 * Mark the words whose final p, t or k is held — which depends on the word AFTER it. Only
 * a consonant takes the stop silently (what do → wʌ(t)); a vowel links to it instead
 * (what is → "wha-dis"), and before a pause it varies, so neither is marked. Nothing but
 * spaces may come between the two words: a comma is a pause.
 */
function markHeldStops(runs) {
  const isEnglish = isEnglishRun;
  runs.forEach((run, i) => {
    if (!isEnglish(run)) return;
    let next = runs[i + 1];
    // A hyphenated part (high-) carries its hyphen, so the next part follows with no gap.
    if (!run.text.endsWith('-')) {
      if (!next || next.reading || !/^[ \t\u00a0]+$/.test(next.text)) return;
      next = runs[i + 2];
    }
    if (!isEnglish(next) || !startsWithConsonant(next.reading)) return;
    const parts = holdFinalStop(run.reading, run.parts ?? null);
    if (parts) run.parts = parts;
  });
  return runs;
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

/** Jyutping is written per character, so a matched word becomes one ruby per character. */
function emitCantonese({ key, value }, flush, runs) {
  const syllables = value.split(' ');
  flush();
  [...key].forEach((char, i) => {
    runs.push({ text: char, reading: syllables[i] ?? null, lang: 'yue' });
  });
}
