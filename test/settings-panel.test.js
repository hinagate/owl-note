import { describe, it, expect, afterEach, vi } from 'vitest';
import { showSettings } from '../src/app/settings-panel.js';
import { VOICE_CHOICE_KEY } from '../src/lib/pronounce.js';
import { THEME_KEY } from '../src/lib/theme.js';
import { MIC_CHOICE_KEY } from '../src/lib/voice-take.js';

const voice = (name, lang, localService) => ({ name, lang, localService, default: false });
const MARK = voice('Microsoft Mark', 'en-US', true);
const ADDON = voice('Clara (add-on)', 'en-US', true); // a voice an add-on installed
const GOOGLE_US = voice('Google US English', 'en-US', false);
const GOOGLE_JA = voice('Google 日本語', 'ja-JP', false);
const HANHAN = voice('Microsoft Hanhan', 'zh-TW', true);

class FakeUtterance {
  constructor(text) { this.text = text; }
}

function fakeSynth(voices) {
  const synth = new EventTarget();
  synth.list = voices;
  synth.spoken = [];
  synth.cancelled = 0;
  synth.getVoices = () => synth.list;
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

function fakeThemeStore(initial = {}) {
  const data = { ...initial };
  return { data, getItem: (key) => (key in data ? data[key] : null), setItem: (key, value) => { data[key] = value; } };
}

const settle = async () => { for (let i = 0; i < 6; i += 1) await new Promise((r) => { setTimeout(r, 0); }); };

let panels = [];
async function open({ voices = [MARK, ADDON, GOOGLE_US, GOOGLE_JA, HANHAN], storage = fakeStorage(), themeStore = fakeThemeStore() } = {}) {
  const synth = fakeSynth(voices);
  const panel = showSettings({ synth, Utterance: FakeUtterance, storage, themeStore });
  panels.push(panel);
  await settle();
  return { synth, storage, themeStore, panel };
}

const dialog = () => document.querySelector('.settings-dialog');
const select = (lang) => document.getElementById(`settings-voice-${lang}`);
const options = (lang) => [...select(lang).options].map((o) => o.textContent);
const testButton = (lang) => select(lang).parentElement.querySelector('.settings-voice-test');
const note = () => document.querySelector('.settings-note');
const choose = async (lang, value) => {
  select(lang).value = value;
  select(lang).dispatchEvent(new Event('change', { bubbles: true }));
  await settle();
};

afterEach(() => {
  panels.forEach((panel) => panel.close());
  panels = [];
  delete document.documentElement.dataset.theme;
  vi.useRealTimers();
});

describe('opening and closing', () => {
  it('opens as a dialog and closes on Escape', async () => {
    await open();
    expect(dialog().getAttribute('role')).toBe('dialog');
    expect(dialog().querySelector('h2').textContent).toBe('Settings');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(dialog()).toBeNull();
  });

  it('closes on its own close button and gives focus back', async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    await open();
    document.querySelector('.settings-close').click();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('never shows two at once', async () => {
    await open();
    await open();
    expect(document.querySelectorAll('.settings-dialog')).toHaveLength(1);
  });
});

describe('appearance', () => {
  it('shows the theme in use', async () => {
    await open({ themeStore: fakeThemeStore({ [THEME_KEY]: 'dark' }) });
    expect(dialog().querySelector('input[name="owl-theme"]:checked').value).toBe('dark');
  });

  it('is light for someone who never chose', async () => {
    await open();
    expect(dialog().querySelector('input[name="owl-theme"]:checked').value).toBe('light');
  });

  it('changes the page at once and remembers the choice', async () => {
    const { themeStore } = await open();
    const dark = dialog().querySelector('input[value="dark"]');
    dark.checked = true;
    dark.dispatchEvent(new Event('change', { bubbles: true }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(themeStore.data[THEME_KEY]).toBe('dark');
  });
});

describe('choosing a voice', () => {
  it('offers each language the voices that can read it, add-ons included', async () => {
    await open();
    expect(options('en')).toEqual([
      'Automatic (Microsoft Mark)',
      'Microsoft Mark',
      'Clara (add-on)',
      'Google US English (online, sends the words to Google)',
    ]);
    expect(options('ja')).toEqual(['Automatic (Google 日本語)', 'Google 日本語 (online, sends the words to Google)']);
  });

  // The readings are Jyutping; a Mandarin voice must not be offered for them.
  it('offers no Mandarin voice for Cantonese', async () => {
    await open();
    expect(options('yue')).toEqual(['Automatic (no voice found)']);
  });

  it('saves the choice for that language only', async () => {
    const { storage } = await open();
    await choose('en', 'Clara (add-on)');
    expect(storage.data[VOICE_CHOICE_KEY]).toEqual({ en: 'Clara (add-on)' });
  });

  it('goes back to automatic', async () => {
    const { storage } = await open({ storage: fakeStorage({ [VOICE_CHOICE_KEY]: { en: 'Clara (add-on)', ja: 'Google 日本語' } }) });
    expect(select('en').value).toBe('Clara (add-on)');
    await choose('en', '');
    expect(storage.data[VOICE_CHOICE_KEY]).toEqual({ ja: 'Google 日本語' });
  });

  // An add-on that is switched off for the moment has not been un-chosen.
  it('keeps a chosen voice that is not listed just now', async () => {
    await open({ voices: [MARK], storage: fakeStorage({ [VOICE_CHOICE_KEY]: { en: 'Clara (add-on)' } }) });
    expect(select('en').value).toBe('Clara (add-on)');
    expect(options('en')).toContain('Clara (add-on) (not available now)');
  });

  it('fills in voices that the browser lists late', async () => {
    const { synth } = await open({ voices: [MARK] });
    expect(options('en')).not.toContain('Clara (add-on)');
    synth.list = [MARK, ADDON];
    synth.dispatchEvent(new Event('voiceschanged'));
    expect(options('en')).toContain('Clara (add-on)');
  });
});

describe('playing a sample', () => {
  it('speaks a line in the chosen voice', async () => {
    const { synth } = await open();
    await choose('en', 'Clara (add-on)');
    testButton('en').click();
    expect(synth.spoken).toHaveLength(1);
    expect(synth.spoken[0].voice).toBe(ADDON);
    expect(synth.spoken[0].text).toBe('This is the voice for English.');
  });

  it('uses the automatic voice when nothing is chosen', async () => {
    const { synth } = await open();
    testButton('en').click();
    expect(synth.spoken[0].voice).toBe(MARK);
  });

  it('shows while it is speaking', async () => {
    const { synth } = await open();
    testButton('en').click();
    synth.spoken[0].onstart();
    expect(testButton('en').classList.contains('speaking')).toBe(true);
    synth.spoken[0].onend();
    expect(testButton('en').classList.contains('speaking')).toBe(false);
  });

  it('says so when a language has no voice', async () => {
    const { synth } = await open();
    testButton('yue').click();
    expect(synth.spoken).toHaveLength(0);
    expect(note().textContent).toBe('This computer has no Cantonese voice.');
  });

  it('says which voice failed', async () => {
    const { synth } = await open();
    await choose('en', 'Clara (add-on)');
    testButton('en').click();
    synth.spoken[0].onerror({ error: 'synthesis-failed' });
    expect(note().textContent).toBe('"Clara (add-on)" could not play the sample. Check that it is running.');
  });

  it('gives up on a voice that never starts', async () => {
    vi.useFakeTimers();
    const synth = fakeSynth([MARK, ADDON]);
    panels.push(showSettings({ synth, Utterance: FakeUtterance, storage: fakeStorage(), themeStore: fakeThemeStore() }));
    await vi.advanceTimersByTimeAsync(10);
    testButton('en').click();
    await vi.advanceTimersByTimeAsync(8000);
    expect(note().textContent).toContain('could not play the sample');
    expect(synth.cancelled).toBeGreaterThan(0);
  });

  it('says so when the chosen voice is missing and the automatic one is heard instead', async () => {
    const { synth } = await open({ voices: [MARK], storage: fakeStorage({ [VOICE_CHOICE_KEY]: { en: 'Clara (add-on)' } }) });
    testButton('en').click();
    expect(synth.spoken[0].voice).toBe(MARK);
    expect(note().textContent).toBe('"Clara (add-on)" is not available now, so this is the automatic voice.');
  });

  it('stops the sample when Settings closes', async () => {
    const { synth, panel } = await open();
    testButton('en').click();
    panel.close();
    expect(synth.cancelled).toBeGreaterThan(0);
  });
});

describe('choosing a microphone', () => {
  const HEADSET = { id: 'a1', label: 'Headset (USB)' };
  const WEBCAM = { id: 'b2', label: 'Webcam' };
  // A browser with microphones. It names them only once one has been opened, unless
  // `allowed` says the page was allowed before.
  function fakeMics({ devices = [HEADSET, WEBCAM], allowed = true, failWith = null, missing = [] } = {}) {
    const state = { allowed, opened: [], tracksStopped: 0, contextsClosed: 0, level: 0.1, devices };
    const media = new EventTarget();
    media.enumerateDevices = async () => {
      const name = (label) => (state.allowed ? label : '');
      const first = state.devices[0];
      return [
        ...(first ? [{ kind: 'audioinput', deviceId: state.allowed ? 'default' : '', label: name(`Default - ${first.label}`) }] : []),
        ...state.devices.map((d) => ({ kind: 'audioinput', deviceId: state.allowed ? d.id : '', label: name(d.label) })),
        { kind: 'audiooutput', deviceId: 'out', label: name('Speakers') },
      ];
    };
    media.getUserMedia = async (constraints) => {
      if (failWith) throw failWith;
      const id = constraints.audio.deviceId?.exact || null;
      if (id && missing.includes(id)) throw Object.assign(new Error('x'), { name: 'OverconstrainedError' });
      state.opened.push(id);
      state.allowed = true;
      const track = { stop() { state.tracksStopped += 1; } };
      return { getTracks: () => [track], getAudioTracks: () => [track] };
    };
    class Context {
      createAnalyser() { return { fftSize: 0, getFloatTimeDomainData(samples) { samples.fill(state.level); } }; }
      createMediaStreamSource() { return { connect() {} }; }
      close() { state.contextsClosed += 1; return Promise.resolve(); }
    }
    return { scope: { navigator: { mediaDevices: media }, AudioContext: Context }, state, media };
  }
  async function openWith(mics, storage = fakeStorage()) {
    const panel = showSettings({ synth: fakeSynth([MARK]), Utterance: FakeUtterance, storage, themeStore: fakeThemeStore(), scope: mics.scope });
    panels.push(panel);
    await settle();
    return { storage, panel };
  }
  const micSelect = () => document.getElementById('settings-mic');
  const micOptions = () => [...micSelect().options].map((o) => o.textContent);
  const micTest = () => document.querySelector('.settings-mic-test');
  const micLevel = () => document.querySelector('.settings-mic-level');
  const micNote = () => micSelect().closest('.settings-group').querySelector('.settings-note');
  const pick = async (value) => {
    micSelect().value = value;
    micSelect().dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
  };
  const moment = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

  it('lists the microphones by name, after the system default', async () => {
    await openWith(fakeMics());
    expect(micOptions()).toEqual(['System default (Headset (USB))', 'Headset (USB)', 'Webcam']);
    expect(micSelect().value).toBe('');
    expect(micNote().hidden).toBe(true);
  });

  it('saves the one chosen, on this device, and goes back to the default', async () => {
    const { storage } = await openWith(fakeMics());
    await pick('b2');
    expect(storage.data[MIC_CHOICE_KEY]).toEqual({ id: 'b2', label: 'Webcam' });
    await pick('');
    expect(storage.data[MIC_CHOICE_KEY]).toBeNull();
  });

  it('shows the one chosen before', async () => {
    await openWith(fakeMics(), fakeStorage({ [MIC_CHOICE_KEY]: { id: 'b2', label: 'Webcam' } }));
    expect(micSelect().value).toBe('b2');
  });

  // Unplugged for now is not forgotten: it is used again as soon as it is back.
  it('keeps a chosen microphone that is not connected just now', async () => {
    const { storage } = await openWith(fakeMics(), fakeStorage({ [MIC_CHOICE_KEY]: { id: 'z9', label: 'Desk microphone' } }));
    expect(micOptions()).toEqual(['System default (Headset (USB))', 'Headset (USB)', 'Webcam', 'Desk microphone (not connected now)']);
    expect(micSelect().value).toBe('z9');
    // Choosing it again saves its own name, not the note beside it.
    await pick('z9');
    expect(storage.data[MIC_CHOICE_KEY]).toEqual({ id: 'z9', label: 'Desk microphone' });
  });

  it('says why there are no names before the microphone has been allowed', async () => {
    await openWith(fakeMics({ allowed: false }));
    expect(micOptions()).toEqual(['System default']);
    expect(micNote().textContent).toBe('The browser names your microphones once you have allowed OWL-Note to use one. Press the microphone button to allow it.');
  });

  it('tests the microphone with a level that moves, and can then name them all', async () => {
    const mics = fakeMics({ allowed: false });
    await openWith(mics);
    expect(micLevel().hidden).toBe(true);
    micTest().click();
    await settle();
    expect(mics.state.opened).toEqual([null]);
    expect(micLevel().hidden).toBe(false);
    expect(micTest().classList.contains('speaking')).toBe(true);
    expect(micNote().textContent).toBe('Say something: the bar should move.');
    await moment(90);
    expect(parseInt(micLevel().firstElementChild.style.width, 10)).toBe(40); // a level of 0.1
    mics.state.level = 0.5;
    await moment(90);
    expect(micLevel().firstElementChild.style.width).toBe('100%');
    expect(micOptions()).toEqual(['System default (Headset (USB))', 'Headset (USB)', 'Webcam']);
    // A second press closes the microphone again.
    micTest().click();
    await settle();
    expect(mics.state.tracksStopped).toBe(1);
    expect(mics.state.contextsClosed).toBe(1);
    expect(micLevel().hidden).toBe(true);
    expect(micTest().classList.contains('speaking')).toBe(false);
  });

  it('opens the microphone once, however fast the button is pressed twice', async () => {
    const mics = fakeMics();
    await openWith(mics);
    micTest().click();
    micTest().click();
    await settle();
    expect(mics.state.opened).toHaveLength(1);
  });

  it('tests the one that is chosen', async () => {
    const mics = fakeMics();
    await openWith(mics);
    await pick('b2');
    micTest().click();
    await settle();
    expect(mics.state.opened).toEqual(['b2']);
  });

  it('closes the microphone by itself after a few seconds', async () => {
    const mics = fakeMics();
    await openWith(mics);
    vi.useFakeTimers();
    micTest().click();
    await vi.advanceTimersByTimeAsync(100);
    expect(micLevel().hidden).toBe(false);
    await vi.advanceTimersByTimeAsync(6000);
    expect(mics.state.tracksStopped).toBe(1);
    expect(micLevel().hidden).toBe(true);
  });

  it('closes the microphone when Settings closes, or another is chosen', async () => {
    const mics = fakeMics();
    const { panel } = await openWith(mics);
    micTest().click();
    await settle();
    await pick('b2');
    expect(mics.state.tracksStopped).toBe(1);
    micTest().click();
    await settle();
    panel.close();
    expect(mics.state.tracksStopped).toBe(2);
  });

  it('says how to allow the microphone when the browser has it blocked', async () => {
    await openWith(fakeMics({ failWith: Object.assign(new Error('x'), { name: 'NotAllowedError' }) }));
    micTest().click();
    await settle();
    expect(micNote().textContent).toBe('OWL-Note is not allowed to use the microphone. Allow it for this page in the browser\'s site settings, then try again.');
    expect(micLevel().hidden).toBe(true);
  });

  it('says so when the chosen one is missing and the default is heard instead', async () => {
    const mics = fakeMics({ missing: ['z9'] });
    await openWith(mics, fakeStorage({ [MIC_CHOICE_KEY]: { id: 'z9', label: 'Desk microphone' } }));
    micTest().click();
    await settle();
    expect(mics.state.opened).toEqual([null]);
    expect(micNote().textContent).toBe('"Desk microphone" was not found, so this is the computer\'s default microphone. Say something: the bar should move.');
  });

  it('lists a microphone that is plugged in while Settings is open', async () => {
    const mics = fakeMics();
    await openWith(mics);
    mics.state.devices = [HEADSET, WEBCAM, { id: 'c3', label: 'Desk microphone' }];
    mics.media.dispatchEvent(new Event('devicechange'));
    await settle();
    expect(micOptions()).toEqual(['System default (Headset (USB))', 'Headset (USB)', 'Webcam', 'Desk microphone']);
  });

  it('says so where the browser has no microphone to give', async () => {
    await openWith({ scope: {} });
    expect(micOptions()).toEqual(['System default']);
    expect(micNote().textContent).toBe('This browser gives OWL-Note no microphone to use.');
  });
});

describe('without browser speech', () => {
  it('still opens, for the theme', async () => {
    panels.push(showSettings({ synth: undefined, Utterance: undefined, storage: fakeStorage(), themeStore: fakeThemeStore() }));
    await settle();
    expect(options('en')).toEqual(['Automatic (no voice found)']);
    testButton('en').click();
    expect(note().textContent).toBe('This computer has no English voice.');
  });
});
