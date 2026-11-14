import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  MAX_PASSAGE_CHARS, MAX_SPOKEN_CHARS, VOICE_CHOICE_KEY, createVoiceSource, pickVoice, rateFor, readVoiceChoices, selectionLanguage,
  spokenText, voiceProvider, voicesFor,
} from '../src/lib/pronounce.js';

// What Chrome lists on a Windows computer with English and Mandarin voices installed.
const voice = (name, lang, localService, extra = {}) => ({ name, lang, localService, default: false, ...extra });
const MARK = voice('Microsoft Mark', 'en-US', true);
const HANHAN = voice('Microsoft Hanhan', 'zh-TW', true);
const HUIHUI = voice('Microsoft Huihui', 'zh-CN', true);
const GOOGLE_US = voice('Google US English', 'en-US', false);
const GOOGLE_UK = voice('Google UK English Female', 'en-GB', false);
const GOOGLE_JA = voice('Google 日本語', 'ja-JP', false);
const GOOGLE_YUE = voice('Google 粤語（香港）', 'zh-HK', false);
const GOOGLE_TW = voice('Google 國語（臺灣）', 'zh-TW', false);
const WINDOWS = [HANHAN, MARK, HUIHUI, GOOGLE_US, GOOGLE_UK, GOOGLE_JA, GOOGLE_YUE, GOOGLE_TW];

describe('pickVoice', () => {
  it('takes a voice on this computer over an online one', () => {
    expect(pickVoice(WINDOWS, 'en')).toBe(MARK);
  });

  it('prefers an on-device voice in another accent to sending text online', () => {
    const british = voice('Microsoft Hazel', 'en-GB', true);
    expect(pickVoice([GOOGLE_US, british], 'en')).toBe(british);
  });

  it('falls back to an online voice when the computer has none', () => {
    expect(pickVoice(WINDOWS, 'ja')).toBe(GOOGLE_JA);
    expect(pickVoice(WINDOWS, 'yue')).toBe(GOOGLE_YUE);
  });

  it('uses an on-device Japanese or Cantonese voice when one is installed', () => {
    const haruka = voice('Microsoft Haruka', 'ja-JP', true);
    const tracy = voice('Microsoft Tracy', 'zh-HK', true);
    expect(pickVoice([...WINDOWS, haruka], 'ja')).toBe(haruka);
    expect(pickVoice([...WINDOWS, tracy], 'yue')).toBe(tracy);
  });

  // The readings are Jyutping, so a Mandarin voice would contradict what is on screen.
  it('never lets a Mandarin voice read Cantonese, even if it is all there is', () => {
    expect(pickVoice([HANHAN, HUIHUI, GOOGLE_TW], 'yue')).toBeNull();
  });

  it('accepts the other spellings browsers use for a language', () => {
    const underscore = voice('Kyoko', 'ja_JP', true);
    const yue = voice('Sinji', 'yue-HK', true);
    expect(pickVoice([underscore], 'ja')).toBe(underscore);
    expect(pickVoice([yue], 'yue')).toBe(yue);
  });

  it('takes the browser default among equal voices', () => {
    const preferred = voice('Samantha', 'en-US', true, { default: true });
    expect(pickVoice([MARK, preferred], 'en')).toBe(preferred);
  });

  it('finds nothing for a language with no reading, or an empty list', () => {
    expect(pickVoice(WINDOWS, 'ko')).toBeNull();
    expect(pickVoice([], 'en')).toBeNull();
    expect(pickVoice(undefined, 'en')).toBeNull();
  });
});

// A voice an add-on installed: listed by the browser like any other, and on this device.
const ADDON = voice('Clara (add-on)', 'en-US', true);

