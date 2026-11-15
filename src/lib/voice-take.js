// One spoken take, for speaking practice: the microphone recorded, and at the same time
// written down by the browser's own on-device recogniser.
//
// Nothing here leaves the computer. The recogniser is the one Live Transcription uses,
// asked for with processLocally (lib/native-speech.js), which makes Chrome refuse rather
// than fall back to its online service. The recording stays in memory, for the reader to
// hear back and for its pitch to be measured (lib/voice-melody.js).

import {
  checkNativeSpeechAvailability, configureNativeRecognition, installNativeSpeech, nativeSpeechConstructor,
} from './native-speech.js';

// The reading languages Chrome can recognise on the device. It has no Cantonese model.
export const SPEECH_TAGS = { en: 'en-US', ja: 'ja-JP' };

const QUIET_MS = 1400;       // this long without a sound, after some, and the take is over
const NOTHING_MS = 8000;     // this long with no sound at all, and nobody is speaking
const LEVEL_EVERY_MS = 60;
const FINAL_WAIT_MS = 2500;  // how long the recogniser gets to finish writing
const MIN_LEVEL = 0.012;     // quieter than this is never speech, whatever the room
const LOUDEST_ROOM = 0.02;   // and no room is taken to be noisier than this

// Which microphone to record with, chosen in Settings: { id, label }. Kept on this device
// only, because the microphones are this device's. Nothing saved means the system's default.
export const MIC_CHOICE_KEY = 'owl:microphone';

export async function readMicChoice(storage) {
  try {
    const saved = (await storage?.get(MIC_CHOICE_KEY))?.[MIC_CHOICE_KEY];
    return saved && typeof saved.id === 'string' && saved.id ? saved : null;
  } catch {
    return null;
  }
}

/**
 * The microphones the browser will name. It names none until the reader has allowed this
 * page to use one, and until then `named` is false and the list is empty.
 * @returns {Promise<{ devices: { id: string, label: string }[], named: boolean, usual: string }>}
 *   `usual` is the name of the system's default microphone, where the browser gives it
 */
export async function listMicrophones(scope = globalThis) {
  let all = [];
  try { all = (await scope.navigator?.mediaDevices?.enumerateDevices?.()) || []; } catch { all = []; }
  const inputs = all.filter((device) => device.kind === 'audioinput');
  // Chrome lists the system's default, and its "communications" device, a second time
  // under those names. They are not further microphones.
  const real = inputs.filter((device) => device.deviceId && device.deviceId !== 'default' && device.deviceId !== 'communications');
  return {
    devices: real.filter((device) => device.label).map((device) => ({ id: device.deviceId, label: device.label })),
    named: inputs.length > 0 && inputs.every((device) => device.label),
    usual: (inputs.find((device) => device.deviceId === 'default')?.label || '').replace(/^Default - /, ''),
  };
}

const MIC_AUDIO = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true };

/**
 * Open a microphone: the chosen one, or the system's default when none is chosen. A chosen
 * one that is not plugged in is not a reason to record nothing, so the default stands in.
 * @returns {Promise<{ stream: MediaStream, usedDefault: boolean }>} usedDefault is true only
 *   when a microphone was chosen and the default had to be used instead
 */
export async function openMicrophone(deviceId = null, scope = globalThis) {
  const open = (id) => scope.navigator.mediaDevices.getUserMedia({ audio: id ? { ...MIC_AUDIO, deviceId: { exact: id } } : MIC_AUDIO });
  try {
    return { stream: await open(deviceId), usedDefault: false };
  } catch (error) {
    const gone = error?.name === 'OverconstrainedError' || error?.name === 'NotFoundError';
    if (!deviceId || !gone) throw micError(error);
    try {
      return { stream: await open(null), usedDefault: true };
    } catch (again) {
      throw micError(again);
    }
  }
}

/** @returns {Promise<'available'|'downloadable'|'downloading'|'unavailable'|'unsupported'|'timeout'|'none'>} */
export async function speechReadiness(lang, scope = globalThis) {
  const tag = SPEECH_TAGS[lang];
  if (!tag) return 'none';
  return checkNativeSpeechAvailability(nativeSpeechConstructor(scope), tag);
}

