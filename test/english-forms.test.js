import { describe, it, expect } from 'vitest';
import { inflectionBases, addEnding, readEnglish } from '../src/lib/english-forms.js';
import { parseTable } from '../src/lib/phonetics.js';
import { arpabetToIpa } from '../src/lib/arpabet.js';

// A slice of the baked table, built the way the build bakes it.
const table = parseTable([
  ['architect', 'AA1 R K AH0 T EH2 K T'], ['cache', 'K AE1 SH'], ['stop', 'S T AA1 P'],
  ['study', 'S T AH1 D IY0'], ['use', 'Y UW1 S'], ['box', 'B AA1 K S'], ['need', 'N IY1 D'],
  ['onboard', 'AA1 N B AO2 R D'], ['codebase', 'K OW1 D B EY2 S'], ['play', 'P L EY1'],
  ['high', 'HH AY1'], ['availability', 'AH0 V EY2 L AH0 B IH1 L AH0 T IY0'],
  ['refactor', 'R IY0 F AE1 K T ER0'], ['car', 'K AA1 R'],
].map(([word, arpabet]) => `${word}\t${arpabetToIpa(arpabet)}`).join('\n'));

describe('readEnglish — words the dictionary lacks, built from their base', () => {
  it('reads architecting and architected from architect', () => {
    expect(readEnglish(table, 'architecting')).toBe('ˈɑːr.kəˌtɛk.tɪŋ');
    expect(readEnglish(table, 'Architected')).toBe('ˈɑːr.kəˌtɛk.tɪd');
  });

  it('says -ed as /t/, /d/ or /ɪd/ by the sound before it', () => {
    expect(readEnglish(table, 'stopped')).toBe('stɑːpt');  // voiceless p → t
    expect(readEnglish(table, 'played')).toBe('pleɪd');    // vowel → d
    expect(readEnglish(table, 'needed')).toBe('ˈniː.dɪd'); // d → ɪd, a syllable of its own
    // Same as the dictionary's own studied: S T AH1 D IY0 D.
    expect(readEnglish(table, 'studied')).toBe(arpabetToIpa('S T AH1 D IY0 D'));
  });

  it('says -s as /s/, /z/ or /ɪz/ by the sound before it', () => {
    expect(readEnglish(table, 'architects')).toBe('ˈɑːr.kəˌtɛkts');
    expect(readEnglish(table, 'plays')).toBe('pleɪz');
    expect(readEnglish(table, 'codebases')).toBe('ˈkoʊdˌbeɪ.sɪz');
    expect(readEnglish(table, 'boxes')).toBe('ˈbɑːk.sɪz');
  });

  it('finds the base through doubled consonants, a dropped e, and y → i', () => {
    expect(readEnglish(table, 'stopping')).toBe('ˈstɑː.pɪŋ');
    expect(readEnglish(table, 'caching')).toBe('ˈkæ.ʃɪŋ');
    expect(readEnglish(table, 'cached')).toBe('kæʃt');
    expect(readEnglish(table, 'used')).toBe('juːst'); // use, never us
    expect(readEnglish(table, 'onboarding')).toBe('ˈɑːnˌbɔːr.dɪŋ');
  });

  it('starts the new syllable on a vowel-final base without moving anything', () => {
    expect(readEnglish(table, 'refactoring')).toBe('riˈfæk.tɚ.ɪŋ');
    expect(readEnglish(table, 'playing')).toBe('ˈpleɪ.ɪŋ');
  });

  it('prefers a dropped e, and never builds on a letter-by-letter abbreviation', () => {
    const t = parseTable('ach\tˈeɪˈsiːˈeɪtʃ\nache\teɪk\nwrit\trɪt\nwrite\traɪt\n');
    expect(readEnglish(t, 'aching')).toBe('ˈeɪ.kɪŋ');
    expect(readEnglish(t, 'writing')).toBe('ˈraɪ.tɪŋ');
    expect(readEnglish(parseTable('ach\tˈeɪˈsiːˈeɪtʃ\n'), 'aching')).toBeNull();
  });

  it('still prefers the dictionary, and gives up on words with no known base', () => {
    expect(readEnglish(table, 'car')).toBe('kɑːr');
    expect(readEnglish(table, 'kubernetes')).toBeNull();
    expect(readEnglish(null, 'architecting')).toBeNull();
  });
});

describe('inflectionBases', () => {
  it('never offers a base so short, or so common, that it matches by accident', () => {
    expect(inflectionBases('used').map(([b]) => b)).not.toContain('us');
    expect(inflectionBases('ising').map(([b]) => b)).not.toContain('is');
    expect(inflectionBases('bed')).toEqual([]); // be is a function word, b too short
  });
});

describe('addEnding', () => {
  it('gives a one-syllable word the stress mark it needs once it has two', () => {
    expect(addEnding('kæʃ', 'ing')).toBe('ˈkæ.ʃɪŋ');
    expect(addEnding('kæʃ', 'ed')).toBe('kæʃt');
  });

  it('keeps an affricate whole when it moves', () => {
    expect(addEnding('ˈmæn.ɪdʒ', 'ing')).toBe('ˈmæn.ɪ.dʒɪŋ');
  });

  it('refuses a reading it cannot parse', () => {
    expect(addEnding('kæt!', 'ing')).toBeNull();
  });
});
