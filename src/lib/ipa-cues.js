// Pronunciation cues for an English IPA reading: which vowel to stretch, and which
// word-final consonants must actually be said.
//
// Written for readers whose first language is Cantonese, where both habits are missing:
//   - LENGTH. Cantonese never lengthens a vowel for effect, so speed and speech, or bad
//     and bat, come out the same length. In English that length carries meaning: a vowel
//     before a voiced final consonant is held longer, and a listener tells bad from bat
//     mostly by that, since the final d itself is barely voiced.
//   - FINAL CONSONANTS. A Cantonese syllable can only end in p, t, k, m, n or ŋ, one at
//     a time. Any other final (l, s, z, d, v, r…) or any cluster (-kt, -nd, -ts) tends to
//     be dropped, so feel becomes "fee-oo" and asked becomes "ask".
//
// Pure: no DOM, no imports. The output is a list of parts whose text concatenates back to
// the reading exactly, so the annotator can wrap the cued parts in spans without changing
// what the reading says.

// Longest symbols first: ɑː must win over ɑ, and tʃ over t.
const VOWELS_2 = ['iː', 'uː', 'ɑː', 'ɔː', 'ɝː', 'eɪ', 'aɪ', 'aʊ', 'oʊ', 'ɔɪ'];
const CONSONANTS_2 = ['tʃ', 'dʒ'];
const VOWELS_1 = new Set([...'iɪeɛæaɑɔoʊuʌəɚɝ']);
const CONSONANTS_1 = new Set([...'bdfɡghklmnŋprɹsʃtθðvwjzʒ']);
const MARKS = new Set(['ˈ', 'ˌ', '.']);

// Reduced vowels are relaxed by definition — asking for length or effort on them is
// exactly the wrong advice.
const REDUCED = new Set(['ə', 'ɚ']);
// Consonants that do not stop the vowel before them from lengthening.
const SONORANTS = new Set(['l', 'm', 'n', 'ŋ', 'r', 'ɹ', 'w', 'j']);
const VOICED_OBSTRUENTS = new Set(['b', 'd', 'ɡ', 'g', 'v', 'ð', 'z', 'ʒ', 'dʒ']);
// Every final a Cantonese syllable allows. Anything else, or two of these in a row, is new.
const CANTONESE_FINALS = new Set(['p', 't', 'k', 'm', 'n', 'ŋ']);

// Function words a sentence almost never stresses — most have a weak form (to → tə,
// and → ən). Cueing them would put marks on every other word and teach the citation form
// of words that are spoken reduced.
const UNSTRESSED_WORDS = new Set([
  'a', 'an', 'the', 'and', 'but', 'or', 'nor', 'as', 'at', 'by', 'for', 'from', 'in',
  'into', 'of', 'on', 'onto', 'to', 'than', 'that', 'with', 'is', 'am', 'are', 'was',
  'were', 'be', 'been', 'being', 'has', 'have', 'had', 'do', 'does', 'did', 'can',
  'could', 'will', 'would', 'shall', 'should', 'may', 'might', 'must', 'just', 'some',
  'i', 'me', 'my', 'you', 'your', 'he', 'him', 'his', 'she', 'her', 'it', 'its', 'we',
  'us', 'our', 'they', 'them', 'their', 'there', 'who', 'whom',
]);

/**
 * Split an IPA reading into symbols.
 * @returns {{ text: string, kind: 'vowel'|'consonant'|'mark' }[] | null} null when the
 *   reading holds a symbol this module does not know — better no cues than wrong ones.
 */
