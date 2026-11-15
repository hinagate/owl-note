import { describe, it, expect } from 'vitest';
import { compareReadings, compareWords, spokenWords } from '../src/lib/speech-check.js';

const statuses = (result) => result.words.map((word) => `${word.text}:${word.status}${word.as ? `>${word.as}` : ''}`);

describe('spokenWords', () => {
  it('keeps the words and drops what is not said', () => {
    expect(spokenWords('Hello, world! (It’s "fine".)').map((w) => w.key)).toEqual(['hello', 'world', "it's", 'fine']);
  });

  it('keeps each word as it is written, for showing', () => {
    expect(spokenWords('The Weather').map((w) => w.text)).toEqual(['The', 'Weather']);
  });

  it('reads small numbers the way they are said', () => {
    expect(spokenWords('3 cats, 21 dogs').map((w) => w.key)).toEqual(['three', 'cats', 'twenty', 'one', 'dogs']);
  });

  it('is empty for nothing', () => {
    expect(spokenWords('')).toEqual([]);
    expect(spokenWords('... !')).toEqual([]);
  });
});

describe('compareWords', () => {
  it('hears every word of a sentence said as written', () => {
    const result = compareWords('I thought the weather would be fine.', 'I thought the weather would be fine');
    expect(result.heard).toBe(7);
    expect(result.total).toBe(7);
    expect(result.extra).toEqual([]);
  });

  it('is not put off by capitals or punctuation the recogniser adds', () => {
    expect(compareWords('select a word', 'Select a word.').heard).toBe(3);
  });

  it('shows a word that came out as another word, and which', () => {
    const result = compareWords('the leather would be fine', 'the weather would be fine');
    expect(statuses(result)).toEqual(['the:heard', 'leather:different>weather', 'would:heard', 'be:heard', 'fine:heard']);
  });

  it('shows a word that did not come out at all', () => {
    const result = compareWords('through the whole weekend', 'through the weekend');
    expect(statuses(result)).toEqual(['through:heard', 'the:heard', 'whole:missed', 'weekend:heard']);
  });

  it('lists what was heard that was not meant', () => {
    const result = compareWords('thank you', 'thank you very much');
    expect(result.heard).toBe(2);
    expect(result.extra).toEqual(['very', 'much']);
  });

  it('marks everything missed when something else entirely was said', () => {
    const result = compareWords('good morning', 'see you later');
    expect(result.heard).toBe(0);
    expect(result.words.every((word) => word.status !== 'heard')).toBe(true);
  });

  // A recogniser writes the word it thinks was meant. Their and there are one spoken word.
  it('counts two spellings of one spoken word as heard, when told they sound the same', () => {
    const same = (a, b) => new Set([a, b]).size === 2 && ['their', 'there'].includes(a) && ['their', 'there'].includes(b);
    expect(compareWords('their house', 'there house').heard).toBe(1);
    expect(compareWords('their house', 'there house', { same }).heard).toBe(2);
  });

  it('matches a number written either way', () => {
    expect(compareWords('I have 3 cats', 'I have three cats').heard).toBe(4);
    expect(compareWords('I have three cats', 'I have 3 cats').heard).toBe(4);
  });

  it('treats a two-word number as one word on the page', () => {
    const result = compareWords('21 days', 'twenty one days');
    expect(statuses(result)).toEqual(['21:heard', 'days:heard']);
    expect(statuses(compareWords('21 days', 'twenty days'))).toEqual(['21:missed', 'days:heard']);
  });

  // Whether a name or a compound is spaced is the recogniser's spelling, not the speaker's
  // doing. Reported with "Downdetector", written down as "down detector" and marked wrong.
  it('takes one word written down as two for the word it is', () => {
    const result = compareWords('according to Downdetector. While some', 'according to down detector. While some');
    expect(statuses(result)).toEqual(['according:heard', 'to:heard', 'Downdetector:heard', 'While:heard', 'some:heard']);
    expect(result.extra).toEqual([]);
    expect(result.heard).toBe(5);
  });

  it('takes two words written down as one for the two they are', () => {
    const result = compareWords('find work arounds for it', 'find workarounds for it');
    expect(statuses(result)).toEqual(['find:heard', 'work:heard', 'arounds:heard', 'for:heard', 'it:heard']);
    expect(result.extra).toEqual([]);
  });

  it('still shows a word as different when the two heard in its place are not it', () => {
    const result = compareWords('the detector is on', 'the down sector is on');
    expect(result.words[1].status).not.toBe('heard');
    expect(result.heard).toBe(3);
  });

  it('keeps a repeated word in its own place', () => {
    const result = compareWords('the cat saw the dog', 'the cat saw a dog');
    expect(statuses(result)).toEqual(['the:heard', 'cat:heard', 'saw:heard', 'the:different>a', 'dog:heard']);
  });

  it('copes with nothing heard, and with nothing meant', () => {
    expect(compareWords('hello there', '').heard).toBe(0);
    expect(compareWords('', 'hello').total).toBe(0);
  });
});

describe('compareReadings', () => {
  // 今日は晴れです, cut and read the way the annotator does it.
  const target = [
    { text: '今日', reading: 'きょう' },
    { text: 'は', reading: null },
    { text: '晴れ', reading: 'はれ' },
    { text: 'です', reading: null },
    { text: '。', reading: null },
  ];

  it('hears every word when the reading matches, whatever characters were written', () => {
    const result = compareReadings(target, 'きょうははれです');
    expect(result.words.map((w) => w.status)).toEqual(['heard', 'heard', 'heard', 'heard']);
    expect(result.total).toBe(4); // the full stop is not a word
  });

  it('treats katakana and hiragana as one', () => {
    expect(compareReadings([{ text: 'コーヒー', reading: null }], 'こーひー').heard).toBe(1);
  });

  it('shows the word whose reading came out differently', () => {
    const result = compareReadings(target, 'きょうはあめです');
    expect(result.words.map((w) => `${w.text}:${w.status}`)).toEqual(['今日:heard', 'は:heard', '晴れ:missed', 'です:heard']);
  });

  it('marks a word different when only part of it was heard', () => {
    const result = compareReadings([{ text: '晴れ', reading: 'はれ' }], 'は');
    expect(result.words[0].status).toBe('different');
  });
});
