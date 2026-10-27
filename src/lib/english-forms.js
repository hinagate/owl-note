// Readings for English words the dictionary does not list, built from ones it does.
//
// CMUdict is strong on everyday words and thin on the -ing/-ed/-s forms of newer verbs:
// it has architect but not architecting or architected. Rather than leave those bare, a
// missed word that ends in an inflection is read as its base word plus the ending as
// English actually says it — and the ending is exactly what a Cantonese reader tends to
// drop, so it carries the orange "say this" cue like any other final.
//
// Pure: no DOM. Works on the baked IPA, so it never needs the ARPAbet source.

import { lookup, normalizeWord } from './phonetics.js';
import { splitIpa, UNSTRESSED_WORDS } from './ipa-cues.js';

// -ed is /t/ after these, -s is /s/ (once the sibilants are taken out: see SIBILANTS).
const VOICELESS = new Set(['p', 't', 'k', 'f', 'θ', 's', 'ʃ', 'tʃ']);
// -s after a hissing sound needs a vowel of its own: boxes, caches.
const SIBILANTS = new Set(['s', 'z', 'ʃ', 'ʒ', 'tʃ', 'dʒ']);
// A base shorter than this matches too much by accident (us + ed, as + ing).
const MIN_BASE = 3;

/**
 * Spellings the word may be an inflection of, most likely first. Each candidate is the
 * base word and the ending it would take.
 * @returns {[string, 'ing'|'ed'|'s'][]}
 */
export function inflectionBases(word) {
  const w = normalizeWord(word);
  const out = [];
  // running → run, stopped → stop
  const undoubled = (stem) => (/([b-df-hj-np-tv-z])\1$/.test(stem) ? [stem.slice(0, -1)] : []);
  if (w.endsWith('ing')) {
    const stem = w.slice(0, -3);
    // caching → cache first, then architecting → architect, then running → run. Measured
    // on the ~4,500 -ing words the dictionary does list, rebuilt from their bases: this
    // order matches 89%, bare-stem-first 87% (it reads aching as ach).
    for (const base of [`${stem}e`, stem, ...undoubled(stem)]) out.push([base, 'ing']);
  }
  if (w.endsWith('ed')) {
    const stem = w.slice(0, -2);
    // cached → cache before cach, so used → use and never us; then architected →
    // architect, stopped → stop, studied → study
    for (const base of [w.slice(0, -1), stem, ...undoubled(stem)]) out.push([base, 'ed']);
    if (stem.endsWith('i')) out.push([`${stem.slice(0, -1)}y`, 'ed']);
  }
  if (w.endsWith('s') && !w.endsWith('ss')) {
    // studies → study, caches → cache, then boxes → box
    if (w.endsWith('ies')) out.push([`${w.slice(0, -3)}y`, 's']);
    out.push([w.slice(0, -1), 's']);
    if (w.endsWith('es')) out.push([w.slice(0, -2), 's']);
  }
  return out.filter(([base]) => base.length >= MIN_BASE && !UNSTRESSED_WORDS.has(base));
}

/**
 * The base reading with an ending added. A vowel-initial ending (ɪŋ, ɪd, ɪz) starts a
 * syllable of its own and takes the base's last consonant as its onset — architect +
 * ing is ˌtɛk.tɪŋ, the way the dictionary splits every other word — and a word that was
 * one syllable gains the stress mark it now needs (cache → ˈkæ.ʃɪŋ).
 * @returns {string|null}
 */
export function addEnding(baseIpa, ending) {
  const symbols = splitIpa(baseIpa);
  if (!symbols || !symbols.length) return null;
  const last = symbols[symbols.length - 1];
  let sound;
  if (ending === 'ing') sound = 'ɪŋ';
  else if (ending === 'ed') sound = last.text === 't' || last.text === 'd' ? 'ɪd' : VOICELESS.has(last.text) ? 't' : 'd';
  else sound = SIBILANTS.has(last.text) ? 'ɪz' : VOICELESS.has(last.text) ? 's' : 'z';

  if (!sound.startsWith('ɪ')) return baseIpa + sound;
  const head = last.kind === 'consonant' ? baseIpa.slice(0, -last.text.length) : baseIpa;
  const onset = last.kind === 'consonant' ? last.text : '';
  const marked = /[ˈˌ]/.test(head) ? head : `ˈ${head}`;
  return `${marked}.${onset}${sound}`;
}

/**
 * @param {Map<string, string>} table the baked English table
 * @returns {string|null} the dictionary's reading, else one built from an inflection's
 *   base word, else null.
 */
export function readEnglish(table, word) {
  const exact = lookup(table, word);
  if (exact || !table) return exact;
  for (const [base, ending] of inflectionBases(word)) {
    const baseIpa = table.get(base);
    if (baseIpa && !spelledOut(baseIpa)) return addEnding(baseIpa, ending);
  }
  return null;
}

// The dictionary reads some abbreviations letter by letter — ach is A-C-H, /ˈeɪˈsiːˈeɪtʃ/
// — which no word is built on. Every letter carries a main stress; a real word has one.
const spelledOut = (ipa) => (ipa.match(/ˈ/g) || []).length > 1;

// The reading a hyphenated prefix takes when a compound is read part by part. CMUdict
// gives "re" as the musical note /reɪ/; as in re-enter, it is /riː/.
export const PREFIX_READINGS = { re: 'riː' };
