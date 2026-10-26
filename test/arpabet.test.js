import { describe, it, expect } from 'vitest';
import { arpabetToIpa } from '../src/lib/arpabet.js';

describe('arpabetToIpa', () => {
  it('converts a plain word', () => {
    expect(arpabetToIpa('F AA1 N IH0 K S')).toBe('ˈfɑː.nɪks'); // phonics
  });

  it('writes explicit long vowels and unstressed syllable boundaries', () => {
    expect(arpabetToIpa('S K IY1 M IH0 NG')).toBe('ˈskiː.mɪŋ'); // scheming
    expect(arpabetToIpa('HH AE1 P IY0')).toBe('ˈhæp.i'); // happy: final weak IY stays short
    expect(arpabetToIpa('B L UW1 B ER0 IY0')).toBe('ˈbluː.bɚ.i'); // blueberry
  });

  it('omits the stress mark on a one-syllable word', () => {
    expect(arpabetToIpa('R EH1 D')).toBe('rɛd'); // read
    expect(arpabetToIpa('HH AA1 R D')).toBe('hɑːrd'); // hard
  });

  it('marks every strong long vowel, the way Cambridge US transcribes them', () => {
    expect(arpabetToIpa('F AA1 DH ER0')).toBe('ˈfɑː.ðɚ'); // father
    expect(arpabetToIpa('L AO1')).toBe('lɔː'); // law
    expect(arpabetToIpa('S P IY1 D')).toBe('spiːd'); // speed
    expect(arpabetToIpa('F UW1 D')).toBe('fuːd'); // food
    // Short vowels and diphthongs carry no mark.
    expect(arpabetToIpa('B AE1 D')).toBe('bæd'); // bad
    expect(arpabetToIpa('R AY1 D')).toBe('raɪd'); // ride
  });

  it('drops the length mark from an unstressed long vowel', () => {
    expect(arpabetToIpa('P AA1 S T AA0')).toBe('ˈpɑː.stɑ'); // pasta
    expect(arpabetToIpa('AO0 TH EH1 N T IH0 K')).toBe('ɔˈθɛn.tɪk'); // authentic
  });

  it('reduces unstressed AH and ER, keeps the stressed forms distinct', () => {
    expect(arpabetToIpa('DH AH0')).toBe('ðə'); // the
    expect(arpabetToIpa('B AH1 T')).toBe('bʌt'); // but
    expect(arpabetToIpa('HH AE1 M S T ER0')).toBe('ˈhæm.stɚ'); // hamster
    expect(arpabetToIpa('B ER1 D')).toBe('bɝːd'); // bird
  });

  it('marks the syllable, not the vowel — the onset cluster comes after the mark', () => {
    expect(arpabetToIpa('IH2 N S T EH1 D')).toBe('ˌɪnˈstɛd'); // instead
    expect(arpabetToIpa('AH2 N D ER0 S T AE1 N D')).toBe('ˌʌn.dɚˈstænd'); // understand
  });

  it('renders both stress levels in a long word', () => {
    // epistemology — ɛ-ˌpɪs-tə-ˈmɑː-lə-ˌdʒiː
    expect(arpabetToIpa('EH0 P IH2 S T AH0 M AA1 L AH0 JH IY2')).toBe('ɛˌpɪs.təˈmɑː.ləˌdʒiː');
  });

  it('stops the onset at the longest cluster English allows', () => {
    // "nst" cannot begin a syllable, so n stays in the coda of the first one.
    expect(arpabetToIpa('IH2 N S T EH1 D')).toBe('ˌɪnˈstɛd');
    // "str" can, and takes all three.
    expect(arpabetToIpa('AH0 B S T R AE1 K T')).toBe('əbˈstrækt'); // abstract
    // ŋ can never open a syllable.
    expect(arpabetToIpa('S IH1 NG ER0')).toBe('ˈsɪŋ.ɚ'); // singer
  });

  it('maps digraph consonants and glides', () => {
    expect(arpabetToIpa('CH ER1 CH')).toBe('tʃɝːtʃ'); // church
    expect(arpabetToIpa('Y AH1 NG')).toBe('jʌŋ'); // young
    expect(arpabetToIpa('TH IH1 NG K')).toBe('θɪŋk'); // think
    expect(arpabetToIpa('V IH1 ZH AH0 N')).toBe('ˈvɪʒ.ən'); // vision
  });

  it('survives empty and unrecognised input instead of emitting garbage', () => {
    expect(arpabetToIpa('')).toBe('');
    expect(arpabetToIpa(null)).toBe('');
    expect(arpabetToIpa('QQ ZZZ')).toBe('');
    expect(arpabetToIpa('K QQ AE1 T')).toBe('kæt'); // unknown symbol dropped, rest intact
  });

  it('accepts lowercase input', () => {
    expect(arpabetToIpa('f aa1 n ih0 k s')).toBe('ˈfɑː.nɪks');
  });
});