/** Download the language's speech pack. Needs to be called from a click. */
export async function installSpeech(lang, scope = globalThis) {
  const result = await installNativeSpeech(nativeSpeechConstructor(scope), SPEECH_TAGS[lang]);
  return !!result.ok;
}

const micError = (error) => {
  const blocked = error?.name === 'NotAllowedError' || error?.name === 'SecurityError';
  const missing = error?.name === 'NotFoundError' || error?.name === 'OverconstrainedError';
  return Object.assign(new Error(error?.message || 'microphone unavailable'), {
    code: blocked ? 'mic-blocked' : missing ? 'no-mic' : 'mic-failed',
  });
};

/**
 * Start recording. The take ends by itself when the speaker goes quiet, or on stop().
 * @param {{ lang: 'en'|'ja', deviceId?: string|null, recognise?: boolean, maxMs?: number,
 *   quietMs?: number, onLevel?: (level: number, speaking: boolean) => void,
 *   onInterim?: (text: string) => void, scope?: typeof globalThis }} options `deviceId` is
 *   the microphone chosen in Settings; `quietMs` is how long a silence ends the take
 * @returns {{ stop: () => void, done: Promise<{ blob: Blob, heard: string, recognised: boolean,
 *   problem: string|null, usedDefault: boolean, seconds: number,
 *   ended: 'quiet'|'stopped'|'time'|'nothing' }> }} `usedDefault` says the chosen microphone
 *   was missing and the system's default was recorded instead. `done` rejects with an error
 *   whose code is 'mic-blocked', 'no-mic' or 'mic-failed' when there is no recording
 */
export function startTake({
  lang, deviceId = null, recognise = true, maxMs = 20000, quietMs = QUIET_MS,
  onLevel = () => {}, onInterim = () => {}, scope = globalThis,
}) {
  let finish = null;
  let stopped = false;
  const done = (async () => {
    const { stream, usedDefault } = await openMicrophone(deviceId, scope);
    const [track] = stream.getAudioTracks();
    const chunks = [];
    const recorder = new scope.MediaRecorder(stream, { audioBitsPerSecond: 96000 });
    recorder.ondataavailable = (event) => { if (event.data?.size) chunks.push(event.data); };
    const recorded = new Promise((resolve) => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
    });

    const finals = [];
    let interim = '';
    let problem = null; // what the recogniser reported, if it gave up
    let recognition = null;
    let written = Promise.resolve();
    const Recognition = nativeSpeechConstructor(scope);
    if (recognise && Recognition && SPEECH_TAGS[lang]) {
      recognition = configureNativeRecognition(new Recognition(), SPEECH_TAGS[lang]);
      recognition.onresult = (event) => {
        interim = '';
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const text = String(event.results[i]?.[0]?.transcript || '').trim();
          if (!text) continue;
          if (event.results[i].isFinal) finals.push(text); else interim = `${interim} ${text}`.trim();
        }
        onInterim([...finals, interim].join(' ').trim());
      };
      written = new Promise((resolve) => {
        recognition.onend = resolve;
        // An error is followed by end, and the take still has its recording.
        recognition.onerror = (event) => { if (event?.error !== 'aborted' && event?.error !== 'no-speech') problem = event?.error || 'failed'; };
      });
      try {
        // The recogniser is given the very track being recorded, so both hear one take.
        recognition.start(track);
      } catch {
        recognition = null;
        written = Promise.resolve();
      }
    }

    const audio = new scope.AudioContext();
    const meter = audio.createAnalyser();
    meter.fftSize = 1024;
    audio.createMediaStreamSource(stream).connect(meter);
    const samples = new Float32Array(meter.fftSize);
    const began = Date.now();
    let floor = Infinity;   // the room's own noise, learned as the quietest moment so far
    let spokeAt = 0;
    let quietSince = 0;
    recorder.start();

    const ended = await new Promise((resolve) => {
      const timer = setInterval(() => {
        meter.getFloatTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) sum += sample * sample;
        const level = Math.sqrt(sum / samples.length);
        floor = Math.min(floor, level);
        // Speech is what stands well clear of the room. The room is capped, because a
        // reader who starts talking at once gives no quiet moment to learn it from, and
        // their whole take would otherwise pass for the room.
        const speaking = level > Math.max(MIN_LEVEL, Math.min(floor, LOUDEST_ROOM) * 4);
        const now = Date.now();
        onLevel(level, speaking);
        if (speaking) { spokeAt ||= now; quietSince = 0; } else if (spokeAt && !quietSince) quietSince = now;
        let reason = null;
        if (spokeAt && quietSince && now - quietSince >= quietMs) reason = 'quiet';
        else if (!spokeAt && now - began >= NOTHING_MS) reason = 'nothing';
        else if (now - began >= maxMs) reason = 'time';
        if (reason) { clearInterval(timer); resolve(reason); }
      }, LEVEL_EVERY_MS);
      finish = () => { clearInterval(timer); resolve('stopped'); };
      if (stopped) finish(); // stop() arrived while the microphone was still being opened
    });

    const seconds = (Date.now() - began) / 1000;
    if (recorder.state !== 'inactive') recorder.stop();
    try { recognition?.stop(); } catch { /* already over */ }
    const blob = await recorded;
    if (recognition) await Promise.race([written, new Promise((resolve) => { setTimeout(resolve, FINAL_WAIT_MS); })]);
    stream.getTracks().forEach((each) => each.stop());
    audio.close().catch(() => {});
    return {
      blob,
      heard: [...finals, interim].join(' ').trim(),
      recognised: !!recognition,
      problem,
      usedDefault,
      seconds,
      ended: ended === 'stopped' && !spokeAt ? 'nothing' : ended,
    };
  })();
  return {
    stop() { stopped = true; finish?.(); },
    done,
  };
}

