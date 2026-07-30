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
} from '../lib/native-speech.js';

const RETRY_DELAY_MS = 250;
const AVAILABILITY_POLL_MS = 1000;

let stream = null;
let playbackContext = null;
let recognition = null;
let recognitionTrack = null;
let restartTimer = null;
let availabilityTimer = null;
let language = 'en-US';
let stopping = false;

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
  if (result === 'unavailable') {
    return `Chrome has no local speech model available for ${language}.`;
  }
  return 'Chrome live transcription is unavailable.';
}

async function prepare({ lang, sessionToken }) {
  language = normalizeSpeechLanguage(lang);
  clearTimeout(availabilityTimer);
  const Recognition = nativeSpeechConstructor(globalThis);
  status({ asr: 'checking', engine: 'chrome-native', lang: language });
  const availability = await checkNativeSpeechAvailability(Recognition, language);

  if (availability === 'available') {
    status({ asr: 'ready', engine: 'chrome-native', lang: language });
    send({ type: 'owl-native-speech-ready', lang: language, sessionToken });
    return;
  }

  if (availability === 'downloadable') {
    status({ asr: 'needs-install', engine: 'chrome-native', lang: language });
    send({ type: 'owl-native-speech-install-required', lang: language, sessionToken });
    return;
  }

  if (availability === 'downloading') {
    status({ asr: 'downloading', engine: 'chrome-native', lang: language });
    availabilityTimer = setTimeout(
      () => prepare({ lang: language, sessionToken }),
      AVAILABILITY_POLL_MS,
    );
    return;
  }

  status({ asr: 'error', engine: 'chrome-native', error: availabilityError(availability) });
}

function startRecognizer() {
  if (stopping || !recognition || recognitionTrack?.readyState !== 'live') return;
  try {
    recognition.start(recognitionTrack);
  } catch (error) {
    status({
      asr: 'error',
      engine: 'chrome-native',
      error: `speech-start-failed: ${error?.message || error}`,
    });
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
      const text = String(result?.[0]?.transcript || '').trim();
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
    stopping = true;
    status({
      asr: 'error',
      engine: 'chrome-native',
      error: `native-speech-${event?.error || 'failed'}${event?.message ? `: ${event.message}` : ''}`,
    });
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
