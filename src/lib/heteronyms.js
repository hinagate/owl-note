// Words spelled alike but said differently as a verb and as a noun or adjective.
//
// The baked dictionary keeps one reading per spelling — the first CMUdict lists — and for
// several common words that was the rarer one: read showed rɛd (past tense) even in "read
// this", use showed the noun's juːs in "we use", which teaches exactly the Cantonese habit
// of saying a final z as s. Here the words around each one decide instead. Simple rules, no
// grammar: the word before it (looking past adverbs), the word after it, and whether it
// opens a sentence.
//
// Pure: no DOM. Readings are written exactly as scripts/build-ipa-dict.mjs bakes them.

import { normalizeWord } from './phonetics.js';

/**
 * verb / other: the two readings ("other" is the noun or adjective). fallback: the sense to
 * use when nothing around the word decides. Optional: past (a third reading), verbBefore /
 * otherBefore (next words that settle it), otherAfter (extra previous words meaning
 * "other"), noImperative (opening a sentence does not make it a verb: "Live video", "Wind
 * speeds").
 */
export const HETERONYMS = {
  use: { verb: 'juːz', other: 'juːs', fallback: 'verb', otherAfter: ['make', 'makes', 'made', 'making'] },
  uses: { verb: 'ˈjuː.zɪz', other: 'ˈjuː.sɪz', fallback: 'verb' },
  excuse: { verb: 'ɪkˈskjuːz', other: 'ɪkˈskjuːs', fallback: 'verb' },
  abuse: { verb: 'əˈbjuːz', other: 'əˈbjuːs', fallback: 'other' },
  close: { verb: 'kloʊz', other: 'kloʊs', fallback: 'other', otherBefore: ['to', 'by'] },
  // live stays the adjective (laɪv) unless something says verb: "Second, live video" has
  // no subject before it and a noun after it.
  live: {
    verb: 'lɪv', other: 'laɪv', fallback: 'other', noImperative: true,
    verbBefore: ['in', 'at', 'on', 'with', 'here', 'there', 'together', 'alone', 'near', 'nearby',
      'by', 'abroad', 'without', 'for', 'forever', 'longer', 'like', 'off', 'through', 'inside',
      'outside', 'happily', 'well'],
  },
  lives: { verb: 'lɪvz', other: 'laɪvz', fallback: 'verb' },
  read: { verb: 'riːd', other: 'riːd', past: 'rɛd', fallback: 'verb' },
  wind: {
    verb: 'waɪnd', other: 'wɪnd', fallback: 'other', noImperative: true,
    verbBefore: ['up', 'down', 'back', 'around'],
  },
};

// The word before that says verb: a subject, a modal, "to".
const VERB_CUES = new Set([
  'to', 'i', 'we', 'you', 'they', 'he', 'she', 'it', 'who', 'people', 'can', 'could', 'will',
  'would', 'shall', 'should', 'may', 'might', 'must', 'do', 'does', 'did', "don't", "doesn't",
  "didn't", "won't", "can't", 'cannot', "couldn't", "wouldn't", "shouldn't", "mustn't",
  "let's", 'please', "i'll", "we'll", "you'll", "they'll", "i'd", "we'd", "you'd", "they'd",
]);
// The word before that says noun or adjective: a determiner or a preposition.
const OTHER_CUES = new Set([
  'a', 'an', 'the', 'my', 'your', 'his', 'its', 'our', 'their', 'this', 'these', 'those', 'no',
  'any', 'some', 'every', 'each', 'of', 'in', 'for', 'on', 'with', 'without', 'such', 'very',
  'so', 'too', 'more', 'most',
]);
// The word before that makes read a past participle: "have read", "was read".
const PAST_CUES = new Set(['have', 'has', 'had', 'having', 'been', 'was', 'were', 'is', 'are', 'be', 'being']);
// Looked past when finding the word before: "We also use", "I don't always read".
const SKIPPED = new Set([
  'also', 'always', 'never', 'just', 'only', 'often', 'usually', 'sometimes', 'still', 'really',
  'even', 'already', 'ever', 'all', 'both', 'actually', 'mostly', 'rarely', 'seldom', 'generally',
  'normally', 'typically', 'probably', 'definitely', 'certainly', 'not', 'then',
]);

/** Whether the word is looked past when finding the word before a heteronym. */
export function isSkipped(word) {
  return SKIPPED.has(normalizeWord(word));
}

/** Whether the word is a heteronym this module decides. */
export function isHeteronym(word) {
  return Object.hasOwn(HETERONYMS, normalizeWord(word));
}

function senseOf(entry, prev, next, sentenceStart) {
  if (next && entry.verbBefore?.includes(next)) return 'verb';
  if (next && entry.otherBefore?.includes(next)) return 'other';
  if (prev) {
    if (entry.past && (PAST_CUES.has(prev) || prev.endsWith("'ve"))) return 'past';
    if (OTHER_CUES.has(prev) || entry.otherAfter?.includes(prev)) return 'other';
    if (VERB_CUES.has(prev)) return 'verb';
  }
  // A sentence that opens with the word is an instruction: "Use this", "Close the door".
  if (sentenceStart && !entry.noImperative) return 'verb';
  return entry.fallback;
}

/**
 * @param {string} word the heteronym as written
 * @param {{ prev?: string|null, next?: string|null, sentenceStart?: boolean }} context
 *   prev: the word before it, adverbs already looked past (null when a pause or anything
 *   unreadable came first); next: the word after it; sentenceStart: nothing but the start
 *   of a sentence before it.
 * @returns {string|null} its reading here, or null when it is not a heteronym
 */
export function heteronymReading(word, { prev = null, next = null, sentenceStart = false } = {}) {
  const entry = HETERONYMS[normalizeWord(word)];
  if (!entry) return null;
  const key = (w) => (w ? normalizeWord(w) : null);
  return entry[senseOf(entry, key(prev), key(next), sentenceStart)];
}