describe('a voice chosen in Settings', () => {
  it('is used instead of the automatic one', () => {
    expect(pickVoice([MARK, ADDON], 'en')).toBe(MARK);
    expect(pickVoice([MARK, ADDON], 'en', 'Clara (add-on)')).toBe(ADDON);
  });

  it('may be an online voice even where the computer has its own', () => {
    expect(pickVoice(WINDOWS, 'en', 'Google UK English Female')).toBe(GOOGLE_UK);
  });

  it('falls back to the automatic voice while it is not listed', () => {
    expect(pickVoice(WINDOWS, 'en', 'Clara (add-on)')).toBe(MARK);
  });

  // A choice made for one language must not drag its voice into another.
  it('is never used for a language it cannot read', () => {
    expect(pickVoice(WINDOWS, 'yue', 'Microsoft Hanhan')).toBe(GOOGLE_YUE);
    expect(pickVoice(WINDOWS, 'ja', 'Microsoft Mark')).toBe(GOOGLE_JA);
  });
});

describe('voicesFor', () => {
  it('lists what can read a language, best first', () => {
    expect(voicesFor(WINDOWS, 'en')).toEqual([MARK, GOOGLE_US, GOOGLE_UK]);
    expect(voicesFor([GOOGLE_US, ADDON, MARK], 'en')).toEqual([ADDON, MARK, GOOGLE_US]);
  });

  it('leaves the list the browser gave as it was', () => {
    const list = [GOOGLE_US, MARK];
    voicesFor(list, 'en');
    expect(list).toEqual([GOOGLE_US, MARK]);
  });

  it('is empty for a language with no reading', () => {
    expect(voicesFor(WINDOWS, 'ko')).toEqual([]);
    expect(voicesFor(undefined, 'en')).toEqual([]);
  });
});

describe('readVoiceChoices', () => {
  it('reads what was saved', async () => {
    const storage = { get: async () => ({ [VOICE_CHOICE_KEY]: { en: 'Clara (add-on)' } }) };
    await expect(readVoiceChoices(storage)).resolves.toEqual({ en: 'Clara (add-on)' });
  });

  it('is empty when nothing was saved, or storage fails, or there is none', async () => {
    await expect(readVoiceChoices({ get: async () => ({}) })).resolves.toEqual({});
    await expect(readVoiceChoices({ get: async () => { throw new Error('gone'); } })).resolves.toEqual({});
    await expect(readVoiceChoices(undefined)).resolves.toEqual({});
  });
});

describe('rateFor', () => {
  it('leaves normal speed alone', () => {
    expect(rateFor(MARK, false)).toBe(1);
    expect(rateFor(GOOGLE_US, false)).toBe(1);
  });

  it('slows an on-device voice further, because it responds less', () => {
    expect(rateFor(MARK, true)).toBeLessThan(rateFor(GOOGLE_US, true));
    expect(rateFor(GOOGLE_US, true)).toBeLessThan(1);
  });
});

