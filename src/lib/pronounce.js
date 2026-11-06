// Choosing how to read a selected word aloud, for Phonetic Assistance. The bar the reader
// clicks is app/pronounce-bar.js; this file holds the decisions, so they can be tested
// without a browser's voices.

import { detectHanScript } from './segment.js';

// A word or a phrase. Past this it stops being pronunciation practice, and an online voice
// would be sending a passage of the note rather than a few words.
export const MAX_SPOKEN_CHARS = 200;

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

/**
 * The best voice for a reading's language: one on this computer before any online one, the
 * exact regional voice before a relative, and the browser's default among equals.
 * @param {SpeechSynthesisVoice[]} voices
 * @param {'en'|'ja'|'yue'} lang
 * @returns {SpeechSynthesisVoice|null}
 */
export function pickVoice(voices, lang) {
  const wanted = VOICE_TAGS[lang];
  if (!wanted) return null;
  const matches = (voices || []).filter((voice) => {
    const tag = tagOf(voice);
    return wanted.family.some((name) => tag === name || tag.startsWith(`${name}-`));
  });
  const score = (voice) => (voice.localService ? 4 : 0) + (tagOf(voice) === wanted.exact ? 2 : 0) + (voice.default ? 1 : 0);
  // Stable: among equals, the browser's own order stands.
  return matches.reduce((best, voice) => (!best || score(voice) > score(best) ? voice : best), null);
}

// Measured against the same phrases: at 0.6 an online voice took about 60% longer, but a
// Windows voice only 4-24%, and at 0.5 still only 15-38%. So on-device voices get the lower
// setting, and neither goes lower, where words start to come apart.
export function rateFor(voice, slow) {
  if (!slow) return 1;
  return voice?.localService ? 0.5 : 0.6;
}

// The words alone. Readings sit in the same DOM as the words they annotate.
export function spokenText(range) {
  const fragment = range.cloneContents();
  fragment.querySelectorAll('rt, rp').forEach((node) => node.remove());
  return fragment.textContent.replace(/\s+/g, ' ').trim();
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
  const pick = (lang) => pickVoice(synth.getVoices(), lang);

  return {
    prime,
    /** @returns {Promise<SpeechSynthesisVoice|null>} */
    async voiceFor(lang) {
      prime();
      const found = pick(lang);
      if (found?.localService) return found; // nothing that arrives later can beat this
      const left = settleMs - (now() - primedAt);
      if (left <= 0) return found;
      await new Promise((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          synth.removeEventListener?.('voiceschanged', onChange);
          resolve();
        };
        const onChange = () => { if (pick(lang)?.localService) finish(); };
        const timer = setTimeout(finish, left);
        synth.addEventListener?.('voiceschanged', onChange);
      });
      return pick(lang);
    },
  };
}
