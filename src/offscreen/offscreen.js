// The only place tab audio is touched. The service worker can be suspended, so
// the long-lived MediaStream and SpeechRecognition instance live here.
//
// Chrome 139+ can run Web Speech entirely on-device. Chromium routes that path
// through its SODA caption engine, avoiding the short windows, duplicated seams
// and realtime backlog of the previous Whisper implementation.

import {
  checkNativeSpeechAvailability,
  configureNativeRecognition,
  nativeSpeechConstructor,
  normalizeSpeechLanguage,
  ON_DEVICE_LANGUAGES,
} from '../lib/native-speech.js';
import { tidyRecognizedText } from '../lib/transcript.js';

const RETRY_DELAY_MS = 250;
// Errors that mean recognition can never work here. Anything else is a hiccup: an
// error event is always followed by end, and onend starts the recognizer again —
// stopping for good on any error ended a long transcription at its first glitch.
const FATAL_ERRORS = new Set([
  'not-allowed', 'service-not-allowed', 'language-not-supported', 'phrases-not-supported', 'bad-grammar',
]);
// Failing again and again is broken, not hiccuping: past this many error restarts
// within the window, stop and say why rather than loop.
const ERROR_RESTART_LIMIT = 5;
const ERROR_RESTART_WINDOW_MS = 60000;
const AVAILABILITY_POLL_MS = 1000;
// A download that never finishes polled forever, leaving the overlay on its
// progress text with no way out. Chrome reports "downloading" for a language it
// then never delivers, so the wait needs an end.
const AVAILABILITY_DEADLINE_MS = 120000;

let stream = null;
let playbackContext = null;
let recognition = null;
let recognitionTrack = null;
let restartTimer = null;
let availabilityTimer = null;
let availabilityDeadline = 0;
let language = 'en-US';
let stopping = false;
let errorRestarts = []; // when recent error restarts happened, for the limit above

function send(message) {
  try {
    const pending = chrome.runtime.sendMessage(message);
    pending?.catch?.(() => {});
  } catch { /* extension reloaded */ }
}

function status(patch) {
  send({ type: 'owl-capture-status', status: patch });
}

function teardown() {
  stopping = true;
  clearTimeout(restartTimer);
  clearTimeout(availabilityTimer);
  restartTimer = null;
  availabilityTimer = null;
  if (recognition) {
    recognition.onstart = null;
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
    try { recognition.abort(); } catch { /* already stopped */ }
  }
  recognition = null;
  recognitionTrack = null;
  try { stream?.getTracks().forEach((track) => track.stop()); } catch { /* stopped */ }
  stream = null;
  try { playbackContext?.close(); } catch { /* closed */ }
  playbackContext = null;
}

function availabilityError(result) {
  if (result === 'unsupported') {
    return 'Native transcription requires Chrome 139 or newer.';
  }
  if (result === 'timeout') {
    return `Chrome stopped responding while checking ${language}. It may have no on-device model for this language.`;
  }
  if (result === 'stalled') {
    return `Chrome never finished downloading the ${language} speech model. Check chrome://settings/captions.`;
  }
  if (result === 'unavailable') {
    return `Chrome has no on-device speech model for ${language}. Try a language listed in chrome://settings/captions.`;
  }
  return 'Chrome live transcription is unavailable.';
}

// Which languages this machine can transcribe right now, for the overlay's language
// button. available() overstates what can be downloaded, but not what is installed:
// it answers "available" only for a model that really is.
async function reportLanguages(Recognition) {
  const states = await Promise.all(
    ON_DEVICE_LANGUAGES.map(({ tag }) => checkNativeSpeechAvailability(Recognition, tag)),
  );
  send({
    type: 'owl-native-speech-languages',
    languages: ON_DEVICE_LANGUAGES.filter((_, i) => states[i] === 'available').map(({ tag }) => tag),
  });
}

async function prepare({ lang, sessionToken, polling = false }) {
  language = normalizeSpeechLanguage(lang);
  clearTimeout(availabilityTimer);
  if (!polling) availabilityDeadline = Date.now() + AVAILABILITY_DEADLINE_MS;
  const Recognition = nativeSpeechConstructor(globalThis);
  status({ asr: 'checking', engine: 'chrome-native', lang: language });
  const availability = await checkNativeSpeechAvailability(Recognition, language);

  if (availability === 'available') {
    status({ asr: 'ready', engine: 'chrome-native', lang: language });
    send({ type: 'owl-native-speech-ready', lang: language, sessionToken });
    void reportLanguages(Recognition);
    return;
  }

  if (availability === 'downloadable') {
    status({ asr: 'needs-install', engine: 'chrome-native', lang: language });
    send({ type: 'owl-native-speech-install-required', lang: language, sessionToken });
    return;
  }

  if (availability === 'downloading') {
    if (Date.now() > availabilityDeadline) {
      status({ asr: 'error', engine: 'chrome-native', error: availabilityError('stalled') });
      return;
    }
    status({ asr: 'downloading', engine: 'chrome-native', lang: language });
    availabilityTimer = setTimeout(
      () => prepare({ lang: language, sessionToken, polling: true }),
      AVAILABILITY_POLL_MS,
    );
    return;
  }

  status({ asr: 'error', engine: 'chrome-native', error: availabilityError(availability) });
}

