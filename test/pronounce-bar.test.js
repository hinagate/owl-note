import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createPronounceBar } from '../src/app/pronounce-bar.js';
import { renderEditor } from '../src/app/editor.js';
import { createVoiceSource, MAX_PASSAGE_CHARS, MAX_SPOKEN_CHARS, VOICE_CHOICE_KEY } from '../src/lib/pronounce.js';

const voice = (name, lang, localService) => ({ name, lang, localService, default: false });
const MARK = voice('Microsoft Mark', 'en-US', true);
const GOOGLE_YUE = voice('Google 粤語（香港）', 'zh-HK', false);

class FakeUtterance {
  constructor(text) { this.text = text; }
}

function fakeSynth(voices) {
  const synth = new EventTarget();
  synth.spoken = [];
  synth.cancelled = 0;
  synth.getVoices = () => voices;
  synth.cancel = () => { synth.cancelled += 1; };
  synth.speak = (utterance) => { synth.spoken.push(utterance); };
  return synth;
}

function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    get: async (key) => ({ [key]: data[key] }),
    set: async (values) => { Object.assign(data, values); },
  };
}

const settle = async () => { for (let i = 0; i < 6; i += 1) await new Promise((r) => { setTimeout(r, 0); }); };

let root;
let active;
let bars;

function mount({ voices = [MARK, GOOGLE_YUE], storage = fakeStorage() } = {}) {
  const synth = fakeSynth(voices);
  const bar = createPronounceBar({
    root,
    isActive: () => active,
    synth,
    Utterance: FakeUtterance,
    storage,
    voiceSource: createVoiceSource(synth, { settleMs: 0 }),
  });
  bars.push(bar);
  return { synth, bar, storage };
}

async function select(node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  await settle();
}

const shownBar = () => document.querySelector('.pronounce-bar');
const playButton = () => document.querySelector('.pronounce-play');
const slowSwitch = () => document.querySelector('.pronounce-slow input');
const note = () => document.querySelector('.pronounce-note');
const noteButton = (label) => [...document.querySelectorAll('.pronounce-note button')].find((b) => b.textContent === label);
const onlineSwitch = () => document.querySelector('.pronounce-online');
const click = async (el) => { el.click(); await settle(); };

beforeEach(() => {
  document.body.innerHTML = `<div id="root">
    <p id="en"><ruby>apple<rt>ˈæp.əl</rt></ruby></p>
    <p id="yue"><ruby lang="yue">銀<rt>ngan4</rt></ruby><ruby lang="yue">行<rt>hong4</rt></ruby></p>
    <pre id="code">const apple = 1;</pre>
    <p id="ko">안녕하세요</p>
  </div><p id="outside">outside words</p>`;
  root = document.getElementById('root');
  active = true;
  bars = [];
});

afterEach(() => {
  bars.forEach((bar) => bar.destroy());
  window.getSelection().removeAllRanges();
  vi.useRealTimers();
});

describe('when the bar appears', () => {
  it('shows beside a selected word while readings are on', async () => {
    mount();
    await select(document.getElementById('en'));
    expect(shownBar()).toBeTruthy();
    expect(playButton().getAttribute('aria-label')).toBe('Hear this');
    expect(playButton().querySelector('svg')).toBeTruthy();
  });

  it('stays away while Phonetic Assistance is off', async () => {
    active = false;
    mount();
    await select(document.getElementById('en'));
    expect(shownBar()).toBeNull();
  });

  it('stays away from code, where no reading is shown', async () => {
    mount();
    await select(document.getElementById('code'));
    expect(shownBar()).toBeNull();
  });

  it('stays away from a script with no reading', async () => {
    mount();
    await select(document.getElementById('ko'));
    expect(shownBar()).toBeNull();
  });

  it('stays away from a selection outside the preview', async () => {
    mount();
    await select(document.getElementById('outside'));
    expect(shownBar()).toBeNull();
  });

  // It used to stay away, which left a long selection with no speaker and no reason why.
  it('shows beside a passage too', async () => {
    mount();
    await select(passage());
    expect(shownBar()).toBeTruthy();
  });
});