/**
 * The take as plain samples for the checks: mono, 16,000 a second.
 * @returns {Promise<Float32Array>}
 */
export async function decodeTake(blob, { rate = 16000, scope = globalThis } = {}) {
  const context = new scope.OfflineAudioContext(1, 1, rate);
  const buffer = await context.decodeAudioData(await blob.arrayBuffer());
  const samples = new Float32Array(buffer.length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < data.length; i += 1) samples[i] += data[i] / buffer.numberOfChannels;
  }
  return samples;
}

/**
 * A second hearing. Chrome's recogniser can still be starting up when a take is over, and
 * then it writes nothing at all. Rather than ask for the words again, the recording itself
 * is played to the recogniser, inaudibly and still on the device.
 * @returns {Promise<string>} what was written, or '' if nothing was this time either
 */
export async function recogniseRecording(blob, lang, { scope = globalThis } = {}) {
  const Recognition = nativeSpeechConstructor(scope);
  if (!Recognition || !SPEECH_TAGS[lang]) return '';
  const audio = new scope.AudioContext();
  try {
    const buffer = await audio.decodeAudioData(await blob.arrayBuffer());
    const source = audio.createBufferSource();
    source.buffer = buffer;
    const line = audio.createMediaStreamDestination(); // a stream, not the loudspeaker
    source.connect(line);
    const recognition = configureNativeRecognition(new Recognition(), SPEECH_TAGS[lang]);
    const finals = [];
    let interim = '';
    recognition.onresult = (event) => {
      interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const text = String(event.results[i]?.[0]?.transcript || '').trim();
        if (!text) continue;
        if (event.results[i].isFinal) finals.push(text); else interim = `${interim} ${text}`.trim();
      }
    };
    const ended = new Promise((resolve) => { recognition.onend = resolve; recognition.onerror = () => {}; });
    const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
    recognition.start(line.stream.getAudioTracks()[0]);
    // A moment for the recogniser to be listening before the first word reaches it.
    await wait(600);
    source.start();
    await wait(buffer.duration * 1000 + 1200);
    try { recognition.stop(); } catch { /* already over */ }
    await Promise.race([ended, wait(FINAL_WAIT_MS)]);
    return [...finals, interim].join(' ').trim();
  } catch {
    return '';
  } finally {
    audio.close().catch(() => {});
  }
}
