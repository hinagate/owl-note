import { describe, it, expect } from 'vitest';
import {
  splitIpa, pronunciationCues, WEAK_FORMS, UNSTRESSED_WORDS, holdFinalStop, startsWithConsonant,
} from '../src/lib/ipa-cues.js';
import { arpabetToIpa } from '../src/lib/arpabet.js';

/** Render cues compactly: [x] long, [[x]] longer, {x} final; null when none. Stress aside. */
const show = (ipa, word) => {
  const parts = pronunciationCues(ipa, word);
  if (!parts || !parts.some((p) => p.cue)) return null;
  return parts.map(({ text, cue }) => (
    cue === 'long' ? `[${text}]`
      : cue === 'longer' ? `[[${text}]]`
        : cue === 'final' ? `{${text}}` : text
  )).join('');
};

/** Render stress alone: <x> is the dark, stressed stretch; null when nothing is. */
const stress = (ipa, word) => {
  const parts = pronunciationCues(ipa, word);
  if (!parts) return null;
  return parts.map(({ text, stressed }) => (stressed ? `<${text}>` : text)).join('').replace(/></g, '');
};

describe('splitIpa', () => {
  it('keeps long vowels, diphthongs and affricates whole', () => {
    expect(splitIpa('ˈfɑː.ðɚ').map((s) => s.text)).toEqual(['ˈ', 'f', 'ɑː', '.', 'ð', 'ɚ']);
    expect(splitIpa('tʃɔɪs').map((s) => s.text)).toEqual(['tʃ', 'ɔɪ', 's']);
    expect(splitIpa('dʒeɪl').map((s) => s.kind)).toEqual(['consonant', 'vowel', 'consonant']);
  });

  it('refuses a reading it cannot fully account for', () => {
    expect(splitIpa('kæt!')).toBeNull();
    expect(splitIpa('')).toEqual([]);
  });
});

describe('pronunciationCues — length', () => {
  it('holds a long vowel, and holds it longer before a voiced final', () => {
    expect(show('spiːtʃ', 'speech')).toBe('sp[iː]{tʃ}');
    expect(show('spiːd', 'speed')).toBe('sp[[iː]]{d}');
    expect(show('siːt', 'seat')).toBe('s[iː]t');
    expect(show('siːd', 'seed')).toBe('s[[iː]]{d}');
  });

  it('lengthens a short vowel before a voiced final, and only then', () => {
    expect(show('bæd', 'bad')).toBe('b[æ]{d}');
    expect(show('bæt', 'bat')).toBeNull(); // nothing to say: short, and t is a Cantonese final
    expect(show('raɪd', 'ride')).toBe('r[aɪ]{d}');
    expect(show('raɪt', 'right')).toBeNull();
  });

  it('lets sonorants through to the obstruent that decides', () => {
    expect(show('kɑːrdz', 'cards')).toBe('k[[ɑː]]{rdz}');
    expect(show('kɑːrt', 'cart')).toBe('k[ɑː]{rt}');
    expect(show('fiːl', 'feel')).toBe('f[iː]{l}'); // no obstruent at all: long, not longer
  });

  it('cues only the stressed syllable, never a reduced vowel', () => {
    // distracted: the stressed æ is followed by voiceless k, the rest is unstressed.
    expect(show('dɪˈstræk.təd', 'distracted')).toBe('dɪˈstræk.tə{d}');
    expect(show('ˈfɑː.ðɚ', 'father')).toBe('ˈf[ɑː].ðɚ');
    // Secondary stress counts too.
    expect(show('ɛˌpɪs.təˈmɑː.ləˌdʒiː', 'epistemology')).toBe('ɛˌpɪs.təˈm[ɑː].ləˌdʒ[iː]');
  });

  it('agrees with the table the build actually bakes', () => {
    expect(show(arpabetToIpa('S P IY1 D'), 'speed')).toBe('sp[[iː]]{d}');
    expect(show(arpabetToIpa('B ER1 D'), 'bird')).toBe('b[[ɝː]]{d}');
    expect(show(arpabetToIpa('K AH1 M F ER0 T AH0 B AH0 L'), 'comfortable')).toBe('ˈkʌm.fɚ.tə.bə{l}');
  });
});

