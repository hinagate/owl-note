// Settings, opened from the gear at the end of the toolbar: how the app looks, which voice
// reads a selection aloud under Phonetic Assistance, and which microphone hears the
// reader say it back.
//
// The voices offered are the ones the browser lists: the computer's own, the browser's
// online ones, and any that a voice add-on has installed. OWL-Note loads no voice itself.

import {
  VOICE_CHOICE_KEY, VOICE_LANGS, languageName, pickVoice, readVoiceChoices, voiceProvider, voicesFor,
} from '../lib/pronounce.js';
import { readTheme, setTheme } from '../lib/theme.js';
import { MIC_CHOICE_KEY, listMicrophones, openMicrophone, readMicChoice } from '../lib/voice-take.js';

const THEME_LABELS = [['light', 'Light'], ['dark', 'Dark'], ['system', 'Match system']];
// A line in each language, so the sample is heard the way a selection would be.
const SAMPLES = {
  en: 'This is the voice for English.',
  ja: 'これは日本語の音声です。',
  yue: '呢個係廣東話嘅聲音。',
};
const START_TIMEOUT_MS = 8000;
const MIC_TEST_MS = 6000; // long enough to say a few words and watch the level move

let activeClose = null;

function playIcon() {
  const SVG = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', 'M8 5.5v13l10.5-6.5L8 5.5z');
  path.setAttribute('fill', 'currentColor');
  svg.append(path);
  return svg;
}

function micIcon() {
  const SVG = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  const capsule = document.createElementNS(SVG, 'rect');
  capsule.setAttribute('x', '9');
  capsule.setAttribute('y', '3');
  capsule.setAttribute('width', '6');
  capsule.setAttribute('height', '11');
  capsule.setAttribute('rx', '3');
  capsule.setAttribute('fill', 'currentColor');
  const stand = document.createElementNS(SVG, 'path');
  stand.setAttribute('d', 'M6 11a6 6 0 0 0 12 0M12 17v4');
  stand.setAttribute('fill', 'none');
  stand.setAttribute('stroke', 'currentColor');
  stand.setAttribute('stroke-width', '2');
  stand.setAttribute('stroke-linecap', 'round');
  svg.append(capsule, stand);
  return svg;
}

const optionLabel = (voice) => {
  if (voice.localService) return voice.name;
  const provider = voiceProvider(voice);
  return `${voice.name} (online${provider ? `, sends the words to ${provider}` : ''})`;
};

/**
 * @param {{ synth?: SpeechSynthesis, Utterance?: typeof SpeechSynthesisUtterance,
 *   storage?: chrome.storage.StorageArea, themeStore?: Storage, scope?: typeof globalThis }} [options]
 *   `scope` is where the microphones are found (navigator.mediaDevices, AudioContext)
 */
