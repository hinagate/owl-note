// "Was I understood?" for speaking practice: what the browser's on-device recogniser wrote
// down, compared word by word with what was meant. Pure, so it can be tested with no
// microphone: the recording and the recognition are in lib/voice-take.js.
//
// A recogniser guesses the word a speaker MEANT. So this cannot say a sound was off, only
// that a word came out as another word or did not come out at all.

const SMALL = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven',
  'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

// A recogniser writes "3" where a note says "three", or the other way round.
function numberWords(n) {
  if (n < 20) return [SMALL[n]];
  if (n < 100) return n % 10 ? [TENS[Math.floor(n / 10)], SMALL[n % 10]] : [TENS[n / 10]];
  return null;
}

const key = (word) => word.toLowerCase().replace(/[’‘＇]/g, "'").replace(/^'+|'+$/g, '');

/**
 * The words of a text, each as it is written and as it is compared.
 * @returns {{ text: string, key: string, at: number }[]} `at` is the word's place on the
 *   page; a number written in digits can be two spoken words with one place
 */
export function spokenWords(text) {
  const words = [];
  let at = 0;
  for (const [match] of String(text || '').matchAll(/[\p{L}\p{N}]+(?:['’‘][\p{L}]+)*/gu)) {
    const digits = /^\d{1,2}$/.test(match) ? numberWords(Number(match)) : null;
    const keys = digits || [key(match)];
    for (const word of keys) if (word) words.push({ text: match, key: word, at });
    at += 1;
  }
  return words;
}

/**
 * @param {string} target what was meant
 * @param {string} heard what the recogniser wrote
 * @param {{ same?: (a: string, b: string) => boolean }} [options] `same` says whether two
 *   different spellings are one spoken word (their / there), which only a pronouncing
 *   dictionary knows
 * @returns {{ words: { text: string, status: 'heard'|'different'|'missed', as?: string }[],
 *   extra: string[], heard: number, total: number }} one entry per word of the target, in
 *   order; `as` is the word heard in its place; `extra` are words heard that were not meant
 */
export function compareWords(target, heard, { same = () => false } = {}) {
  const want = spokenWords(target);
  const got = spokenWords(heard);
  const equal = (a, b) => a.key === b.key || same(a.key, b.key);
  // One word written as two, or two as one. Whether a name or a compound is spaced is the
  // recogniser's choice of spelling, not something the speaker said: "Downdetector" comes
  // back as "down detector", "workarounds" as "work arounds".
  const spelt = (first, second, whole) => first.key + second.key === whole.key;
  const twoHeard = (i, j) => j > 1 && spelt(got[j - 2], got[j - 1], want[i - 1]);
  const twoMeant = (i, j) => i > 1 && spelt(want[i - 2], want[i - 1], got[j - 1]);
  // The cheapest way to turn what was heard into what was meant: a word kept costs
  // nothing; a word changed, dropped or added costs one.
  const rows = want.length + 1;
  const cols = got.length + 1;
  const cost = Array.from({ length: rows }, () => new Uint16Array(cols));
  for (let i = 0; i < rows; i += 1) cost[i][0] = i;
  for (let j = 0; j < cols; j += 1) cost[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      let least = Math.min(
        cost[i - 1][j - 1] + (equal(want[i - 1], got[j - 1]) ? 0 : 1),
        cost[i - 1][j] + 1,
        cost[i][j - 1] + 1,
      );
      if (twoHeard(i, j)) least = Math.min(least, cost[i - 1][j - 2]);
      if (twoMeant(i, j)) least = Math.min(least, cost[i - 2][j - 1]);
      cost[i][j] = least;
    }
  }
  const words = [];
  const extra = [];
  let i = want.length;
  let j = got.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && equal(want[i - 1], got[j - 1]) && cost[i][j] === cost[i - 1][j - 1]) {
      words.unshift({ text: want[i - 1].text, at: want[i - 1].at, status: 'heard' });
      i -= 1; j -= 1;
    } else if (i > 0 && j > 0 && twoHeard(i, j) && cost[i][j] === cost[i - 1][j - 2]) {
      words.unshift({ text: want[i - 1].text, at: want[i - 1].at, status: 'heard' });
      i -= 1; j -= 2;
    } else if (i > 0 && j > 0 && twoMeant(i, j) && cost[i][j] === cost[i - 2][j - 1]) {
      words.unshift(
        { text: want[i - 2].text, at: want[i - 2].at, status: 'heard' },
        { text: want[i - 1].text, at: want[i - 1].at, status: 'heard' },
      );
      i -= 2; j -= 1;
    } else if (i > 0 && j > 0 && cost[i][j] === cost[i - 1][j - 1] + 1) {
      words.unshift({ text: want[i - 1].text, at: want[i - 1].at, status: 'different', as: got[j - 1].text });
      i -= 1; j -= 1;
    } else if (i > 0 && cost[i][j] === cost[i - 1][j] + 1) {
      words.unshift({ text: want[i - 1].text, at: want[i - 1].at, status: 'missed' });
      i -= 1;
    } else {
      extra.unshift(got[j - 1].text);
      j -= 1;
    }
  }
  // Back to one entry per word on the page: "21" is heard only if both its words were.
  const merged = [];
  for (const { at, ...word } of words) {
    const last = merged[merged.length - 1];
    if (last && last.at === at) {
      if (word.status !== 'heard' && last.status === 'heard') Object.assign(last, word);
    } else merged.push({ ...word, at });
  }
  const result = merged.map(({ at, ...word }) => word);
  return { words: result, extra, heard: result.filter((word) => word.status === 'heard').length, total: result.length };
}