describe('pronunciationCues — final consonants', () => {
  it('marks a final Cantonese never ends a syllable with', () => {
    expect(show('fiːl', 'feel')).toBe('f[iː]{l}');
    expect(show('lʌv', 'love')).toBe('l[ʌ]{v}');
    expect(show('bʌs', 'bus')).toBe('bʌ{s}');
  });

  it('marks every consonant of a final cluster, even one built from Cantonese finals', () => {
    expect(show('dɪˈstrækt', 'distract')).toBe('dɪˈstræ{kt}');
    expect(show('wɑːnt', 'want')).toBe('w[ɑː]{nt}');
    expect(show('θɪŋk', 'think')).toBe('θɪ{ŋk}');
  });

  it('leaves the finals Cantonese already has alone', () => {
    expect(show('kʌp', 'cup')).toBeNull();
    expect(show('hɪm', 'hymn')).toBeNull();
    expect(show('sɪŋ', 'sing')).toBeNull();
  });
});

// Stress is shown by shade rather than a mark: the main stressed syllable dark, the rest
// light. Cantonese weighs every syllable the same, so this is where long words go wrong.
describe('pronunciationCues — stress', () => {
  it('darkens the syllable the main stress opens, mark and all', () => {
    expect(stress('dɪˈstræk.təd', 'distracted')).toBe('dɪ<ˈstræk>.təd');
    expect(stress('ˈfɑː.ðɚ', 'father')).toBe('<ˈfɑː>.ðɚ');
    expect(stress('hoʊˈtɛl', 'hotel')).toBe('hoʊ<ˈtɛl>');
  });

  it('tells photograph from photographer', () => {
    expect(stress('ˈfoʊ.təˌɡræf', 'photograph')).toBe('<ˈfoʊ>.təˌɡræf');
    expect(stress('fəˈtɑː.ɡrə.fɚ', 'photographer')).toBe('fə<ˈtɑː>.ɡrə.fɚ');
  });

  it('leaves secondary stress light, so the main one stands out', () => {
    expect(stress('ɛˌpɪs.təˈmɑː.ləˌdʒiː', 'epistemology')).toBe('ɛˌpɪs.tə<ˈmɑː>.ləˌdʒiː');
  });

  it('darkens a whole one-syllable word, even one with no other cue', () => {
    expect(stress('kʌp', 'cup')).toBe('<kʌp>');
    expect(stress('spiːd', 'speed')).toBe('<spiːd>');
  });

  it('keeps a cue and the stress on the same stretch apart', () => {
    expect(pronunciationCues('bæd', 'bad')).toEqual([
      { text: 'b', cue: null, stressed: true, fall: true }, // a held one-syllable word: ↘
      { text: 'æ', cue: 'long', stressed: true },
      { text: 'd', cue: 'final', stressed: true },
    ]);
  });

  it('leaves function words light all through, which shows the sentence rhythm', () => {
    expect(pronunciationCues('ðə', 'the')).toBeNull();
    expect(pronunciationCues('tuː', 'to')).toBeNull();
  });
});

// What do you want → "Wha' do you want": the t is not released, but the stop still happens.
describe('holdFinalStop', () => {
  it('splits off a final p, t or k as its own held part, keeping the rest as it was', () => {
    const parts = holdFinalStop('wʌt', pronunciationCues('wʌt', 'what'));
    expect(parts).toEqual([
      { text: 'wʌ', cue: null, stressed: true },
      { text: 't', cue: null, stressed: true, held: true },
    ]);
  });

  it('keeps the orange of a final cluster on the stop it holds', () => {
    const parts = holdFinalStop('æskt', pronunciationCues('æskt', 'asked'));
    expect(parts.map((p) => p.text).join('')).toBe('æskt');
    expect(parts.at(-1)).toEqual({ text: 't', cue: 'final', stressed: true, held: true });
    expect(parts.at(-2)).toMatchObject({ text: 'sk', cue: 'final' });
  });

  it('builds parts for a function word, which has none of its own', () => {
    expect(pronunciationCues('ət', 'at')).toBeNull();
    expect(holdFinalStop('ət', null)).toEqual([
      { text: 'ə', cue: null, stressed: false },
      { text: 't', cue: null, stressed: false, held: true },
    ]);
  });

  it('holds only p, t and k — not an affricate, a fricative or a voiced stop', () => {
    expect(holdFinalStop('kʌp', null).at(-1).text).toBe('p');
    expect(holdFinalStop('bʊk', null).at(-1).text).toBe('k');
    expect(holdFinalStop('wɑtʃ', null)).toBeNull(); // watch: tʃ is one sound
    expect(holdFinalStop('lʌv', null)).toBeNull();
    expect(holdFinalStop('bæd', null)).toBeNull();
    expect(holdFinalStop('kæt!', null)).toBeNull(); // unparseable
  });
});

