import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  MIC_CHOICE_KEY, SPEECH_TAGS, decodeTake, installSpeech, listMicrophones, openMicrophone, readMicChoice,
  recogniseRecording, speechReadiness, startTake,
} from '../src/lib/voice-take.js';

// A browser with a microphone, a recorder, a level meter and an on-device recogniser, all
// scripted. `levels` is what the meter reads, one value per reading (every 60 ms).
function fakeBrowser({ levels = [], available = 'available', micError = null, startThrows = false } = {}) {
  const state = { recognitions: [], recorders: [], tracksStopped: 0, contextsClosed: 0, installed: [], playedBuffers: 0 };
  const track = { kind: 'audio', stop() { state.tracksStopped += 1; } };
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
  let reading = 0;

  class Recognition {
    constructor() { this.started = null; this.stopped = false; state.recognitions.push(this); }
    static async available() { return available; }
    static async install(options) { state.installed.push(options.langs); return true; }
    start(input) {
      if (startThrows) throw new Error('no');
      this.started = input;
    }
    stop() { this.stopped = true; setTimeout(() => this.onend?.(), 0); }
    // What a test calls to make the recogniser write something.
    write(text, isFinal = true) {
      this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal })] });
    }
  }
  Recognition.prototype.processLocally = false;

  class Recorder {
    constructor(input, options) { this.stream = input; this.options = options; this.state = 'inactive'; this.mimeType = 'audio/webm'; state.recorders.push(this); }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob(['take']) });
      this.onstop?.();
    }
  }

  class Context {
    createAnalyser() {
      return {
        fftSize: 0,
        getFloatTimeDomainData(samples) {
          const level = levels[Math.min(reading, levels.length - 1)] ?? 0;
          reading += 1;
          samples.fill(level); // the root mean square of a constant is the constant
        },
      };
    }
    createMediaStreamSource() { return { connect() {} }; }
    createMediaStreamDestination() { return { stream }; }
    createBufferSource() { return { connect() {}, start() { state.playedBuffers += 1; } }; }
    async decodeAudioData() { return { duration: 1, length: 4, numberOfChannels: 1, getChannelData: () => new Float32Array(4) }; }
    close() { state.contextsClosed += 1; return Promise.resolve(); }
  }

  const scope = {
    navigator: { mediaDevices: { getUserMedia: async (constraints) => { state.constraints = constraints; if (micError) throw micError; return stream; } } },
    MediaRecorder: Recorder,
    AudioContext: Context,
    SpeechRecognition: Recognition,
    OfflineAudioContext: class {
      async decodeAudioData() {
        return {
          length: 3, numberOfChannels: 2,
          getChannelData: (channel) => (channel === 0 ? new Float32Array([1, 0, 0.5]) : new Float32Array([0, 1, 0.5])),
        };
      }
    },
  };
  return { scope, state, track };
}

// jsdom's Blob cannot be read back, and nothing here needs a real one.
const recording = { arrayBuffer: async () => new ArrayBuffer(8) };
const quiet = (n) => Array(n).fill(0.001);
const loud = (n) => Array(n).fill(0.2);

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('speechReadiness', () => {
  it('asks the browser about the language the reading is in', async () => {
    await expect(speechReadiness('en', fakeBrowser().scope)).resolves.toBe('available');
    await expect(speechReadiness('en', fakeBrowser({ available: 'downloadable' }).scope)).resolves.toBe('downloadable');
  });

  // Chrome has no on-device Cantonese model, and must never be asked to use its online one.
  it('has nothing for Cantonese', async () => {
    expect(SPEECH_TAGS.yue).toBeUndefined();
    await expect(speechReadiness('yue', fakeBrowser().scope)).resolves.toBe('none');
  });

  it('says so where the browser has no on-device recogniser', async () => {
    await expect(speechReadiness('en', {})).resolves.toBe('unsupported');
  });
});

describe('installSpeech', () => {
  it('downloads the pack for that language', async () => {
    const { scope, state } = fakeBrowser();
    await expect(installSpeech('ja', scope)).resolves.toBe(true);
    expect(state.installed).toEqual([['ja-JP']]);
  });
});