describe('spokenText', () => {
  const rangeOver = (html) => {
    document.body.innerHTML = `<div id="r">${html}</div>`;
    const range = document.createRange();
    range.selectNodeContents(document.getElementById('r'));
    return range;
  };

  it('keeps the words and leaves the readings out', () => {
    expect(spokenText(rangeOver('<ruby>apple<rt>ˈæp.əl</rt></ruby> <ruby>pie<rt>paɪ</rt></ruby>'))).toBe('apple pie');
  });

  it('reads characters without their Jyutping', () => {
    expect(spokenText(rangeOver('<ruby lang="yue">銀<rt>ngan4</rt></ruby><ruby lang="yue">行<rt>hong4</rt></ruby>'))).toBe('銀行');
  });

  it('collapses whitespace from the layout', () => {
    expect(spokenText(rangeOver('  one\n\n   two  '))).toBe('one two');
  });

  it('leaves a selection inside one paragraph as it is written', () => {
    expect(spokenText(rangeOver('<p>Notes save as you type, and the preview\nfollows along</p>')))
      .toBe('Notes save as you type, and the preview follows along');
  });

  // Read straight on, "Where things stand Coming back online" is one garbled sentence.
  it('ends a heading or list item that has no punctuation of its own', () => {
    expect(spokenText(rangeOver('<h2>Where things stand</h2><p>Queues are back to normal.</p><ul><li>Email</li><li>Meetings</li></ul><p>All fine</p>')))
      .toBe('Where things stand. Queues are back to normal. Email. Meetings. All fine');
  });

  it('adds nothing where a line already ends itself', () => {
    expect(spokenText(rangeOver('<p>Is it back?</p><p>What was hit:</p><p>Email, mostly.</p>')))
      .toBe('Is it back? What was hit: Email, mostly.');
    expect(spokenText(rangeOver('<p>She said “soon.”</p><p>Then nothing</p>'))).toBe('She said “soon.” Then nothing');
  });

  it('treats a typed bullet and a line break as the start of a new line', () => {
    expect(spokenText(rangeOver('<p>Where things stand • Coming back online: fine<br>Second line</p>')))
      .toBe('Where things stand. Coming back online: fine. Second line');
  });

  it('reads table cells one at a time', () => {
    expect(spokenText(rangeOver('<table><tr><th>Feature</th><th>State</th></tr><tr><td>Tables</td><td>stay tables</td></tr></table>')))
      .toBe('Feature. State. Tables. stay tables');
  });

  it('skips what a voice would read as noise: code blocks, formulas and diagrams', () => {
    expect(spokenText(rangeOver('<p>Before</p><pre><code>const x = 1;</code></pre><p>Then <span class="katex">E=mc2 E = m c 2</span> and <code>inline</code>.</p><div class="mermaid-diagram">A --> B</div><p>After</p>')))
      .toBe('Before. Then and inline. After');
  });

  it('keeps the readings out of every line of a passage', () => {
    expect(spokenText(rangeOver('<p><ruby>apple<rt>ˈæp.əl</rt></ruby> <ruby>pie<rt>paɪ</rt></ruby></p><p><ruby>good<rt>ɡʊd</rt></ruby></p>')))
      .toBe('apple pie. good');
  });
});

describe('selectionLanguage', () => {
  const pick = (html, selector = '#r') => {
    document.body.innerHTML = `<div id="r">${html}</div>`;
    const range = document.createRange();
    range.selectNodeContents(document.querySelector(selector));
    return selectionLanguage(range, spokenText(range));
  };

  it('follows the reading shown on a word', () => {
    expect(pick('<ruby lang="ja">日本語<rt>にほんご</rt></ruby>')).toBe('ja');
    expect(pick('<ruby lang="yue">銀<rt>ngan4</rt></ruby>')).toBe('yue');
  });

  it('treats a reading with no language as English, as the annotator writes it', () => {
    expect(pick('<ruby>apple<rt>ˈæp.əl</rt></ruby>')).toBe('en');
  });

  it('reads a selection inside one word by that word', () => {
    expect(pick('<ruby lang="ja">日本語<rt>にほんご</rt></ruby>', 'ruby')).toBe('ja');
  });

  it('hands a mixed selection to the voice that can read both', () => {
    expect(pick('<ruby>apple<rt>ˈæp.əl</rt></ruby> <ruby lang="yue">蘋<rt>ping4</rt></ruby>')).toBe('yue');
  });

  it('judges unannotated text by its script', () => {
    expect(pick('plain words')).toBe('en');
    expect(pick('ひらがな')).toBe('ja');
    expect(pick('今日天氣')).toBe('yue');
  });

  it('offers nothing for a script with no reading', () => {
    expect(pick('안녕하세요')).toBeNull();
    expect(pick('123 !?')).toBeNull();
  });
});

describe('voiceProvider', () => {
  it('names who an online voice sends text to', () => {
    expect(voiceProvider(GOOGLE_YUE)).toBe('Google');
    expect(voiceProvider(voice('Microsoft Xiaoxiao Online', 'zh-CN', false))).toBe('Microsoft');
    expect(voiceProvider(voice('Some Voice', 'en-US', false))).toBeNull();
  });
});