describe('startsWithConsonant', () => {
  it('reads the first sound, past any stress mark', () => {
    expect(startsWithConsonant('du')).toBe(true);
    expect(startsWithConsonant('ˈskuːl')).toBe(true);
    expect(startsWithConsonant('ɪz')).toBe(false);
    expect(startsWithConsonant('ˈaʊ.ɚ')).toBe(false); // hour: spelled with h, sounds a vowel
    expect(startsWithConsonant('')).toBe(false);
  });
});

// street said like the rising 史 si2 sounds like a question and breaks off from smarts.
// A one-syllable word with a held vowel gets ↘: hold it, but let the pitch fall.
describe('pronunciationCues — the falling mark', () => {
  const falls = (ipa, word) => Boolean(pronunciationCues(ipa, word)?.[0]?.fall);

  it('marks a one-syllable word whose vowel is held', () => {
    for (const [ipa, word] of [['striːt', 'street'], ['smɑːrts', 'smarts'], ['spiːd', 'speed'], ['fiːl', 'feel'], ['bæd', 'bad']]) {
      expect(falls(ipa, word), word).toBe(true);
    }
  });

  it('leaves alone a vowel that is not held, a longer word, and a function word', () => {
    expect(falls('bæt', 'bat')).toBe(false); // short, before a voiceless stop
    expect(falls('tʊk', 'took')).toBe(false);
    expect(falls('fəˈtɑː.ɡrə.fɚ', 'photographer')).toBe(false); // several syllables
    expect(pronunciationCues('wəz', 'was')).toBeNull();
  });

  it('puts it on the first part only, even when the final stop is split off', () => {
    const parts = holdFinalStop('striːt', pronunciationCues('striːt', 'street'));
    expect(parts.map((p) => p.text)).toEqual(['str', 'iː', 't']);
    expect(parts.filter((p) => p.fall).map((p) => p.text)).toEqual(['str']);
  });
});

describe('WEAK_FORMS', () => {
  it('covers only words already treated as unstressed, so they never get a cue or stress', () => {
    for (const [word, form] of Object.entries(WEAK_FORMS)) {
      expect(UNSTRESSED_WORDS.has(word), word).toBe(true);
      expect(pronunciationCues(form, word), word).toBeNull();
    }
  });

  it('holds only readings this module can parse, and none with a length mark', () => {
    for (const [word, form] of Object.entries(WEAK_FORMS)) {
      expect(splitIpa(form), word).not.toBeNull();
      expect(form, word).not.toContain('ː');
    }
  });
});

describe('pronunciationCues — what it leaves alone', () => {
  it('skips the function words a sentence does not stress', () => {
    expect(pronunciationCues('ɪz', 'is')).toBeNull();
    expect(pronunciationCues('wɑːz', 'Was')).toBeNull();
    expect(pronunciationCues('wɪð', 'with')).toBeNull();
    expect(pronunciationCues('tuː', 'to')).toBeNull();
  });

  it('gives nothing rather than guessing at a reading it cannot parse', () => {
    expect(pronunciationCues('spiːd!', 'speed')).toBeNull();
    expect(pronunciationCues('', 'x')).toBeNull();
    expect(pronunciationCues(null)).toBeNull();
  });

  it('always rebuilds the reading exactly', () => {
    for (const [ipa, word] of [['kɑːrdz', 'cards'], ['dɪˈstræk.təd', 'distracted'], ['ˌpɑːrˈtɪk.jə.lɚ.li', 'particularly']]) {
      const parts = pronunciationCues(ipa, word);
      expect(parts.map((p) => p.text).join('')).toBe(ipa);
    }
  });
});