describe('startTake', () => {
  it('records until the speaker goes quiet, and returns what was heard', async () => {
    const { scope, state, track } = fakeBrowser({ levels: [...quiet(5), ...loud(20), ...quiet(60)] });
    const take = startTake({ lang: 'en', scope });
    await vi.advanceTimersByTimeAsync(600);
    state.recognitions[0].write('the light');
    await vi.advanceTimersByTimeAsync(6000);
    const result = await take.done;
    expect(result.ended).toBe('quiet');
    expect(result.heard).toBe('the light');
    expect(result.recognised).toBe(true);
    expect(result.blob.size).toBeGreaterThan(0);
    // The recogniser heard the very track that was recorded.
    expect(state.recognitions[0].started).toBe(track);
  });

  // Anything but this and Chrome may send the audio to its online service.
  it('only ever asks for recognition on the device', async () => {
    const { scope, state } = fakeBrowser({ levels: [...loud(5), ...quiet(60)] });
    const take = startTake({ lang: 'en', scope });
    await vi.advanceTimersByTimeAsync(6000);
    await take.done;
    expect(state.recognitions[0].processLocally).toBe(true);
    expect(state.recognitions[0].lang).toBe('en-US');
  });

  it('closes the microphone and the meter when it is over', async () => {
    const { scope, state } = fakeBrowser({ levels: [...loud(5), ...quiet(60)] });
    const take = startTake({ lang: 'en', scope });
    await vi.advanceTimersByTimeAsync(6000);
    await take.done;
    expect(state.tracksStopped).toBe(1);
    expect(state.contextsClosed).toBe(1);
    expect(state.recognitions[0].stopped).toBe(true);
  });

  it('keeps going through a short pause between words', async () => {
    const { scope } = fakeBrowser({ levels: [...loud(10), ...quiet(10), ...loud(10), ...quiet(60)] });
    const take = startTake({ lang: 'en', scope });
    let done = false;
    take.done.then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(60 * 25); // inside the second stretch of speech
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(6000);
    expect((await take.done).ended).toBe('quiet');
  });

  it('ends on stop, with what was said so far', async () => {
    const { scope, state } = fakeBrowser({ levels: loud(500) });
    const take = startTake({ lang: 'en', scope });
    await vi.advanceTimersByTimeAsync(900);
    state.recognitions[0].write('the', false); // still being written
    take.stop();
    await vi.advanceTimersByTimeAsync(3000);
    const result = await take.done;
    expect(result.ended).toBe('stopped');
    expect(result.heard).toBe('the');
  });

  it('reports that nobody spoke', async () => {
    const { scope } = fakeBrowser({ levels: quiet(500) });
    const take = startTake({ lang: 'en', scope });
    await vi.advanceTimersByTimeAsync(12000);
    expect((await take.done).ended).toBe('nothing');
  });

  it('does not run on for ever', async () => {
    const { scope } = fakeBrowser({ levels: loud(2000) });
    const take = startTake({ lang: 'en', scope, maxMs: 5000 });
    await vi.advanceTimersByTimeAsync(9000);
    expect((await take.done).ended).toBe('time');
  });

  it('learns the room: steady noise is not speech', async () => {
    const hum = Array(40).fill(0.03); // louder than the floor for silence, but constant
    const { scope } = fakeBrowser({ levels: hum.concat(Array(40).fill(0.3), Array(80).fill(0.03)) });
    const take = startTake({ lang: 'en', scope });
    await vi.advanceTimersByTimeAsync(12000);
    expect((await take.done).ended).toBe('quiet');
  });

  it('reports the level as it listens', async () => {
    const { scope } = fakeBrowser({ levels: [...quiet(3), ...loud(3), ...quiet(60)] });
    const seen = [];
    const take = startTake({ lang: 'en', scope, onLevel: (level, speaking) => seen.push(speaking) });
    await vi.advanceTimersByTimeAsync(6000);
    await take.done;
    expect(seen.slice(0, 6)).toEqual([false, false, false, true, true, true]);
  });

  it('records without a recogniser when asked to, or when there is none', async () => {
    const { scope, state } = fakeBrowser({ levels: [...loud(5), ...quiet(60)] });
    const take = startTake({ lang: 'en', recognise: false, scope });
    await vi.advanceTimersByTimeAsync(6000);
    const result = await take.done;
    expect(result.recognised).toBe(false);
    expect(state.recognitions).toHaveLength(0);
    expect(result.blob.size).toBeGreaterThan(0);
  });

  it('still records when the recogniser will not start', async () => {
    const { scope } = fakeBrowser({ levels: [...loud(5), ...quiet(60)], startThrows: true });
    const take = startTake({ lang: 'en', scope });
    await vi.advanceTimersByTimeAsync(6000);
    const result = await take.done;
    expect(result.recognised).toBe(false);
    expect(result.blob.size).toBeGreaterThan(0);
  });

  it('says why when the microphone cannot be opened', async () => {
    const blocked = startTake({ lang: 'en', scope: fakeBrowser({ micError: Object.assign(new Error('x'), { name: 'NotAllowedError' }) }).scope });
    await expect(blocked.done).rejects.toMatchObject({ code: 'mic-blocked' });
    const missing = startTake({ lang: 'en', scope: fakeBrowser({ micError: Object.assign(new Error('x'), { name: 'NotFoundError' }) }).scope });
    await expect(missing.done).rejects.toMatchObject({ code: 'no-mic' });
  });

  it('records with the microphone it is given', async () => {
    const { scope, state } = fakeBrowser({ levels: [...loud(5), ...quiet(60)] });
    const take = startTake({ lang: 'en', deviceId: 'mic-2', scope });
    await vi.advanceTimersByTimeAsync(6000);
    const result = await take.done;
    expect(state.constraints.audio.deviceId).toEqual({ exact: 'mic-2' });
    expect(result.usedDefault).toBe(false);
  });

  it('asks for no microphone in particular when none is given', async () => {
    const { scope, state } = fakeBrowser({ levels: [...loud(5), ...quiet(60)] });
    const take = startTake({ lang: 'en', scope });
    await vi.advanceTimersByTimeAsync(6000);
    await take.done;
    expect('deviceId' in state.constraints.audio).toBe(false);
  });

  it('records with the default, and says so, when the one it was given is not there', async () => {
    const { scope, state } = fakeBrowser({ levels: [...loud(5), ...quiet(60)] });
    const open = scope.navigator.mediaDevices.getUserMedia;
    scope.navigator.mediaDevices.getUserMedia = async (constraints) => {
      if (constraints.audio.deviceId) throw Object.assign(new Error('x'), { name: 'OverconstrainedError' });
      return open(constraints);
    };
    const take = startTake({ lang: 'en', deviceId: 'unplugged', scope });
    await vi.advanceTimersByTimeAsync(6000);
    const result = await take.done;
    expect(result.usedDefault).toBe(true);
    expect(result.ended).toBe('quiet');
    expect('deviceId' in state.constraints.audio).toBe(false);
  });

  // A paragraph: the reader breathes between sentences.
  it('waits out a longer silence when asked to', async () => {
    const levels = [...loud(5), ...quiet(30), ...loud(5), ...quiet(80)]; // 1.8 s of quiet in the middle
    const short = startTake({ lang: 'en', scope: fakeBrowser({ levels }).scope });
    await vi.advanceTimersByTimeAsync(60 * 34);
    await vi.advanceTimersByTimeAsync(3000);
    expect((await short.done).seconds).toBeLessThan(2);

    const long = startTake({ lang: 'en', quietMs: 2500, scope: fakeBrowser({ levels }).scope });
    let done = false;
    long.done.then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(60 * 38); // past the breath, into the second sentence
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(8000);
    const result = await long.done;
    expect(result.ended).toBe('quiet');
    expect(result.seconds).toBeGreaterThan(4);
  });

  it('can be stopped before the microphone has even opened', async () => {
    const { scope } = fakeBrowser({ levels: loud(500) });
    const take = startTake({ lang: 'en', scope });
    take.stop();
    await vi.advanceTimersByTimeAsync(3000);
    await expect(take.done).resolves.toMatchObject({ ended: 'nothing' });
  });
});

