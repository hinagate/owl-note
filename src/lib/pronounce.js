// Choosing how to read a selected word aloud, for Phonetic Assistance. The bar the reader
// clicks is app/pronounce-bar.js; this file holds the decisions, so they can be tested
// without a browser's voices.

import { detectHanScript } from './segment.js';

// What an online voice may be given: a word or a phrase. Past this it would be sending a
// passage of the note to its provider rather than a few words.
export const MAX_SPOKEN_CHARS = 200;

// A voice on this device sends nothing anywhere, so it may read a passage: several
// paragraphs, and well inside the 32,767 characters the browser takes in one request.
export const MAX_PASSAGE_CHARS = 10000;

// Chrome's first answer is an empty list. Its own voices and the computer's then arrive
// separately, in either order: measured at about 100 ms, but on one load the computer's were
// still missing after 2.5 s. Deciding too early would ask to use an online voice on a
// computer that has a perfectly good one of its own.
export const VOICES_SETTLE_MS = 3000;

// The reading on screen decides the voice. Chinese here is read in Cantonese (Jyutping), so
// a Mandarin voice must never stand in for one, even when it is the only Chinese voice the
// computer has: it would contradict the reading above the word.
const VOICE_TAGS = {
  en: { exact: 'en-us', family: ['en'] }, // the IPA comes from an American dictionary
  ja: { exact: 'ja-jp', family: ['ja'] },
  yue: { exact: 'zh-hk', family: ['zh-hk', 'yue'] },
};

const LANGUAGE_NAMES = { en: 'English', ja: 'Japanese', yue: 'Cantonese' };

export const languageName = (lang) => LANGUAGE_NAMES[lang] || 'this language';

const tagOf = (voice) => String(voice?.lang || '').toLowerCase().replace(/_/g, '-');

// What the reader chose in Settings, per language: { en: 'A voice name', ... }. Kept on this
// device only, because the voices are this device's.
export const VOICE_CHOICE_KEY = 'owl:pronounceVoices';
export const VOICE_LANGS = ['en', 'ja', 'yue'];

export async function readVoiceChoices(storage) {
  try {
    const saved = (await storage?.get(VOICE_CHOICE_KEY))?.[VOICE_CHOICE_KEY];
    return saved && typeof saved === 'object' ? saved : {};
  } catch {
    return {};
  }
}

/**
 * Every voice that can read a language, best first: one on this computer before any online
 * one, the exact regional voice before a relative, and the browser's default among equals.
 * @param {SpeechSynthesisVoice[]} voices
 * @param {'en'|'ja'|'yue'} lang
 * @returns {SpeechSynthesisVoice[]}
 */
export function voicesFor(voices, lang) {
  const wanted = VOICE_TAGS[lang];
  if (!wanted) return [];
  const matches = (voices || []).filter((voice) => {
    const tag = tagOf(voice);
    return wanted.family.some((name) => tag === name || tag.startsWith(`${name}-`));
  });
  const score = (voice) => (voice.localService ? 4 : 0) + (tagOf(voice) === wanted.exact ? 2 : 0) + (voice.default ? 1 : 0);
  // Stable: among equals, the browser's own order stands.
  return matches.sort((a, b) => score(b) - score(a));
}

/**
 * The voice for a reading's language: the one the reader chose, while the browser still
 * lists it for that language, and otherwise the best there is.
 * @param {SpeechSynthesisVoice[]} voices
 * @param {'en'|'ja'|'yue'} lang
 * @param {string|null} [preferred] a voice's name
 * @returns {SpeechSynthesisVoice|null}
 */
export function pickVoice(voices, lang, preferred = null) {
  const list = voicesFor(voices, lang);
  return (preferred && list.find((voice) => voice.name === preferred)) || list[0] || null;
}

// Measured against the same phrases: at 0.6 an online voice took about 60% longer, but a
// Windows voice only 4-24%, and at 0.5 still only 15-38%. So on-device voices get the lower
// setting, and neither goes lower, where words start to come apart.
export function rateFor(voice, slow) {
  if (!slow) return 1;
  return voice?.localService ? 0.5 : 0.6;
}

