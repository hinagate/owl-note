// This extension page owns the explicit user gesture that Chrome requires to
// install an on-device speech resource. It deliberately does NOT navigate or
// touch the source tab: that tab's activeTab grant (tab-capture access included)
// has to survive the download so transcription can resume without a second
// right-click.

import {
  checkNativeSpeechAvailability,
  nativeSpeechConstructor,
  nativeSpeechOptions,
  normalizeSpeechLanguage,
} from '../lib/native-speech.js';

const note = document.getElementById('note');
const enable = document.getElementById('enable');
const cancel = document.getElementById('cancel');
const lang = normalizeSpeechLanguage(new URL(location.href).searchParams.get('lang')
  || chrome.i18n?.getUILanguage?.()
  || 'en-US');
const Recognition = nativeSpeechConstructor(globalThis);

let availability = 'checking';
let finished = false;

function explain(result) {
  if (result === 'available') return `${lang} local speech is ready.`;
  if (result === 'downloadable') return `${lang} needs a one-time Chrome speech-resource download.`;
  if (result === 'downloading') return `${lang} speech resources are currently downloading.`;
  if (result === 'unsupported') return 'Native transcription requires Chrome 139 or newer.';
  return `Chrome does not offer an on-device speech resource for ${lang}.`;
}

async function preflight() {
  availability = await checkNativeSpeechAvailability(Recognition, lang);
  note.textContent = explain(availability);
  enable.disabled = !['available', 'downloadable', 'downloading'].includes(availability);
}

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
      ? true
      : await Recognition.install(nativeSpeechOptions(lang));

    if (!installed) {
      note.textContent = `Chrome could not install the local ${lang} speech resource.`;
      enable.disabled = false;
      cancel.disabled = false;
      return;
    }

    availability = await checkNativeSpeechAvailability(Recognition, lang);
    if (availability !== 'available') {
      note.textContent = explain(availability);
      enable.disabled = false;
      cancel.disabled = false;
      return;
    }

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