describe('the microphone chosen in Settings', () => {
  const device = (deviceId, label, kind = 'audioinput') => ({ deviceId, label, kind });
  const scopeWith = (devices) => ({ navigator: { mediaDevices: { enumerateDevices: async () => devices } } });

  it('is read back as it was saved', async () => {
    const saved = { id: 'mic-2', label: 'USB microphone' };
    expect(await readMicChoice({ get: async () => ({ [MIC_CHOICE_KEY]: saved }) })).toEqual(saved);
  });

  it('is none where nothing usable was saved', async () => {
    expect(await readMicChoice({ get: async () => ({}) })).toBeNull();
    expect(await readMicChoice({ get: async () => ({ [MIC_CHOICE_KEY]: { id: '' } }) })).toBeNull();
    expect(await readMicChoice({ get: async () => ({ [MIC_CHOICE_KEY]: 'mic-2' }) })).toBeNull();
    expect(await readMicChoice({ get: async () => { throw new Error('no storage'); } })).toBeNull();
    expect(await readMicChoice(undefined)).toBeNull();
  });

  // Chrome lists the default microphone twice more, as "default" and "communications".
  it('lists each microphone once, by name, and says which the system uses', async () => {
    const found = await listMicrophones(scopeWith([
      device('default', 'Default - Headset (USB)'),
      device('communications', 'Communications - Headset (USB)'),
      device('a1', 'Headset (USB)'),
      device('b2', 'Webcam'),
      device('s1', 'Speakers', 'audiooutput'),
      device('c1', 'Camera', 'videoinput'),
    ]));
    expect(found.devices).toEqual([{ id: 'a1', label: 'Headset (USB)' }, { id: 'b2', label: 'Webcam' }]);
    expect(found.usual).toBe('Headset (USB)');
    expect(found.named).toBe(true);
  });

  // Until the page has been allowed a microphone, the browser gives no names.
  it('says so when the browser is keeping the names to itself', async () => {
    const found = await listMicrophones(scopeWith([device('', ''), device('', '', 'videoinput')]));
    expect(found.devices).toEqual([]);
    expect(found.named).toBe(false);
    expect(found.usual).toBe('');
  });

  it('is an empty list, not an error, where the browser cannot say', async () => {
    expect((await listMicrophones({})).devices).toEqual([]);
    expect((await listMicrophones({ navigator: { mediaDevices: { enumerateDevices: async () => { throw new Error('x'); } } } })).devices).toEqual([]);
  });

  it('is opened by its id, and not swapped for another when it is merely blocked', async () => {
    const asked = [];
    const scope = { navigator: { mediaDevices: { getUserMedia: async (constraints) => { asked.push(constraints.audio.deviceId); throw Object.assign(new Error('x'), { name: 'NotAllowedError' }); } } } };
    await expect(openMicrophone('mic-2', scope)).rejects.toMatchObject({ code: 'mic-blocked' });
    expect(asked).toEqual([{ exact: 'mic-2' }]); // once: no second try on the default
  });

  it('says there is no microphone when the default is missing too', async () => {
    const scope = { navigator: { mediaDevices: { getUserMedia: async () => { throw Object.assign(new Error('x'), { name: 'NotFoundError' }); } } } };
    await expect(openMicrophone('mic-2', scope)).rejects.toMatchObject({ code: 'no-mic' });
  });
});

describe('decodeTake', () => {
  it('gives the take as one channel of samples', async () => {
    const samples = await decodeTake(recording, { scope: fakeBrowser().scope });
    expect([...samples]).toEqual([0.5, 0.5, 0.5]); // two channels, averaged
  });
});

describe('recogniseRecording', () => {
  it('plays the recording to the recogniser and returns what it wrote', async () => {
    const { scope, state } = fakeBrowser();
    const second = recogniseRecording(recording, 'en', { scope });
    await vi.advanceTimersByTimeAsync(700);
    state.recognitions[0].write('the light');
    await vi.advanceTimersByTimeAsync(6000);
    await expect(second).resolves.toBe('the light');
    expect(state.playedBuffers).toBe(1);
    expect(state.recognitions[0].processLocally).toBe(true);
    expect(state.contextsClosed).toBe(1);
  });

  it('is empty rather than an error when that fails too', async () => {
    const { scope } = fakeBrowser({ startThrows: true });
    await expect(recogniseRecording(recording, 'en', { scope })).resolves.toBe('');
    await expect(recogniseRecording(recording, 'yue', { scope })).resolves.toBe('');
  });
});
