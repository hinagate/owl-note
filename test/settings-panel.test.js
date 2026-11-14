import { describe, it, expect, afterEach, vi } from 'vitest';
import { showSettings } from '../src/app/settings-panel.js';
import { VOICE_CHOICE_KEY } from '../src/lib/pronounce.js';
import { THEME_KEY } from '../src/lib/theme.js';

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

describe('without browser speech', () => {
  it('still opens, for the theme', async () => {
    panels.push(showSettings({ synth: undefined, Utterance: undefined, storage: fakeStorage(), themeStore: fakeThemeStore() }));
    await settle();
    expect(options('en')).toEqual(['Automatic (no voice found)']);
    testButton('en').click();
    expect(note().textContent).toBe('This computer has no English voice.');
  });
});