describe('createVoiceSource', () => {
  afterEach(() => vi.useRealTimers());

  const synthWith = (initial) => {
    const synth = new EventTarget();
    synth.list = initial;
    synth.getVoices = () => synth.list;
    return synth;
  };

  it('answers at once when an on-device voice is already listed', async () => {
    const source = createVoiceSource(synthWith([MARK]));
    await expect(source.voiceFor('en')).resolves.toBe(MARK);
  });

  // Chrome can list its online voices first. Answering then would ask to use one on a
  // computer that has its own, which is what the wait is for.
  it('waits for the computer\'s own voices rather than settling for an online one', async () => {
    vi.useFakeTimers();
    const synth = synthWith([GOOGLE_US]);
    const source = createVoiceSource(synth, { settleMs: 3000 });
    const answer = source.voiceFor('en');
    await vi.advanceTimersByTimeAsync(500);
    synth.list = [GOOGLE_US, MARK];
    synth.dispatchEvent(new Event('voiceschanged'));
    await expect(answer).resolves.toBe(MARK);
  });

  it('gives up waiting once the list has had time to fill', async () => {
    vi.useFakeTimers();
    const source = createVoiceSource(synthWith([GOOGLE_YUE]), { settleMs: 3000 });
    const answer = source.voiceFor('yue');
    await vi.advanceTimersByTimeAsync(3000);
    await expect(answer).resolves.toBe(GOOGLE_YUE);
  });

  it('counts the wait from when the list was first asked for, so the first click is not kept waiting', async () => {
    vi.useFakeTimers();
    const source = createVoiceSource(synthWith([GOOGLE_YUE]), { settleMs: 3000 });
    source.prime();
    await vi.advanceTimersByTimeAsync(3000);
    await expect(source.voiceFor('yue')).resolves.toBe(GOOGLE_YUE);
  });

  it('answers at once with a chosen voice that is already listed', async () => {
    const source = createVoiceSource(synthWith([MARK, ADDON]));
    await expect(source.voiceFor('en', 'Clara (add-on)')).resolves.toBe(ADDON);
  });

  // An add-on can list its voice after the computer's own. Answering early would read
  // the first words in the wrong voice.
  it('waits for a chosen voice that is listed late', async () => {
    vi.useFakeTimers();
    const synth = synthWith([MARK]);
    const source = createVoiceSource(synth, { settleMs: 3000 });
    const answer = source.voiceFor('en', 'Clara (add-on)');
    await vi.advanceTimersByTimeAsync(500);
    synth.list = [MARK, ADDON];
    synth.dispatchEvent(new Event('voiceschanged'));
    await expect(answer).resolves.toBe(ADDON);
  });

  it('uses the automatic voice when a chosen one never arrives', async () => {
    vi.useFakeTimers();
    const source = createVoiceSource(synthWith([MARK]), { settleMs: 3000 });
    const answer = source.voiceFor('en', 'Clara (add-on)');
    await vi.advanceTimersByTimeAsync(3000);
    await expect(answer).resolves.toBe(MARK);
  });

  it('says so when no voice ever arrives', async () => {
    vi.useFakeTimers();
    const source = createVoiceSource(synthWith([]), { settleMs: 3000 });
    const answer = source.voiceFor('yue');
    await vi.advanceTimersByTimeAsync(3000);
    await expect(answer).resolves.toBeNull();
  });
});

describe('MAX_SPOKEN_CHARS', () => {
  // The most an online voice is given, because it is sent to that voice's provider.
  it('is a phrase, not a passage', () => {
    expect(MAX_SPOKEN_CHARS).toBeLessThanOrEqual(300);
  });
});

describe('MAX_PASSAGE_CHARS', () => {
  it('is several paragraphs, and inside what the browser takes in one request', () => {
    expect(MAX_PASSAGE_CHARS).toBeGreaterThanOrEqual(2000);
    expect(MAX_PASSAGE_CHARS).toBeLessThan(32767);
  });
});