// Japanese has no spaces to split on, and a recogniser is free to choose other characters
// for the same sounds, so it is compared by how it is read: kana against kana.
const toHiragana = (text) => String(text || '').replace(/[\u30a1-\u30f6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
const kanaOnly = (text) => toHiragana(text).replace(/[^\u3041-\u3096\u30fc]/g, '');

/**
 * @param {{ text: string, reading?: string|null }[]} target the words meant, as the
 *   annotator cut them, each with its reading (kana words read as themselves)
 * @param {string} heard what the recogniser wrote, already turned into kana
 * @returns the same shape as compareWords; a word is `different` when only part of its
 *   reading was heard
 */
export function compareReadings(target, heard) {
  const runs = target
    .map((run) => ({ text: run.text, kana: kanaOnly(run.reading || run.text) }))
    .filter((run) => run.kana);
  const want = runs.flatMap((run, at) => [...run.kana].map((char) => ({ char, at })));
  const got = [...kanaOnly(heard)];
  const rows = want.length + 1;
  const cols = got.length + 1;
  const cost = Array.from({ length: rows }, () => new Uint16Array(cols));
  for (let i = 0; i < rows; i += 1) cost[i][0] = i;
  for (let j = 0; j < cols; j += 1) cost[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      cost[i][j] = Math.min(
        cost[i - 1][j - 1] + (want[i - 1].char === got[j - 1] ? 0 : 1),
        cost[i - 1][j] + 1,
        cost[i][j - 1] + 1,
      );
    }
  }
  const matched = runs.map(() => 0);
  let extra = 0;
  let i = want.length;
  let j = got.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && want[i - 1].char === got[j - 1] && cost[i][j] === cost[i - 1][j - 1]) {
      matched[want[i - 1].at] += 1;
      i -= 1; j -= 1;
    } else if (i > 0 && j > 0 && cost[i][j] === cost[i - 1][j - 1] + 1) {
      i -= 1; j -= 1;
    } else if (i > 0 && cost[i][j] === cost[i - 1][j] + 1) {
      i -= 1;
    } else {
      extra += 1;
      j -= 1;
    }
  }
  const words = runs.map((run, at) => ({
    text: run.text,
    status: matched[at] === run.kana.length ? 'heard' : matched[at] ? 'different' : 'missed',
  }));
  return { words, extra: extra ? [''] : [], heard: words.filter((word) => word.status === 'heard').length, total: words.length };
}