export function splitIpa(ipa) {
  const source = String(ipa || '');
  const out = [];
  let at = 0;
  while (at < source.length) {
    const two = source.slice(at, at + 2);
    const one = source[at];
    if (VOWELS_2.includes(two)) { out.push({ text: two, kind: 'vowel' }); at += 2; continue; }
    if (CONSONANTS_2.includes(two)) { out.push({ text: two, kind: 'consonant' }); at += 2; continue; }
    if (VOWELS_1.has(one)) { out.push({ text: one, kind: 'vowel' }); at += 1; continue; }
    if (CONSONANTS_1.has(one)) { out.push({ text: one, kind: 'consonant' }); at += 1; continue; }
    if (MARKS.has(one)) { out.push({ text: one, kind: 'mark' }); at += 1; continue; }
    return null;
  }
  return out;
}

/** Normalise a word for the function-word check: curly apostrophes, any case. */
const wordKey = (word) => String(word || '').replace(/[’‘＇]/g, "'").toLowerCase();

/**
 * @param {string} ipa reading as baked by scripts/build-ipa-dict.mjs, e.g. "spiːd"
 * @param {string} [word] the written word, used only to skip unstressed function words
 * @returns {{ text: string, cue: 'long'|'longer'|'final'|null }[] | null} parts that
 *   rebuild `ipa` exactly, or null when nothing in the word needs a cue.
 *   - long:   hold this vowel — a long vowel (ː), or any stressed vowel before a voiced
 *             final consonant (bad, ride)
 *   - longer: both at once, so hold it longer still (speed, cards)
 *   - final:  a word-final consonant Cantonese has no habit of saying
 */
export function pronunciationCues(ipa, word = '') {
  if (UNSTRESSED_WORDS.has(wordKey(word))) return null;
  const symbols = splitIpa(ipa);
  if (!symbols || !symbols.length) return null;

  const cues = new Array(symbols.length).fill(null);
  const vowelCount = symbols.filter((s) => s.kind === 'vowel').length;
  if (!vowelCount) return null;

  // Stress belongs to the syllable a mark opens, and only its first vowel is the nucleus.
  // A one-vowel word carries no mark (convention: /rɛd/, not /ˈrɛd/) but is stressed.
  let stressed = false;
  let nucleusTaken = false;
  for (let i = 0; i < symbols.length; i += 1) {
    const { text, kind } = symbols[i];
    if (kind === 'mark') {
      stressed = text !== '.';
      nucleusTaken = false;
      continue;
    }
    if (kind !== 'vowel') continue;
    const isNucleus = vowelCount === 1 || (stressed && !nucleusTaken);
    nucleusTaken = true;
    if (!isNucleus || REDUCED.has(text)) continue;

    // The coda runs to the next syllable mark or vowel. The FIRST obstruent in it decides:
    // cards /kɑːrdz/ lengthens (r lets it through, d is voiced), cart /kɑːrt/ does not.
    let voicedCoda = false;
    for (let j = i + 1; j < symbols.length && symbols[j].kind === 'consonant'; j += 1) {
      if (SONORANTS.has(symbols[j].text)) continue;
      voicedCoda = VOICED_OBSTRUENTS.has(symbols[j].text);
      break;
    }
    const level = (text.endsWith('ː') ? 1 : 0) + (voicedCoda ? 1 : 0);
    if (level) cues[i] = level === 2 ? 'longer' : 'long';
  }

  // Word-final consonants: everything after the last vowel.
  let last = symbols.length;
  while (last > 0 && symbols[last - 1].kind === 'consonant') last -= 1;
  const finals = symbols.slice(last);
  if (finals.length >= 2 || finals.some((s) => !CANTONESE_FINALS.has(s.text))) {
    for (let i = last; i < symbols.length; i += 1) cues[i] = 'final';
  }

  if (!cues.some(Boolean)) return null;

  // Merge neighbours with the same cue, so "dz" in cards is one span and the plain
  // stretches stay plain text.
  const parts = [];
  symbols.forEach((symbol, i) => {
    const prev = parts[parts.length - 1];
    if (prev && prev.cue === cues[i]) prev.text += symbol.text;
    else parts.push({ text: symbol.text, cue: cues[i] });
  });
  return parts;
}
