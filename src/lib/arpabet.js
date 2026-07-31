// ARPAbet -> IPA. CMUdict stores General American pronunciations as ARPAbet with a
// stress digit on every vowel ("F AA1 N IH0 K S"); readers expect IPA ("ˈfɑnɪks").
// Pure module — no imports, no DOM. Runs at BUILD time to bake the runtime dictionary,
// so nothing here ships in the extension bundle.
//
// Transcription style is American learner-dictionary, not narrow phonetic:
//   - no length marks (u, i — not uː, iː), matching how US dictionaries write them
//   - r, not ɹ: every major learner dictionary uses r for English, and this is read
//     by people learning the language, not by phoneticians
//   - AH and ER split on stress, which is the one place ARPAbet is lossier than IPA:
//     unstressed AH0/ER0 are the reduced ə/ɚ, stressed AH1/ER1 are ʌ/ɝ

const VOWELS = {
  AA: 'ɑ', AE: 'æ', AH: 'ʌ', AO: 'ɔ', AW: 'aʊ', AY: 'aɪ',
  EH: 'ɛ', ER: 'ɝ', EY: 'eɪ', IH: 'ɪ', IY: 'i',
  OW: 'oʊ', OY: 'ɔɪ', UH: 'ʊ', UW: 'u',
};

// Same vowel, reduced: only reachable with stress digit 0.
const REDUCED = { AH: 'ə', ER: 'ɚ' };

const CONSONANTS = {
  B: 'b', CH: 'tʃ', D: 'd', DH: 'ð', F: 'f', G: 'ɡ', HH: 'h', JH: 'dʒ',
  K: 'k', L: 'l', M: 'm', N: 'n', NG: 'ŋ', P: 'p', R: 'r', S: 's',
  SH: 'ʃ', T: 't', TH: 'θ', V: 'v', W: 'w', Y: 'j', Z: 'z', ZH: 'ʒ',
};

const MARK = { 1: 'ˈ', 2: 'ˌ' };

// Consonant clusters English allows at the START of a syllable. Needed because IPA
// marks a syllable, not a vowel, so the mark goes before the onset — and the onset is
// only the consonants that could legally begin a syllable. Without this, "instead"
// swallows the whole run and becomes ˌɪˈnstɛd instead of ˌɪnˈstɛd, since "nst" can
// begin no English word.
const ONSETS = new Set([
  'pl', 'pr', 'pj', 'bl', 'br', 'bj', 'tr', 'tw', 'tj', 'dr', 'dw', 'dj',
  'kl', 'kr', 'kw', 'kj', 'ɡl', 'ɡr', 'ɡw', 'fl', 'fr', 'fj', 'θr', 'θw',
  'ʃr', 'sp', 'st', 'sk', 'sm', 'sn', 'sl', 'sw', 'sf', 'hj', 'mj', 'vj',
  'nj', 'lj',
  'spl', 'spr', 'spj', 'str', 'stj', 'skr', 'skw', 'skj', 'sfr',
]);

// Counted in PHONEMES, not characters: the affricates tʃ and dʒ are single consonants
// spelled with two code points, and measuring the string would reject them as clusters.
// ŋ never begins a syllable; every other single consonant can.
const canOpen = (cluster, phonemes) => (
  phonemes === 1 ? cluster !== 'ŋ' : ONSETS.has(cluster)
);

/**
 * @param {string} arpabet e.g. "F AA1 N IH0 K S"
 * @returns {string} IPA without slashes, e.g. "ˈfɑnɪks"
 */
export function arpabetToIpa(arpabet) {
  const symbols = String(arpabet || '').trim().toUpperCase().split(/\s+/).filter(Boolean);
  if (!symbols.length) return '';

  const units = [];
  for (const symbol of symbols) {
    const stress = /[012]$/.test(symbol) ? symbol.slice(-1) : '';
    const base = stress ? symbol.slice(0, -1) : symbol;
    if (base in VOWELS) {
      units.push({
        ipa: (stress === '0' && REDUCED[base]) || VOWELS[base],
        vowel: true,
        stress,
      });
    } else if (base in CONSONANTS) {
      units.push({ ipa: CONSONANTS[base], vowel: false, stress: '' });
    }
    // Anything else is not an ARPAbet symbol; dropping it beats emitting garbage.
  }
  if (!units.length) return '';

  // A one-syllable word carries no stress mark by convention: /rɛd/, not /ˈrɛd/.
  const syllables = units.filter((u) => u.vowel).length;
  const marks = new Map(); // insert-before index -> mark
  if (syllables > 1) {
    for (let i = 0; i < units.length; i += 1) {
      const mark = units[i].vowel ? MARK[units[i].stress] : undefined;
      if (!mark) continue;
      // Maximal onset: take as many preceding consonants as could legally begin a
      // syllable, and no more. Everything left of that belongs to the previous
      // syllable's coda — ˌʌndɚˈstænd, not ˌʌndɚstˈænd and not ˌʌndɚˈrstænd.
      let at = i;
      while (at > 0 && !units[at - 1].vowel) {
        const onset = units.slice(at - 1, i);
        if (!canOpen(onset.map((u) => u.ipa).join(''), onset.length)) break;
        at -= 1;
      }
      marks.set(at, mark);
    }
  }

  let out = '';
  for (let i = 0; i < units.length; i += 1) {
    if (marks.has(i)) out += marks.get(i);
    out += units[i].ipa;
  }
  return out;
}