export function showSettings({
  synth = globalThis.speechSynthesis,
  Utterance = globalThis.SpeechSynthesisUtterance,
  storage = globalThis.chrome?.storage?.local,
  themeStore = globalThis.localStorage,
  scope = globalThis,
} = {}) {
  activeClose?.();

  const backdrop = document.createElement('div');
  backdrop.className = 'settings-backdrop';
  const dialog = document.createElement('section');
  dialog.className = 'settings-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'settings-title');

  const header = document.createElement('header');
  const heading = document.createElement('h2');
  heading.id = 'settings-title';
  heading.textContent = 'Settings';
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'settings-close';
  closeButton.textContent = '×';
  closeButton.setAttribute('aria-label', 'Close settings');
  header.append(heading, closeButton);

  // --- Appearance -----------------------------------------------------------------------
  const appearance = document.createElement('section');
  appearance.className = 'settings-group';
  const appearanceTitle = document.createElement('h3');
  appearanceTitle.textContent = 'Appearance';
  const themes = document.createElement('div');
  themes.className = 'settings-theme';
  themes.setAttribute('role', 'radiogroup');
  themes.setAttribute('aria-label', 'Theme');
  const current = readTheme(themeStore);
  for (const [value, label] of THEME_LABELS) {
    const option = document.createElement('label');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'owl-theme';
    radio.value = value;
    radio.checked = value === current;
    radio.addEventListener('change', () => { if (radio.checked) setTheme(value, themeStore); });
    const text = document.createElement('span');
    text.textContent = label;
    option.append(radio, text);
    themes.append(option);
  }
  appearance.append(appearanceTitle, themes);

  // --- Voice ----------------------------------------------------------------------------
  const voice = document.createElement('section');
  voice.className = 'settings-group';
  const voiceTitle = document.createElement('h3');
  voiceTitle.textContent = 'Voice';
  const voiceIntro = document.createElement('p');
  voiceIntro.className = 'settings-hint';
  voiceIntro.textContent = 'The voice that reads the words you select under Phonetic Assistance.';
  const rows = document.createElement('div');
  rows.className = 'settings-voices';
  const note = document.createElement('p');
  note.className = 'settings-note';
  note.setAttribute('role', 'status');
  note.hidden = true;
  const source = document.createElement('p');
  source.className = 'settings-hint';
  source.textContent = 'Voices come from this computer, the browser, and any voice add-on you installed. '
    + 'The words you select are given to the voice that reads them, and an online voice sends them to its provider.';
  voice.append(voiceTitle, voiceIntro, rows, note, source);

  const say = (message) => { note.textContent = message; note.hidden = !message; };

  let choices = {};
  let playing = null; // kept so the browser does not drop the utterance, and its events
  let startTimer = null;
  const selects = new Map();

  const fill = (lang) => {
    const select = selects.get(lang);
    const listed = synth ? voicesFor(synth.getVoices(), lang) : [];
    const automatic = listed[0];
    const chosen = choices[lang] || '';
    select.replaceChildren();
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = automatic ? `Automatic (${automatic.name})` : 'Automatic (no voice found)';
    select.append(auto);
    for (const item of listed) {
      const option = document.createElement('option');
      option.value = item.name;
      option.textContent = optionLabel(item);
      select.append(option);
    }
    // A chosen voice that is not listed just now, such as an add-on that is switched off,
    // stays chosen: it is used again as soon as it is back.
    if (chosen && !listed.some((item) => item.name === chosen)) {
      const missing = document.createElement('option');
      missing.value = chosen;
      missing.textContent = `${chosen} (not available now)`;
      select.append(missing);
    }
    select.value = chosen;
  };
  const fillAll = () => { for (const lang of VOICE_LANGS) fill(lang); };

  const stopSample = () => {
    clearTimeout(startTimer);
    startTimer = null;
    if (playing) { playing = null; synth?.cancel(); }
    rows.querySelectorAll('.settings-voice-test.speaking').forEach((b) => b.classList.remove('speaking'));
  };

  const sample = (lang, button) => {
    stopSample();
    say('');
    const picked = synth && pickVoice(synth.getVoices(), lang, choices[lang] || null);
    if (!picked || !Utterance) { say(`This computer has no ${languageName(lang)} voice.`); return; }
    if (choices[lang] && picked.name !== choices[lang]) {
      say(`"${choices[lang]}" is not available now, so this is the automatic voice.`);
    }
    const utterance = new Utterance(SAMPLES[lang]);
    utterance.voice = picked;
    utterance.lang = picked.lang;
    const failed = () => {
      if (playing !== utterance) return;
      stopSample();
      say(`"${picked.name}" could not play the sample. Check that it is running.`);
    };
    utterance.onstart = () => { clearTimeout(startTimer); button.classList.add('speaking'); };
    utterance.onend = () => { if (playing === utterance) { playing = null; button.classList.remove('speaking'); } };
    utterance.onerror = (event) => {
      if (event.error === 'canceled' || event.error === 'interrupted') return;
      failed();
    };
    playing = utterance;
    synth.speak(utterance);
    startTimer = setTimeout(failed, START_TIMEOUT_MS);
  };

  for (const lang of VOICE_LANGS) {
    const row = document.createElement('div');
    row.className = 'settings-voice-row';
    const label = document.createElement('label');
    label.htmlFor = `settings-voice-${lang}`;
    label.textContent = languageName(lang);
    const select = document.createElement('select');
    select.id = `settings-voice-${lang}`;
    selects.set(lang, select);
    select.addEventListener('change', async () => {
      const next = { ...choices };
      if (select.value) next[lang] = select.value; else delete next[lang];
      choices = next;
      say('');
      try { await storage?.set({ [VOICE_CHOICE_KEY]: next }); } catch { say('The choice could not be saved.'); }
    });
    const test = document.createElement('button');
    test.type = 'button';
    test.className = 'settings-voice-test';
    test.title = `Play a sample in ${languageName(lang)}`;
    test.setAttribute('aria-label', test.title);
    test.append(playIcon());
    test.addEventListener('click', () => sample(lang, test));
    row.append(label, select, test);
    rows.append(row);
  }

  // --- Microphone -------------------------------------------------------------------------
  const mic = document.createElement('section');
  mic.className = 'settings-group';
  const micTitle = document.createElement('h3');
  micTitle.textContent = 'Microphone';
  const micIntro = document.createElement('p');
  micIntro.className = 'settings-hint';
  micIntro.textContent = 'The microphone that hears you when you say a selection yourself under Phonetic Assistance.';
  const micRow = document.createElement('div');
  micRow.className = 'settings-voice-row';
  const micLabel = document.createElement('label');
  micLabel.htmlFor = 'settings-mic';
  micLabel.textContent = 'Device';
  const micSelect = document.createElement('select');
  micSelect.id = 'settings-mic';
  const micTest = document.createElement('button');
  micTest.type = 'button';
  micTest.className = 'settings-voice-test settings-mic-test';
  micTest.title = 'Test this microphone';
  micTest.setAttribute('aria-label', micTest.title);
  micTest.append(micIcon());
  micRow.append(micLabel, micSelect, micTest);
  // How loud the microphone hears the room, while it is being tested.
  const micLevel = document.createElement('div');
  micLevel.className = 'settings-mic-level';
  micLevel.hidden = true;
  const micBar = document.createElement('span');
  micLevel.append(micBar);
  const micNote = document.createElement('p');
  micNote.className = 'settings-note';
  micNote.setAttribute('role', 'status');
  micNote.hidden = true;
  mic.append(micTitle, micIntro, micRow, micLevel, micNote);
  const canRecord = !!scope.navigator?.mediaDevices?.getUserMedia;

  const micSay = (message) => { micNote.textContent = message; micNote.hidden = !message; };
  let micChoice = null; // { id, label }, or null for the system's default
  let testing = null;   // { stream, context, timer, end } while the microphone is open
  let opening = false;  // between the press and the microphone opening: a second press must not open it twice

  const fillMics = async () => {
    const { devices, named, usual } = await listMicrophones(scope);
    if (!backdrop.isConnected) return;
    micSelect.replaceChildren();
    const usualOption = document.createElement('option');
    usualOption.value = '';
    usualOption.textContent = usual ? `System default (${usual})` : 'System default';
    micSelect.append(usualOption);
    for (const device of devices) {
      const option = document.createElement('option');
      option.value = device.id;
      option.textContent = device.label;
      micSelect.append(option);
    }
    // A chosen microphone that is unplugged just now stays chosen: it is used again as
    // soon as it is back, and the default stands in until then.
    if (micChoice && !devices.some((device) => device.id === micChoice.id)) {
      const missing = document.createElement('option');
      missing.value = micChoice.id;
      missing.textContent = `${micChoice.label || 'The chosen microphone'} (not connected now)`;
      micSelect.append(missing);
    }
    micSelect.value = micChoice?.id || '';
    // The browser keeps the names to itself until this page has been allowed a microphone.
    if (!canRecord) micSay('This browser gives OWL-Note no microphone to use.');
    else if (!named && !testing) micSay('The browser names your microphones once you have allowed OWL-Note to use one. Press the microphone button to allow it.');
    else if (named && /names your microphones/.test(micNote.textContent)) micSay('');
  };

  const stopMicTest = () => {
    if (!testing) return;
    const { stream, context, timer, end } = testing;
    testing = null;
    clearInterval(timer);
    clearTimeout(end);
    stream.getTracks().forEach((track) => track.stop());
    context?.close?.().catch?.(() => {});
    micTest.classList.remove('speaking');
    micLevel.hidden = true;
    micBar.style.width = '0%';
  };

  micSelect.addEventListener('change', async () => {
    stopMicTest();
    micChoice = micSelect.value
      ? { id: micSelect.value, label: micSelect.selectedOptions[0].textContent.replace(/ \(not connected now\)$/, '') }
      : null;
    micSay('');
    try { await storage?.set({ [MIC_CHOICE_KEY]: micChoice }); } catch { micSay('The choice could not be saved.'); }
  });

  micTest.addEventListener('click', async () => {
    if (testing) { stopMicTest(); return; }
    if (!canRecord || opening) return;
    micSay('');
    let opened;
    opening = true;
    try {
      opened = await openMicrophone(micChoice?.id || null, scope);
    } catch (error) {
      micSay(error.code === 'mic-blocked'
        ? 'OWL-Note is not allowed to use the microphone. Allow it for this page in the browser\'s site settings, then try again.'
        : error.code === 'no-mic' ? 'No microphone was found on this computer.' : 'The microphone could not be used.');
      return;
    } finally {
      opening = false;
    }
    if (!backdrop.isConnected) { opened.stream.getTracks().forEach((track) => track.stop()); return; }
    const context = new scope.AudioContext();
    const meter = context.createAnalyser();
    meter.fftSize = 1024;
    context.createMediaStreamSource(opened.stream).connect(meter);
    const samples = new Float32Array(meter.fftSize);
    micLevel.hidden = false;
    micTest.classList.add('speaking');
    micSay(opened.usedDefault
      ? `"${micChoice?.label || 'The chosen microphone'}" was not found, so this is the computer's default microphone. Say something: the bar should move.`
      : 'Say something: the bar should move.');
    testing = {
      stream: opened.stream,
      context,
      timer: setInterval(() => {
        meter.getFloatTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) sum += sample * sample;
        // Speech sits around 0.05 to 0.3; the bar is full at 0.25.
        micBar.style.width = `${Math.min(100, Math.round(Math.sqrt(sum / samples.length) * 400))}%`;
      }, 60),
      end: setTimeout(() => { stopMicTest(); micSay(''); }, MIC_TEST_MS),
    };
    fillMics(); // allowed now, so the browser will name them
  });

  dialog.append(header, appearance, voice, mic);
  backdrop.append(dialog);
  document.body.append(backdrop);

  readMicChoice(storage).then((saved) => { micChoice = saved; return fillMics(); });
  // A microphone plugged in or pulled out while Settings is open.
  scope.navigator?.mediaDevices?.addEventListener?.('devicechange', fillMics);

  fillAll();
  readVoiceChoices(storage).then((saved) => { choices = saved; if (backdrop.isConnected) fillAll(); });
  // The browser's list fills in after the first ask, and again when an add-on comes or goes.
  synth?.addEventListener?.('voiceschanged', fillAll);

  const previouslyFocused = document.activeElement;
  const onKeydown = (event) => { if (event.key === 'Escape') close(); };
  function close() {
    document.removeEventListener('keydown', onKeydown);
    synth?.removeEventListener?.('voiceschanged', fillAll);
    scope.navigator?.mediaDevices?.removeEventListener?.('devicechange', fillMics);
    stopSample();
    stopMicTest();
    backdrop.remove();
    if (activeClose === close) activeClose = null;
    previouslyFocused?.focus?.();
  }
  activeClose = close;
  closeButton.addEventListener('click', close);
  backdrop.addEventListener('mousedown', (event) => { if (event.target === backdrop) close(); });
  document.addEventListener('keydown', onKeydown);
  closeButton.focus();
  return { close, dialog };
}