// What a voice cannot read, or would read as noise: the readings, which sit in the same DOM
// as the words they annotate, and code blocks, formulas and diagrams.
const UNSPOKEN = 'rt, rp, pre, .katex, .mermaid-diagram';
// Where one line of thought ends and the next begins without any punctuation to say so.
const BLOCKS = 'p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, dt, dd, figcaption, br';
const BREAK = '\u0001';
const ENDS_ITSELF = /[.!?:;,…。！？：；、，]["'”’」』)\]]*$/;

/**
 * The words alone, as a voice should be given them. A selection inside one paragraph comes
 * back as it is written. One that runs across headings, list items or paragraphs gets a
 * full stop where a line ends without punctuation, so a heading is not read straight into
 * the sentence under it.
 */
export function spokenText(range) {
  const fragment = range.cloneContents();
  fragment.querySelectorAll(UNSPOKEN).forEach((node) => node.remove());
  fragment.querySelectorAll(BLOCKS).forEach((block) => {
    if (block.localName === 'br') block.replaceWith(BREAK); else block.append(BREAK);
  });
  const lines = fragment.textContent
    .replace(/\s*[•◦▪●]\s*/g, BREAK) // a bullet typed into the text marks a new line too
    .split(BREAK)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return lines.map((line, i) => (i < lines.length - 1 && !ENDS_ITSELF.test(line) ? `${line}.` : line)).join(' ');
}

// In order of what can read what: a Japanese or Cantonese voice can get through an English
// word in the middle of its sentence, but an English voice cannot read Han characters.
export function selectionLanguage(range, text) {
  const ancestor = range.commonAncestorContainer;
  const element = ancestor.nodeType === 1 ? ancestor : ancestor.parentElement;
  const own = element?.closest?.('ruby');
  const rubies = own ? [own] : [...(element?.querySelectorAll?.('ruby[lang]') || [])].filter((ruby) => range.intersectsNode(ruby));
  const langs = new Set(rubies.map((ruby) => ruby.getAttribute('lang')));
  if (langs.has('ja')) return 'ja';
  if (langs.has('yue')) return 'yue';
  const words = String(text || '');
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(words)) return detectHanScript(words);
  return /\p{Script=Latin}/u.test(words) ? 'en' : null;
}

export function voiceProvider(voice) {
  const name = String(voice?.name || '');
  if (/google/i.test(name)) return 'Google';
  if (/microsoft/i.test(name)) return 'Microsoft';
  return null;
}

/**
 * The browser's voice list, read once it has had time to fill. Started before the first
 * click, so the wait is normally over by then.
 */
export function createVoiceSource(synth, { settleMs = VOICES_SETTLE_MS, now = Date.now } = {}) {
  let primedAt = 0;
  const prime = () => {
    if (primedAt) return;
    primedAt = now();
    synth.getVoices();
  };
  const pick = (lang, preferred) => pickVoice(synth.getVoices(), lang, preferred);
  // An on-device voice cannot be beaten by anything that arrives later. A chosen voice is
  // different: it may come from an add-on that lists itself late, so it is worth the wait.
  const settled = (voice, preferred) => (preferred ? voice?.name === preferred : !!voice?.localService);

  return {
    prime,
    /**
     * @param {'en'|'ja'|'yue'} lang
     * @param {string|null} [preferred] the name of the voice chosen in Settings
     * @returns {Promise<SpeechSynthesisVoice|null>}
     */
    async voiceFor(lang, preferred = null) {
      prime();
      const found = pick(lang, preferred);
      if (settled(found, preferred)) return found;
      const left = settleMs - (now() - primedAt);
      if (left <= 0) return found;
      await new Promise((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          synth.removeEventListener?.('voiceschanged', onChange);
          resolve();
        };
        const onChange = () => { if (settled(pick(lang, preferred), preferred)) finish(); };
        const timer = setTimeout(finish, left);
        synth.addEventListener?.('voiceschanged', onChange);
      });
      return pick(lang, preferred);
    },
  };
}
