import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let originalMediaDevices;

beforeEach(() => {
  vi.resetModules();
  originalMediaDevices = Object.getOwnPropertyDescriptor(globalThis.navigator, 'mediaDevices');
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalMediaDevices) {
    Object.defineProperty(globalThis.navigator, 'mediaDevices', originalMediaDevices);
  } else {
    delete globalThis.navigator.mediaDevices;
  }
});

describe('offscreen native transcription', () => {
  it('checks local availability, starts on the captured track, and emits final cues', async () => {
    let messageListener;
    const sent = [];
    const track = {
      readyState: 'live',
      stop: vi.fn(),
      addEventListener: vi.fn(),
    };
    const stream = {
      getAudioTracks: () => [track],
      getTracks: () => [track],
    };

    class Recognition {
      static instances = [];

      static available = vi.fn(async () => 'available');

      unspokenPunctuation = false;

      constructor() {
        Recognition.instances.push(this);
      }

      start = vi.fn((audioTrack) => {
        this.audioTrack = audioTrack;
        this.onstart?.();
      });

      abort = vi.fn();
    }
    Object.defineProperty(Recognition.prototype, 'processLocally', {
      configurable: true,
      get() { return this._processLocally || false; },
      set(value) { this._processLocally = value; },
    });

    class FakeAudioContext {
      destination = {};

      createMediaStreamSource = vi.fn(() => ({ connect: vi.fn() }));

      resume = vi.fn(async () => {});

      close = vi.fn(async () => {});
    }

    vi.stubGlobal('chrome', {
      runtime: {
        onMessage: { addListener: (listener) => { messageListener = listener; } },
        sendMessage: vi.fn(async (message) => { sent.push(message); }),
      },
    });
    vi.stubGlobal('SpeechRecognition', Recognition);
    vi.stubGlobal('AudioContext', FakeAudioContext);
    Object.defineProperty(globalThis.navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => stream) },
    });

    await import('../src/offscreen/offscreen.js');

    messageListener({
      target: 'offscreen',
      type: 'owl-offscreen-prepare',
      lang: 'en-US',
      sessionToken: '42:1000',
    });
    await vi.waitFor(() => {
      expect(sent).toContainEqual({
        type: 'owl-native-speech-ready',
        lang: 'en-US',
        sessionToken: '42:1000',
      });
    });

    messageListener({
      target: 'offscreen',
      type: 'owl-offscreen-start',
      streamId: 'stream-1',
      lang: 'en-US',
      sessionToken: '42:1000',
    });
    await vi.waitFor(() => expect(Recognition.instances).toHaveLength(1));

    const recognition = Recognition.instances[0];
    expect(recognition).toMatchObject({
      lang: 'en-US',
      processLocally: true,
      continuous: true,
      interimResults: true,
      maxAlternatives: 1,
      unspokenPunctuation: true,
    });
    expect(recognition.start).toHaveBeenCalledWith(track);

    const interimResult = [{ transcript: 'native caption' }];
    interimResult.isFinal = false;
    recognition.onresult({ resultIndex: 0, results: [interimResult] });
    expect(sent).toContainEqual({ type: 'owl-interim', text: 'native caption' });

    const finalResult = [{ transcript: 'native caption text' }];
    finalResult.isFinal = true;
    recognition.onresult({ resultIndex: 0, results: [finalResult] });

    expect(sent).toContainEqual({
      type: 'owl-cue',
      cues: [expect.objectContaining({
        text: 'native caption text',
        videoTime: null,
        at: expect.any(Number),
      })],
    });
  });
});
