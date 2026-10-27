import { describe, it, expect } from 'vitest';
import { splitIpa, pronunciationCues, WEAK_FORMS, UNSTRESSED_WORDS } from '../src/lib/ipa-cues.js';
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
      { text: 'b', cue: null, stressed: true },
      { text: 'æ', cue: 'long', stressed: true },
      { text: 'd', cue: 'final', stressed: true },
    ]);
  });

  it('leaves function words light all through, which shows the sentence rhythm', () => {
    expect(pronunciationCues('ðə', 'the')).toBeNull();
    expect(pronunciationCues('tuː', 'to')).toBeNull();
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