// More than a phrase: several sentences, as when a paragraph or two are selected.
function passage(words = MAX_SPOKEN_CHARS) {
  const long = document.getElementById('outside');
  root.append(long);
  long.textContent = 'word '.repeat(words);
  return long;
}

describe('reading a passage', () => {
  it('is read whole by a voice on this device', async () => {
    const { synth } = mount();
    await select(passage());
    await click(playButton());
    expect(synth.spoken).toHaveLength(1);
    expect(synth.spoken[0].voice).toBe(MARK);
    expect(synth.spoken[0].text).toHaveLength(MAX_SPOKEN_CHARS * 5 - 1);
  });

  // What an online voice reads is sent to its provider: a phrase, never a passage. The
  // refusal comes before the question about online voices, so nothing is asked for nothing.
  it('is not given to an online voice, and says why', async () => {
    const GOOGLE_US = voice('Google US English', 'en-US', false);
    const { synth } = mount({ voices: [GOOGLE_US], storage: fakeStorage({ 'owl:pronounceOnlineOk': true }) });
    await select(passage());
    await click(playButton());
    expect(synth.spoken).toHaveLength(0);
    expect(note().textContent).toBe(`An online voice reads up to ${MAX_SPOKEN_CHARS} characters at a time, because what it reads is sent to Google. `
      + 'Select less, or choose a voice on this computer in Settings.');
    expect(noteButton('Allow')).toBeUndefined();
  });

  it('still gives an online voice a phrase', async () => {
    const GOOGLE_US = voice('Google US English', 'en-US', false);
    const { synth } = mount({ voices: [GOOGLE_US], storage: fakeStorage({ 'owl:pronounceOnlineOk': true }) });
    await select(passage(10));
    await click(playButton());
    expect(synth.spoken).toHaveLength(1);
  });

  it('says so when even a voice on this device is asked for too much', async () => {
    const { synth } = mount();
    await select(passage(MAX_PASSAGE_CHARS / 5 + 1));
    await click(playButton());
    expect(synth.spoken).toHaveLength(0);
    expect(note().textContent).toBe('This is too long to read in one go. Select up to 10,000 characters.');
  });

  it('turns the speaker into Stop while it reads, and stops on a press', async () => {
    const { synth } = mount();
    await select(passage());
    await click(playButton());
    synth.spoken[0].onstart();
    expect(playButton().getAttribute('aria-label')).toBe('Stop');
    expect(playButton().classList.contains('stoppable')).toBe(true);
    const before = synth.cancelled;
    await click(playButton());
    expect(synth.cancelled).toBe(before + 1);
    expect(synth.spoken).toHaveLength(1); // stopped, not started again
    expect(playButton().getAttribute('aria-label')).toBe('Hear this');
    expect(playButton().classList.contains('speaking')).toBe(false);
  });

  it('can be played again after it was stopped', async () => {
    const { synth } = mount();
    await select(passage());
    await click(playButton());
    synth.spoken[0].onstart();
    await click(playButton());
    await click(playButton());
    expect(synth.spoken).toHaveLength(2);
  });

  it('goes back to the speaker when the passage ends', async () => {
    const { synth } = mount();
    await select(passage());
    await click(playButton());
    synth.spoken[0].onstart();
    synth.spoken[0].onend();
    expect(playButton().getAttribute('aria-label')).toBe('Hear this');
    expect(playButton().classList.contains('stoppable')).toBe(false);
  });

  // A word is over in a moment, so pressing again says it again, as it always did.
  it('leaves a word as it was: no Stop, and a second press repeats it', async () => {
    const { synth } = mount();
    await select(document.getElementById('en'));
    await click(playButton());
    synth.spoken[0].onstart();
    expect(playButton().getAttribute('aria-label')).toBe('Hear this');
    await click(playButton());
    expect(synth.spoken).toHaveLength(2);
  });

  // Nobody is following it any more, and it could run for minutes.
  it('stops when the bar goes away', async () => {
    const { synth } = mount();
    await select(passage());
    await click(playButton());
    synth.spoken[0].onstart();
    const before = synth.cancelled;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(shownBar()).toBeNull();
    expect(synth.cancelled).toBe(before + 1);
  });

  it('lets a word finish when the bar goes away', async () => {
    const { synth } = mount();
    await select(document.getElementById('en'));
    await click(playButton());
    synth.spoken[0].onstart();
    const before = synth.cancelled;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(synth.cancelled).toBe(before);
  });
});

