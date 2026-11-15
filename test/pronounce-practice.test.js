import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The microphone and the recogniser are replaced here; lib/voice-take.js itself is tested
// in voice-take.test.js. What this file is about is what the bar does with a take.
const take = vi.hoisted(() => ({ readiness: 'available', started: [], installs: [], second: '', decodeFails: false }));
vi.mock('../src/lib/voice-take.js', () => ({
  SPEECH_TAGS: { en: 'en-US', ja: 'ja-JP' },
  speechReadiness: vi.fn(async () => take.readiness),
  installSpeech: vi.fn(async (lang) => { take.installs.push(lang); take.readiness = 'available'; return true; }),
  startTake: vi.fn((options) => {
    const handle = { options, stopped: false };
    handle.done = new Promise((resolve, reject) => { handle.finish = resolve; handle.fail = reject; });
    handle.stop = () => { handle.stopped = true; };
    take.started.push(handle);
    return handle;
  }),
  decodeTake: vi.fn(async () => { if (take.decodeFails) throw new Error('unreadable'); return new Float32Array(16000); }),
  recogniseRecording: vi.fn(async () => take.second),
  readMicChoice: vi.fn(async (storage) => (await storage?.get('owl:microphone'))?.['owl:microphone'] || null),
}));

const { createPronounceBar } = await import('../src/app/pronounce-bar.js');
const { createVoiceSource, MAX_PRACTICE_CHARS } = await import('../src/lib/pronounce.js');
const voiceTake = await import('../src/lib/voice-take.js');

const voice = (name, lang, localService) => ({ name, lang, localService, default: false });
const MARK = voice('Microsoft Mark', 'en-US', true);
class FakeUtterance { constructor(text) { this.text = text; } }
function fakeSynth() {
  const synth = new EventTarget();
  synth.spoken = [];
  synth.cancelled = 0;
  synth.getVoices = () => [MARK];
  synth.cancel = () => { synth.cancelled += 1; };
  synth.speak = (utterance) => { synth.spoken.push(utterance); };
  return synth;
}
function fakeStorage(initial = {}) {
  const data = { ...initial };
  return { data, get: async (key) => ({ [key]: data[key] }), set: async (values) => { Object.assign(data, values); } };
}
// A browser with a microphone.
const micScope = () => ({ navigator: { mediaDevices: { getUserMedia() {} } }, MediaRecorder: function Recorder() {} });

