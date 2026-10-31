import { describe, it, expect } from 'vitest';
import { HETERONYMS, heteronymReading, isHeteronym, isSkipped } from '../src/lib/heteronyms.js';
import { arpabetToIpa } from '../src/lib/arpabet.js';
import { splitIpa } from '../src/lib/ipa-cues.js';

const read = (word, context) => heteronymReading(word, context);

describe('heteronymReading', () => {
  it('reads use as the verb after a subject or "to", the noun after a determiner', () => {
    expect(read('use', { prev: 'We' })).toBe('juːz');
    expect(read('use', { prev: 'to' })).toBe('juːz');
    expect(read('use', { prev: 'the' })).toBe('juːs');
    expect(read('use', { prev: 'make' })).toBe('juːs'); // make use of
    expect(read('Use', { sentenceStart: true })).toBe('juːz'); // Use this.
    expect(read('use', {})).toBe('juːz'); // the verb is the commoner
  });

  it('keeps live an adjective unless a subject comes before or a preposition after', () => {
    expect(read('live', { prev: null, next: 'video' })).toBe('laɪv'); // Second, live video
    expect(read('Live', { sentenceStart: true, next: 'music' })).toBe('laɪv');
    expect(read('live', { prev: 'I' })).toBe('lɪv');
    expect(read('live', { prev: 'who', next: 'in' })).toBe('lɪv');
    expect(read('live', { next: 'with' })).toBe('lɪv');
    expect(read('live', { prev: 'the', next: 'show' })).toBe('laɪv');
  });

  it('reads read as the past after have or be, and as the present otherwise', () => {
    expect(read('read', { prev: 'have' })).toBe('rɛd');
    expect(read('read', { prev: "I've" })).toBe('rɛd');
    expect(read('read', { prev: 'was' })).toBe('rɛd');
    expect(read('read', { prev: 'I' })).toBe('riːd');
    expect(read('Read', { sentenceStart: true })).toBe('riːd');
  });

  it('settles close by the word after it', () => {
    expect(read('close', { next: 'to' })).toBe('kloʊs');
    expect(read('Close', { sentenceStart: true, next: 'the' })).toBe('kloʊz');
    expect(read('close', { prev: 'please' })).toBe('kloʊz');
  });

  it('reads wind as the weather unless something winds up', () => {
    expect(read('wind', { prev: 'the' })).toBe('wɪnd');
    expect(read('Wind', { sentenceStart: true })).toBe('wɪnd');
    expect(read('wind', { next: 'up' })).toBe('waɪnd');
  });

  it('reads excuse me as the verb, an excuse as the noun', () => {
    expect(read('Excuse', { sentenceStart: true, next: 'me' })).toBe('ɪkˈskjuːz');
    expect(read('excuse', { prev: 'an' })).toBe('ɪkˈskjuːs');
  });

  it('answers null for any other word', () => {
    expect(read('street', { prev: 'the' })).toBeNull();
    expect(isHeteronym('Use')).toBe(true);
    expect(isHeteronym('street')).toBe(false);
  });
});

describe('isSkipped', () => {
  it('looks past the adverbs that sit between a subject and its verb', () => {
    for (const word of ['also', 'always', 'never', 'just', 'only', 'not']) expect(isSkipped(word), word).toBe(true);
    expect(isSkipped('we')).toBe(false);
  });
});

describe('HETERONYMS', () => {
  // The readings are hand-written; hold them to what the build would bake from CMUdict.
  it('writes each reading exactly as the dictionary build would', () => {
    const cmu = {
      use: ['Y UW1 Z', 'Y UW1 S'], uses: ['Y UW1 Z IH0 Z', 'Y UW1 S IH0 Z'],
      excuse: ['IH0 K S K Y UW1 Z', 'IH0 K S K Y UW1 S'], abuse: ['AH0 B Y UW1 Z', 'AH0 B Y UW1 S'],
      close: ['K L OW1 Z', 'K L OW1 S'], live: ['L IH1 V', 'L AY1 V'], lives: ['L IH1 V Z', 'L AY1 V Z'],
      read: ['R IY1 D', 'R IY1 D', 'R EH1 D'], wind: ['W AY1 N D', 'W IH1 N D'],
    };
    for (const [word, [verb, other, past]] of Object.entries(cmu)) {
      expect(HETERONYMS[word].verb, word).toBe(arpabetToIpa(verb));
      expect(HETERONYMS[word].other, word).toBe(arpabetToIpa(other));
      if (past) expect(HETERONYMS[word].past, word).toBe(arpabetToIpa(past));
    }
  });

  it('holds only readings the cue module can parse', () => {
    for (const [word, entry] of Object.entries(HETERONYMS)) {
      for (const key of ['verb', 'other', 'past']) if (entry[key]) expect(splitIpa(entry[key]), `${word}.${key}`).not.toBeNull();
    }
  });
});