describe('when it goes away', () => {
  it('closes when the selection is cleared', async () => {
    mount();
    await select(document.getElementById('en'));
    window.getSelection().removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
    expect(shownBar()).toBeNull();
  });

  it('closes on Escape', async () => {
    mount();
    await select(document.getElementById('en'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(shownBar()).toBeNull();
  });

  it('keeps the selection when a press lands on the bar', async () => {
    mount();
    await select(document.getElementById('en'));
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    playButton().dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
  });

  it('does not reopen itself from a click on its own controls', async () => {
    mount();
    await select(document.getElementById('en'));
    const first = shownBar();
    playButton().dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await settle();
    expect(shownBar()).toBe(first);
  });

  it('leaves nothing behind when the editor goes, and stops the voice', async () => {
    const { bar, synth } = mount();
    await select(document.getElementById('en'));
    await click(playButton());
    const before = synth.cancelled;
    bar.destroy();
    expect(shownBar()).toBeNull();
    expect(synth.cancelled).toBe(before + 1);
    await select(document.getElementById('en'));
    expect(shownBar()).toBeNull();
  });
});

describe('reading aloud', () => {
  it('speaks the word, not its reading, in an on-device voice', async () => {
    const { synth } = mount();
    await select(document.getElementById('en'));
    await click(playButton());
    expect(synth.spoken).toHaveLength(1);
    expect(synth.spoken[0].text).toBe('apple');
    expect(synth.spoken[0].voice).toBe(MARK);
    expect(synth.spoken[0].lang).toBe('en-US');
    expect(synth.spoken[0].rate).toBe(1);
  });

  it('asks nothing for an on-device voice', async () => {
    mount();
    await select(document.getElementById('en'));
    await click(playButton());
    expect(note().hidden).toBe(true);
    expect(onlineSwitch().hidden).toBe(true);
  });

  it('stops the last word before starting the next', async () => {
    const { synth } = mount();
    await select(document.getElementById('en'));
    await click(playButton());
    const before = synth.cancelled;
    await click(playButton());
    expect(synth.cancelled).toBe(before + 1);
    expect(synth.spoken).toHaveLength(2);
  });

  it('shows when it is speaking', async () => {
    const { synth } = mount();
    await select(document.getElementById('en'));
    await click(playButton());
    synth.spoken[0].onstart();
    expect(playButton().classList.contains('speaking')).toBe(true);
    synth.spoken[0].onend();
    expect(playButton().classList.contains('speaking')).toBe(false);
  });

  it('reads slower with Slow on, and remembers it', async () => {
    const storage = fakeStorage();
    const { synth, bar } = mount({ storage });
    await select(document.getElementById('en'));
    slowSwitch().click();
    await settle();
    await click(playButton());
    expect(synth.spoken[0].rate).toBeLessThan(1);
    expect(storage.data['owl:pronounceSlow']).toBe(true);

    bar.destroy();
    mount({ storage });
    await select(document.getElementById('en'));
    expect(slowSwitch().checked).toBe(true);
  });

  it('says so when there is no voice for the language', async () => {
    const { synth } = mount({ voices: [MARK] });
    await select(document.getElementById('yue'));
    await click(playButton());
    expect(synth.spoken).toHaveLength(0);
    expect(note().hidden).toBe(false);
    expect(note().textContent).toContain('no Cantonese voice');
  });

  it('says so when a voice fails, and stays quiet when it was only cut off', async () => {
    const { synth } = mount();
    await select(document.getElementById('en'));
    await click(playButton());
    synth.spoken[0].onerror({ error: 'interrupted' });
    expect(note().hidden).toBe(true);
    synth.spoken[0].onerror({ error: 'synthesis-failed' });
    expect(note().hidden).toBe(false);
    expect(note().textContent).toContain('Could not read this aloud');
  });

  it('gives up on a voice that never starts', async () => {
    const { synth } = mount({ storage: fakeStorage({ 'owl:pronounceOnlineOk': true }) });
    await select(document.getElementById('yue'));
    vi.useFakeTimers();
    playButton().click();
    await vi.advanceTimersByTimeAsync(100);
    expect(synth.spoken).toHaveLength(1);
    expect(note().hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(8000);
    expect(note().hidden).toBe(false);
    expect(note().textContent).toContain('internet connection');
  });
});

describe('asking before an online voice', () => {
  it('sends nothing until the reader allows it', async () => {
    const storage = fakeStorage();
    const { synth } = mount({ storage });
    await select(document.getElementById('yue'));
    await click(playButton());
    expect(synth.spoken).toHaveLength(0);
    expect(note().textContent).toContain('no Cantonese voice');
    expect(note().textContent).toContain('goes to Google');
    expect(storage.data['owl:pronounceOnlineOk']).toBeUndefined();
  });

  it('speaks after Allow, and remembers it', async () => {
    const storage = fakeStorage();
    const { synth, bar } = mount({ storage });
    await select(document.getElementById('yue'));
    await click(playButton());
    await click(noteButton('Allow'));
    expect(synth.spoken).toHaveLength(1);
    expect(synth.spoken[0].text).toBe('銀行');
    expect(synth.spoken[0].voice).toBe(GOOGLE_YUE);
    expect(storage.data['owl:pronounceOnlineOk']).toBe(true);
    expect(note().hidden).toBe(true);
    expect(onlineSwitch().hidden).toBe(false);

    bar.destroy();
    const next = mount({ storage });
    await select(document.getElementById('yue'));
    await click(playButton());
    expect(note().hidden).toBe(true);
    expect(next.synth.spoken).toHaveLength(1);
  });

  it('sends nothing after Not now, and asks again next time', async () => {
    const storage = fakeStorage();
    const { synth } = mount({ storage });
    await select(document.getElementById('yue'));
    await click(playButton());
    await click(noteButton('Not now'));
    expect(synth.spoken).toHaveLength(0);
    expect(storage.data['owl:pronounceOnlineOk']).toBeUndefined();
    await click(playButton());
    expect(noteButton('Allow')).toBeTruthy();
  });

  it('can be turned off again, and then asks again', async () => {
    const storage = fakeStorage({ 'owl:pronounceOnlineOk': true });
    const { synth } = mount({ storage });
    await select(document.getElementById('yue'));
    expect(onlineSwitch().hidden).toBe(false);
    await click(onlineSwitch());
    expect(storage.data['owl:pronounceOnlineOk']).toBe(false);
    expect(onlineSwitch().hidden).toBe(true);
    await click(playButton());
    expect(synth.spoken).toHaveLength(0);
    expect(noteButton('Allow')).toBeTruthy();
  });

  it('never offers the switch where the voice is on the device', async () => {
    mount({ storage: fakeStorage({ 'owl:pronounceOnlineOk': true }) });
    await select(document.getElementById('en'));
    expect(onlineSwitch().hidden).toBe(true);
  });

  it('does not speak an old answer after the bar has moved on', async () => {
    const { synth } = mount();
    await select(document.getElementById('yue'));
    await click(playButton());
    const allow = noteButton('Allow');
    await select(document.getElementById('en'));
    allow.click();
    await settle();
    expect(synth.spoken).toHaveLength(0);
  });
});

describe('a voice chosen in Settings', () => {
  const ADDON = voice('Clara (add-on)', 'en-US', true);
  const GOOGLE_US = voice('Google US English', 'en-US', false);
  const chosen = (name) => fakeStorage({ [VOICE_CHOICE_KEY]: { en: name } });

  it('reads the selection instead of the automatic voice', async () => {
    const { synth } = mount({ voices: [MARK, ADDON], storage: chosen('Clara (add-on)') });
    await select(document.getElementById('en'));
    await click(playButton());
    expect(synth.spoken).toHaveLength(1);
    expect(synth.spoken[0].voice).toBe(ADDON);
    expect(synth.spoken[0].text).toBe('apple');
  });

  it('is left alone for a language it was not chosen for', async () => {
    const tracy = voice('Microsoft Tracy', 'zh-HK', true);
    const { synth } = mount({ voices: [MARK, ADDON, tracy], storage: chosen('Clara (add-on)') });
    await select(document.getElementById('yue'));
    await click(playButton());
    expect(synth.spoken[0].voice).toBe(tracy);
  });

  it('gives way to the automatic voice while it is not installed', async () => {
    const { synth } = mount({ voices: [MARK], storage: chosen('Clara (add-on)') });
    await select(document.getElementById('en'));
    await click(playButton());
    expect(synth.spoken[0].voice).toBe(MARK);
  });

  // An add-on voice usually has a part of its own that must be running.
  it('names the voice when it fails, and points to Settings', async () => {
    const { synth } = mount({ voices: [MARK, ADDON], storage: chosen('Clara (add-on)') });
    await select(document.getElementById('en'));
    await click(playButton());
    synth.spoken[0].onerror({ error: 'synthesis-failed' });
    expect(note().textContent).toBe('"Clara (add-on)" could not read this aloud. Check that it is running, or choose another voice in Settings.');
  });

  it('keeps the plain message for a voice nobody chose', async () => {
    const { synth } = mount({ voices: [MARK, ADDON] });
    await select(document.getElementById('en'));
    await click(playButton());
    synth.spoken[0].onerror({ error: 'synthesis-failed' });
    expect(note().textContent).toBe('Could not read this aloud.');
  });

  // Choosing an online voice is not the same as agreeing to send text with it.
  it('still asks before a chosen online voice sends anything, and says why it is online', async () => {
    const { synth } = mount({ voices: [MARK, GOOGLE_US], storage: chosen('Google US English') });
    await select(document.getElementById('en'));
    await click(playButton());
    expect(synth.spoken).toHaveLength(0);
    expect(note().textContent).toContain('The English voice chosen in Settings is Google');
    expect(note().textContent).toContain('Whatever you select to hear goes to Google.');
    await click(noteButton('Allow'));
    expect(synth.spoken[0].voice).toBe(GOOGLE_US);
  });
});

describe('the voice list', () => {
  it('is shared by every note, so switching notes does not restart its wait', async () => {
    const synth = fakeSynth([GOOGLE_YUE]);
    const options = { root, isActive: () => true, synth, Utterance: FakeUtterance, storage: fakeStorage({ 'owl:pronounceOnlineOk': true }) };
    const asked = vi.spyOn(synth, 'getVoices');
    const first = createPronounceBar(options);
    bars.push(first);
    first.prime();
    const primedOnce = asked.mock.calls.length;
    const second = createPronounceBar(options);
    bars.push(second);
    second.prime();
    expect(asked.mock.calls.length).toBe(primedOnce);
  });
});

describe('without browser speech', () => {
  it('does nothing at all', async () => {
    const bar = createPronounceBar({ root, isActive: () => true, synth: undefined, Utterance: undefined });
    bars.push(bar);
    await select(document.getElementById('en'));
    expect(shownBar()).toBeNull();
    expect(() => { bar.prime(); bar.hide(); }).not.toThrow();
  });
});

describe('in the editor', () => {
  const segmenter = () => (text) => [{ text, reading: 'ˈæp.əl' }];
  let saved;

  beforeEach(() => {
    saved = { synth: globalThis.speechSynthesis, utterance: globalThis.SpeechSynthesisUtterance };
    globalThis.speechSynthesis = fakeSynth([MARK]);
    globalThis.SpeechSynthesisUtterance = FakeUtterance;
    document.body.innerHTML = '<div id="editor-root"></div>';
  });

  afterEach(() => {
    globalThis.speechSynthesis = saved.synth;
    globalThis.SpeechSynthesisUtterance = saved.utterance;
  });

  it('offers it on a word in the preview with readings on, and cleans up when the note closes', async () => {
    const editor = renderEditor(document.getElementById('editor-root'), { body: 'apple', phonetics: { enabled: true, segmenter } });
    const ruby = document.querySelector('.preview-body ruby');
    expect(ruby).toBeTruthy();
    await select(ruby);
    expect(shownBar()).toBeTruthy();
    editor.destroy();
    expect(shownBar()).toBeNull();
  });

  it('offers nothing with readings off', async () => {
    const editor = renderEditor(document.getElementById('editor-root'), { body: 'apple', phonetics: { enabled: false, segmenter } });
    await select(document.querySelector('.preview-body'));
    expect(shownBar()).toBeNull();
    editor.destroy();
  });
});
