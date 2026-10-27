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
//   - STRESS. Cantonese gives every syllable the same weight, so a long word's stress is
//     easy to misplace. Rather than a third mark, the stressed syllable is shown darker.
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
export const UNSTRESSED_WORDS = new Set([
  'a', 'an', 'the', 'and', 'but', 'or', 'nor', 'as', 'at', 'by', 'for', 'from', 'in',
  'into', 'of', 'on', 'onto', 'to', 'than', 'that', 'with', 'is', 'am', 'are', 'was',
  'were', 'be', 'been', 'being', 'has', 'have', 'had', 'do', 'does', 'did', 'can',
  'could', 'will', 'would', 'shall', 'should', 'may', 'might', 'must', 'just', 'some',
  'i', 'me', 'my', 'you', 'your', 'he', 'him', 'his', 'she', 'her', 'it', 'its', 'we',
  'us', 'our', 'they', 'them', 'their', 'there', 'who', 'whom',
]);

// What the reading SHOWS for those words. The dictionary gives each one's citation form —
// to /tuː/, was /wɑːz/, her /hɝː/ — whose length marks tell a reader to hold exactly the
// words a sentence rushes through, and a Cantonese speaker already weighs every syllable
// the same. So the build bakes in the form actually spoken (scripts/build-ipa-dict.mjs):
//   - the usual weak form, where running speech reduces the vowel (to → tə, for → fɚ);
//   - just the length mark dropped, for words with no schwa form (be, he, do, who);
//   - left alone where a common use is strong — have/has/had as main verbs, does, that,
//     there — none of which carries a length mark anyway.
export const WEAK_FORMS = {
  an: 'ən', but: 'bət', or: 'ɚ', nor: 'nɚ', as: 'əz', at: 'ət', for: 'fɚ', from: 'frəm',
  of: 'əv', to: 'tə', than: 'ðən', am: 'əm', are: 'ɚ', was: 'wəz', were: 'wɚ',
  can: 'kən', could: 'kəd', would: 'wəd', should: 'ʃəd', shall: 'ʃəl', must: 'məst',
  just: 'dʒəst', some: 'səm', you: 'jə', your: 'jɚ', her: 'hɚ', us: 'əs', them: 'ðəm',
  be: 'bi', he: 'hi', she: 'ʃi', we: 'wi', me: 'mi', do: 'du', who: 'hu', whom: 'hum',
  on: 'ɑn',
};

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
 * @returns {{ text: string, cue: 'long'|'longer'|'final'|null, stressed: boolean }[] | null}
 *   parts that rebuild `ipa` exactly, or null when there is nothing to show: a function
 *   word, a reading this module cannot parse, or one with neither a cue nor a stress.
 *   - long:   hold this vowel — a long vowel (ː), or any stressed vowel before a voiced
 *             final consonant (bad, ride)
 *   - longer: both at once, so hold it longer still (speed, cards)
 *   - final:  a word-final consonant Cantonese has no habit of saying
 *   - stressed: inside the syllable that carries the word's main stress (ˈ), or the whole
 *             of a one-syllable word. The page shows it darker than the rest of the
 *             reading, which is all it takes to see where the weight falls in distracted
 *             /dɪˈstræk.təd/. Secondary stress (ˌ) stays light, so the main one stands out.
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

  // The main stress runs from its ˈ mark to the next syllable mark. A word without one is
  // stressed whole only when it has a single vowel (a one-syllable word carries no mark).
  const hasPrimary = symbols.some((s) => s.text === 'ˈ');
  const stress = new Array(symbols.length).fill(!hasPrimary && vowelCount === 1);
  if (hasPrimary) {
    let inPrimary = false;
    symbols.forEach(({ text, kind }, i) => {
      if (kind === 'mark') inPrimary = text === 'ˈ';
      stress[i] = inPrimary;
    });
  }

  if (!cues.some(Boolean) && !stress.some(Boolean)) return null;

  // Merge neighbours alike in cue and stress, so "dz" in cards is one span and the plain
  // stretches stay plain text.
  const parts = [];
  symbols.forEach((symbol, i) => {
    const prev = parts[parts.length - 1];
    if (prev && prev.cue === cues[i] && prev.stressed === stress[i]) prev.text += symbol.text;
    else parts.push({ text: symbol.text, cue: cues[i], stressed: stress[i] });
  });
  return parts;
}
