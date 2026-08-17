// This extension page owns the explicit user gesture that Chrome requires to
// install an on-device speech resource. It deliberately does NOT navigate or
// touch the source tab: that tab's activeTab grant (tab-capture access included)
// has to survive the download so transcription can resume without a second
// right-click.

import {
  checkNativeSpeechAvailability,
  installNativeSpeech,
  nativeSpeechConstructor,
  normalizeSpeechLanguage,
  ON_DEVICE_LANGUAGES,
  SPEECH_LANG_KEY,
} from '../lib/native-speech.js';

const note = document.getElementById('note');
const enable = document.getElementById('enable');
const cancel = document.getElementById('cancel');
const picker = document.getElementById('lang');
const requested = normalizeSpeechLanguage(new URL(location.href).searchParams.get('lang')
  || chrome.i18n?.getUILanguage?.()
  || 'en-US');
// The browser's UI language used to be the ONLY choice, so anyone whose language
// Chrome cannot actually deliver had no way through at all. Offer the documented
// set and let the reader pick one that works for them.
for (const entry of ON_DEVICE_LANGUAGES) {
  const option = document.createElement('option');
  option.value = entry.tag;
  option.textContent = `${entry.label} — ${entry.tag}`;
  picker.appendChild(option);
}
const supported = ON_DEVICE_LANGUAGES.some((e) => e.tag === requested);
picker.value = supported ? requested : 'en-US';
let lang = picker.value;
const Recognition = nativeSpeechConstructor(globalThis);

let availability = 'checking';
let finished = false;

function explain(result) {
  if (result === 'available') return `${lang} local speech is ready.`;
  if (result === 'downloadable') return `${lang} needs a one-time Chrome speech-resource download.`;
  if (result === 'downloading') return `${lang} speech resources are currently downloading.`;
  if (result === 'unsupported') return 'Native transcription requires Chrome 139 or newer.';
  if (result === 'timeout') {
    return `Chrome stopped responding while checking ${lang}. It may not have an on-device`
      + ' model for this language. Try a language Chrome supports for Live Caption.';
  }
  // Names the language and the next step: without it this reads as a dead end, and
  // the language it failed on is exactly the thing the reader needs to know.
  return `Chrome has no on-device speech model for ${lang}. Live transcription needs a`
    + " language Chrome offers for Live Caption — check chrome://settings/captions.";
}

async function preflight() {
  lang = picker.value;
  note.classList.remove('warn');
  availability = await checkNativeSpeechAvailability(Recognition, lang);
  note.textContent = supported || picker.value !== requested
    ? explain(availability)
    : `Chrome does not list ${requested} for on-device speech — pick a language below.`;
  enable.disabled = !['available', 'downloadable', 'downloading'].includes(availability);
}

picker.addEventListener('change', () => { void preflight(); });

async function cancelSetup() {
  finished = true;
  try { await chrome.runtime.sendMessage({ type: 'owl-transcribe-setup-cancelled' }); } catch { /* worker unavailable */ }
  window.close();
}

cancel.addEventListener('click', cancelSetup);
window.addEventListener('pagehide', () => {
  if (!finished) {
    try { chrome.runtime.sendMessage({ type: 'owl-transcribe-setup-cancelled' }); } catch { /* worker unavailable */ }
  }
});

enable.addEventListener('click', async () => {
  enable.disabled = true;
  cancel.disabled = true;
  note.textContent = availability === 'available'
    ? 'Starting transcription…'
    : 'Installing Chrome’s local speech resource…';

  try {
    // install() is called directly in the click handler: an await first can
    // consume the transient user activation it needs.
    const installed = availability === 'available'
      ? { ok: true, timedOut: false }
      : await installNativeSpeech(Recognition, lang);

    if (!installed.ok) {
      // Both controls come back on whatever happened: leaving them disabled after a
      // hang is what made this page look dead rather than failed.
      note.textContent = installed.timedOut
        ? `Chrome did not finish installing the ${lang} speech resource. It may not offer`
          + ' one for this language — try a language listed in chrome://settings/captions.'
        : `Chrome could not install the local ${lang} speech resource.`;
      enable.disabled = false;
      cancel.disabled = false;
      return;
    }

    availability = await checkNativeSpeechAvailability(Recognition, lang);
    if (availability !== 'available') {
      // Chrome answers install() with success and then leaves the language exactly
      // as it was — measured on zh-TW: installed:true, still "downloadable" three
      // minutes later, while English installed on the same profile seconds earlier.
      // Repeating the same "needs a one-time download" line here is what made the
      // button look dead: it silently returned the reader to where they began.
      note.classList.add('warn');
      note.textContent = `Chrome reported success but ${lang} is still not installed. `
        + 'It does not seem able to provide this language. Choose another one above.';
      enable.disabled = false;
      cancel.disabled = false;
      return;
    }
    // Remember what actually worked, so later sessions skip this page entirely.
    try { await chrome.storage.local.set({ [SPEECH_LANG_KEY]: lang }); } catch { /* preference only */ }

    finished = true;
    note.textContent = 'Ready. Returning to the video…';
    enable.textContent = 'Enabled';
    try { await chrome.runtime.sendMessage({ type: 'owl-transcribe-setup-complete' }); } catch { /* worker unavailable */ }
    window.close();
  } catch (error) {
    note.textContent = `Could not enable live transcription: ${error?.message || error}`;
    enable.disabled = false;
    cancel.disabled = false;
  }
});

preflight();