// True while another restart is within budget; once it is spent, the session ends
// with the error that spent it.
function mayRestartAfter(error) {
  const now = Date.now();
  errorRestarts = errorRestarts.filter((at) => now - at < ERROR_RESTART_WINDOW_MS);
  errorRestarts.push(now);
  if (errorRestarts.length <= ERROR_RESTART_LIMIT) return true;
  stopping = true;
  status({ asr: 'error', engine: 'chrome-native', error });
  return false;
}

function startRecognizer() {
  if (stopping || !recognition || recognitionTrack?.readyState !== 'live') return;
  try {
    recognition.start(recognitionTrack);
  } catch (error) {
    if (mayRestartAfter(`speech-start-failed: ${error?.message || error}`)) {
      status({ asr: 'restarting', engine: 'chrome-native' });
      restartTimer = setTimeout(startRecognizer, RETRY_DELAY_MS * 4);
    }
  }
}

function wireRecognition(Recognition) {
  recognition = configureNativeRecognition(new Recognition(), language);
  recognition.onstart = () => {
    status({ asr: 'listening', engine: 'chrome-native', lang: language });
  };
  recognition.onresult = (event) => {
    const cues = [];
    const interim = [];
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      const text = tidyRecognizedText(result?.[0]?.transcript);
      if (!text) continue;
      if (result.isFinal) cues.push({ text, videoTime: null, at: Date.now() });
      else interim.push(text);
    }
    if (cues.length) send({ type: 'owl-cue', cues });
    if (interim.length) send({ type: 'owl-interim', text: interim.join(' ') });
  };
  recognition.onerror = (event) => {
    if (stopping || event?.error === 'aborted') return;
    if (event?.error === 'no-speech') {
      status({ asr: 'listening', engine: 'chrome-native' });
      return;
    }
    const error = `native-speech-${event?.error || 'failed'}${event?.message ? `: ${event.message}` : ''}`;
    if (FATAL_ERRORS.has(event?.error)) {
      stopping = true;
      status({ asr: 'error', engine: 'chrome-native', error });
      return;
    }
    // A hiccup: the end event that follows starts the recognizer again.
    if (mayRestartAfter(error)) status({ asr: 'restarting', engine: 'chrome-native' });
  };
  recognition.onend = () => {
    if (stopping || recognitionTrack?.readyState !== 'live') return;
    status({ asr: 'restarting', engine: 'chrome-native' });
    restartTimer = setTimeout(startRecognizer, RETRY_DELAY_MS);
  };
}

async function start({ streamId, lang, sessionToken }) {
  teardown();
  stopping = false;
  errorRestarts = [];
  language = normalizeSpeechLanguage(lang);

  const Recognition = nativeSpeechConstructor(globalThis);
  const availability = await checkNativeSpeechAvailability(Recognition, language);
  if (availability !== 'available') {
    if (availability === 'downloadable') {
      status({ asr: 'needs-install', engine: 'chrome-native', lang: language });
      send({ type: 'owl-native-speech-install-required', lang: language, sessionToken });
    } else {
      status({ asr: 'error', engine: 'chrome-native', error: availabilityError(availability) });
    }
    return;
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    });
  } catch (error) {
    status({
      asr: 'error',
      engine: 'chrome-native',
      error: `capture-failed: ${error?.message || error}`,
    });
    return;
  }

  recognitionTrack = stream.getAudioTracks()[0] || null;
  if (!recognitionTrack) {
    status({ asr: 'error', engine: 'chrome-native', error: 'The captured tab has no audio track.' });
    teardown();
    return;
  }

  // tabCapture stops Chrome's normal audio routing. Connect the captured stream
  // back to the output so the video remains audible while it is transcribed.
  try {
    playbackContext = new AudioContext();
    playbackContext.createMediaStreamSource(stream).connect(playbackContext.destination);
    try { await playbackContext.resume(); } catch { /* it may already be running */ }

    recognitionTrack.addEventListener('ended', () => {
      if (!stopping) {
        status({ asr: 'error', engine: 'chrome-native', error: 'Tab audio capture ended.' });
      }
    }, { once: true });

    wireRecognition(Recognition);
    startRecognizer();
  } catch (error) {
    status({
      asr: 'error',
      engine: 'chrome-native',
      error: `native-speech-startup-failed: ${error?.message || error}`,
    });
    teardown();
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target !== 'offscreen') return;
  if (msg.type === 'owl-offscreen-prepare') prepare(msg);
  if (msg.type === 'owl-offscreen-start') start(msg);
  if (msg.type === 'owl-offscreen-stop') teardown();
});