const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise((r) => { setTimeout(r, 0); }); };
let root;
let bars;
function mount({ storage = fakeStorage(), scope = micScope(), readingOf = null, segmenter = null } = {}) {
  const synth = fakeSynth();
  const bar = createPronounceBar({
    root, isActive: () => true, synth, Utterance: FakeUtterance, storage, voiceSource: createVoiceSource(synth, { settleMs: 0 }),
    scope, readingOf, segmenter,
  });
  bars.push(bar);
  return { synth, storage, bar };
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
const $ = (selector) => document.querySelector(selector);
const mic = () => $('.pronounce-mic');
const note = () => $('.pronounce-note');
const noteButton = (label) => [...document.querySelectorAll('.pronounce-note button')].find((b) => b.textContent === label);
const click = async (el) => { el.click(); await settle(); };
const blob = new Blob(['x'], { type: 'audio/webm' });
const finish = async (handle, result) => {
  handle.finish({ blob, heard: '', recognised: true, problem: null, seconds: 2, ended: 'quiet', ...result });
  await settle();
};
const lastTake = () => take.started[take.started.length - 1];

beforeEach(() => {
  take.readiness = 'available';
  take.started = [];
  take.installs = [];
  take.second = '';
  take.decodeFails = false;
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:take');
  globalThis.URL.revokeObjectURL = vi.fn();
  document.body.innerHTML = `<div id="root">
    <p id="en"><ruby>the<rt>ðə</rt></ruby> <ruby>light<rt>laɪt</rt></ruby></p>
    <p id="yue"><ruby lang="yue">銀<rt>ngan4</rt></ruby><ruby lang="yue">行<rt>hong4</rt></ruby></p>
    <p id="ja"><ruby lang="ja">今日<rt>きょう</rt></ruby>は</p>
    <p id="long"></p>
  </div>`;
  root = document.getElementById('root');
  bars = [];
});
afterEach(() => {
  bars.forEach((bar) => bar.destroy());
  window.getSelection().removeAllRanges();
});

describe('the microphone button', () => {
  it('sits beside the speaker for a language the browser can recognise', async () => {
    mount();
    await select(document.getElementById('en'));
    expect(mic().hidden).toBe(false);
    expect(mic().getAttribute('aria-label')).toBe('Say it yourself');
    await select(document.getElementById('ja'));
    expect(mic().hidden).toBe(false);
  });

  // Chrome has no on-device Cantonese recogniser.
  it('is not offered for Cantonese', async () => {
    mount();
    await select(document.getElementById('yue'));
    expect(mic().hidden).toBe(true);
  });

  it('is not offered where the browser has no microphone to give', async () => {
    mount({ scope: {} });
    await select(document.getElementById('en'));
    expect(mic().hidden).toBe(true);
  });

  it('asks for a paragraph or less', async () => {
    mount();
    const long = document.getElementById('long');
    long.textContent = 'a'.repeat(MAX_PRACTICE_CHARS + 1);
    await select(long);
    await click(mic());
    expect(take.started).toHaveLength(0);
    expect(note().textContent).toBe('This is too long to say in one go. Select up to 1,000 characters, about a paragraph.');
  });
});

// Reported with this very passage: at 225 characters it was refused as "more than a sentence".
describe('a passage', () => {
  const PASSAGE = '• Global disruption: Outage reports “reached 74 countries and territories in about an hour,” '
    + 'according to Downdetector. While some workers scrambled to find workarounds, others expressed relief '
    + 'in a respite from the work grind.';

  it('can be said in one take, with time to say it slowly', async () => {
    mount();
    const long = document.getElementById('long');
    long.textContent = PASSAGE;
    await select(long);
    await click(mic());
    expect(take.started).toHaveLength(1);
    expect(lastTake().options.maxMs).toBeGreaterThan(40000);
  });

  // A reader stops to breathe between sentences, or to work out a word like Downdetector.
  it('is not cut off at a breath between sentences, as a single phrase would be', async () => {
    mount();
    const long = document.getElementById('long');
    long.textContent = PASSAGE;
    await select(long);
    await click(mic());
    expect(lastTake().options.quietMs).toBe(2500);
    await click(mic()); // stop
    await finish(lastTake(), { heard: 'global disruption' });
    await select(document.getElementById('en'));
    await click(mic());
    expect(lastTake().options.quietMs).toBe(1400);
  });

  it('has every word of it compared', async () => {
    mount();
    const long = document.getElementById('long');
    long.textContent = PASSAGE;
    await select(long);
    await click(mic());
    await finish(lastTake(), { heard: PASSAGE.replace('respite', 'rest bite'), seconds: 21 });
    expect($('.practice-summary').textContent).toMatch(/^\d+ of 3\d words were heard\.$/);
    expect(document.querySelectorAll('.practice-word').length).toBeGreaterThan(30);
  });

  // Playing it to the recogniser again takes as long as the take did.
  it('is not played to the recogniser a second time when it is long', async () => {
    mount();
    const long = document.getElementById('long');
    long.textContent = PASSAGE;
    await select(long);
    await click(mic());
    const before = voiceTake.recogniseRecording.mock.calls.length;
    await finish(lastTake(), { heard: '', seconds: 45 });
    expect(voiceTake.recogniseRecording.mock.calls.length).toBe(before);
    expect($('.practice-summary').textContent).toMatch(/^Recorded, but the words could not be made out/);
  });
});

describe('the microphone chosen in Settings', () => {
  it('is the one recorded with', async () => {
    mount({ storage: fakeStorage({ 'owl:microphone': { id: 'mic-2', label: 'USB microphone' } }) });
    await select(document.getElementById('en'));
    await click(mic());
    expect(lastTake().options.deviceId).toBe('mic-2');
  });

  it('is the computer\'s default when none was chosen', async () => {
    mount();
    await select(document.getElementById('en'));
    await click(mic());
    expect(lastTake().options.deviceId).toBeNull();
  });

  // Better a take on the wrong microphone than none, but the reader should know.
  it('is named when it was not found and the default was recorded instead', async () => {
    mount({ storage: fakeStorage({ 'owl:microphone': { id: 'mic-2', label: 'USB microphone' } }) });
    await select(document.getElementById('en'));
    await click(mic());
    await finish(lastTake(), { heard: 'the light', usedDefault: true });
    expect($('.practice-summary').textContent).toBe('Every word was heard.');
    expect(note().textContent).toBe('"USB microphone" was not found, so the computer\'s default microphone was used.');
  });

  it('is not mentioned when it was the one recorded', async () => {
    mount({ storage: fakeStorage({ 'owl:microphone': { id: 'mic-2', label: 'USB microphone' } }) });
    await select(document.getElementById('en'));
    await click(mic());
    await finish(lastTake(), { heard: 'the light', usedDefault: false });
    expect(note().hidden).toBe(true);
  });
});

describe('a take', () => {
  it('listens, with the button turned into Stop', async () => {
    mount();
    await select(document.getElementById('en'));
    await click(mic());
    expect(take.started).toHaveLength(1);
    expect(lastTake().options.lang).toBe('en');
    expect(lastTake().options.recognise).toBe(true);
    expect(mic().classList.contains('recording')).toBe(true);
    expect(mic().getAttribute('aria-label')).toBe('Stop');
    expect($('.practice-status').textContent).toBe('Listening… say it now.');
  });

  it('shows the words as the recogniser writes them', async () => {
    mount();
    await select(document.getElementById('en'));
    await click(mic());
    lastTake().options.onInterim('the');
    expect($('.practice-status').textContent).toBe('the');
  });

  it('stops on a second press', async () => {
    mount();
    await select(document.getElementById('en'));
    await click(mic());
    await click(mic());
    expect(lastTake().stopped).toBe(true);
    expect(take.started).toHaveLength(1);
  });

  it('shows what was heard against what was meant', async () => {
    mount();
    await select(document.getElementById('en'));
    await click(mic());
    await finish(lastTake(), { heard: 'The night.' });
    expect($('.practice-summary').textContent).toBe('1 of 2 words were heard.');
    expect(document.querySelectorAll('.practice-word')[1].title).toBe('Heard as “night”');
    expect(mic().classList.contains('recording')).toBe(false);
    expect(mic().getAttribute('aria-label')).toBe('Say it yourself');
  });

  it('gives the voice a turn first: the speaker is stopped before the microphone opens', async () => {
    const { synth } = mount();
    await select(document.getElementById('en'));
    await click($('.pronounce-play'));
    const before = synth.cancelled;
    await click(mic());
    expect(synth.cancelled).toBeGreaterThan(before);
  });

  // The voice would be recorded over the take.
  it('is dropped when the speaker is pressed while it is running', async () => {
    mount();
    await select(document.getElementById('en'));
    await click(mic());
    const handle = lastTake();
    await click($('.pronounce-play'));
    expect(handle.stopped).toBe(true);
    await finish(handle, { heard: 'the light' });
    expect($('.practice-summary')).toBeNull();
    expect(mic().classList.contains('recording')).toBe(false);
  });

  it('closes the microphone when the bar closes, and shows nothing afterwards', async () => {
    mount();
    await select(document.getElementById('en'));
    await click(mic());
    const handle = lastTake();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(handle.stopped).toBe(true);
    await finish(handle, { heard: 'the light' });
    expect($('.pronounce-bar')).toBeNull();
  });

  it('starts over on Again', async () => {
    mount();
    await select(document.getElementById('en'));
    await click(mic());
    await finish(lastTake(), { heard: 'the light' });
    await click($('.practice-again'));
    expect(take.started).toHaveLength(2);
  });

  it('takes two spellings of one spoken word as heard', async () => {
    const readings = { their: 'ðɛr', there: 'ðɛr', the: 'ðə', light: 'laɪt', lite: 'laɪt' };
    mount({ readingOf: (word) => readings[word] || null });
    await select(document.getElementById('en'));
    await click(mic());
    await finish(lastTake(), { heard: 'the lite' });
    expect($('.practice-summary').textContent).toBe('Every word was heard.');
  });

  it('compares Japanese by its reading', async () => {
    const segment = (text) => (text === '今日は'
      ? [{ text: '今日', reading: 'きょう' }, { text: 'は', reading: null }]
      : [{ text, reading: null }]);
    mount({ segmenter: () => segment });
    await select(document.getElementById('ja'));
    await click(mic());
    expect(lastTake().options.lang).toBe('ja');
    await finish(lastTake(), { heard: 'きょうは' });
    expect($('.practice-summary').textContent).toBe('Every word was heard.');
  });
});

describe('when a take cannot be made or made out', () => {
  it('says so when nothing was heard', async () => {
    mount();
    await select(document.getElementById('en'));
    await click(mic());
    await finish(lastTake(), { ended: 'nothing' });
    expect(note().textContent).toBe('Nothing was heard. Check the microphone and try again.');
    expect($('.practice-summary')).toBeNull();
  });

  it('says how to allow the microphone when it is blocked', async () => {
    mount();
    await select(document.getElementById('en'));
    await click(mic());
    lastTake().fail(Object.assign(new Error('denied'), { code: 'mic-blocked' }));
    await settle();
    expect(note().textContent).toContain('not allowed to use the microphone');
    expect(mic().classList.contains('recording')).toBe(false);
  });

  it('says so when there is no microphone', async () => {
    mount();
    await select(document.getElementById('en'));
    await click(mic());
    lastTake().fail(Object.assign(new Error('none'), { code: 'no-mic' }));
    await settle();
    expect(note().textContent).toBe('No microphone was found on this computer.');
  });

  // Chrome's recogniser can still be starting when the take ends. That is not the
  // speaker missing every word, so the recording is played to it again.
  it('listens to the recording again when the recogniser wrote nothing', async () => {
    mount();
    take.second = 'the light';
    await select(document.getElementById('en'));
    await click(mic());
    await finish(lastTake(), { heard: '' });
    expect($('.practice-summary').textContent).toBe('Every word was heard.');
  });

  it('does not blame the speaker when it wrote nothing the second time either', async () => {
    mount();
    await select(document.getElementById('en'));
    await click(mic());
    await finish(lastTake(), { heard: '' });
    expect($('.practice-summary').textContent).toContain('could not be made out');
    expect($('.practice-word')).toBeNull();
    expect($('.practice-play')).toBeTruthy();
  });

  it('still shows the words when the recording cannot be read back for its melody', async () => {
    mount();
    take.decodeFails = true;
    await select(document.getElementById('en'));
    await click(mic());
    await finish(lastTake(), { heard: 'the light' });
    expect($('.practice-summary').textContent).toBe('Every word was heard.');
    expect($('.practice-melody')).toBeNull();
  });
});

describe('the speech pack', () => {
  it('asks before downloading it, then records', async () => {
    mount();
    take.readiness = 'downloadable';
    await select(document.getElementById('en'));
    await click(mic());
    expect(take.started).toHaveLength(0);
    expect(note().textContent).toContain('needs Chrome\'s English speech pack on this computer');
    expect(note().textContent).toContain('never leaves the device');
    await click(noteButton('Download'));
    expect(take.installs).toEqual(['en']);
    expect(take.started).toHaveLength(1);
    expect(lastTake().options.recognise).toBe(true);
  });

  it('can record without it', async () => {
    mount();
    take.readiness = 'downloadable';
    await select(document.getElementById('en'));
    await click(mic());
    await click(noteButton('Just record'));
    expect(take.installs).toEqual([]);
    expect(lastTake().options.recognise).toBe(false);
    await finish(lastTake(), { recognised: false });
    expect($('.practice-summary').textContent).toBe('Recorded. This browser cannot check the words on this device.');
  });

  // "Again" is the same take again: someone who chose to just record is not asked twice.
  it('does not ask again on Again, after Just record', async () => {
    take.readiness = 'downloadable';
    mount();
    await select(document.getElementById('en'));
    await click(mic());
    await click(noteButton('Just record'));
    await finish(lastTake(), { recognised: false });
    await click($('.practice-again'));
    expect(take.started).toHaveLength(2);
    expect(lastTake().options.recognise).toBe(false);
    // The microphone button itself still offers the word check.
    await click(mic()); // stop
    await finish(lastTake(), { recognised: false });
    await click(mic());
    expect(take.started).toHaveLength(2);
    expect(note().textContent).toMatch(/speech pack/);
  });

  it('waits while Chrome is still downloading it', async () => {
    mount();
    take.readiness = 'downloading';
    await select(document.getElementById('en'));
    await click(mic());
    expect(take.started).toHaveLength(0);
    expect(note().textContent).toBe('Chrome is still downloading the speech pack. Try again in a moment.');
  });

  it('records without the word check where the browser has no recogniser', async () => {
    mount();
    take.readiness = 'unsupported';
    await select(document.getElementById('en'));
    await click(mic());
    expect(lastTake().options.recognise).toBe(false);
  });
});
