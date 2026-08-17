import { describe, it, expect, vi } from 'vitest';
import {
  checkNativeSpeechAvailability,
  installNativeSpeech,
  withSpeechTimeout,
  isSpeechTimeout,
  SPEECH_CALL_TIMEOUT_MS,
  ON_DEVICE_LANGUAGES,
  SPEECH_LANG_KEY,
} from '../src/lib/native-speech.js';

// Chrome's speech calls can simply never settle on a language it has no model for —
// reported as "clicked Enable, nothing happened", and an overlay stuck on
// "Checking Chrome's local speech model…" indefinitely. Nothing downstream can
// recover from a promise that never resolves, so these pin the deadline.
const hanging = () => new Promise(() => {});

const fakeRecognition = (impl) => {
  const R = function SpeechRecognition() {};
  R.prototype.processLocally = true;
  R.available = impl.available ?? (async () => 'available');
  R.install = impl.install ?? (async () => true);
  return R;
};

describe('speech calls cannot hang the UI', () => {
  it('reports timeout rather than waiting forever on available()', async () => {
    vi.useFakeTimers();
    const R = fakeRecognition({ available: hanging });
    const pending = checkNativeSpeechAvailability(R, 'zh-TW');
    await vi.advanceTimersByTimeAsync(SPEECH_CALL_TIMEOUT_MS + 10);
    expect(await pending).toBe('timeout');
    vi.useRealTimers();
  });

  it('reports timeout rather than waiting forever on install()', async () => {
    vi.useFakeTimers();
    const R = fakeRecognition({ install: hanging });
    const pending = installNativeSpeech(R, 'zh-TW');
    await vi.advanceTimersByTimeAsync(SPEECH_CALL_TIMEOUT_MS + 10);
    expect(await pending).toEqual({ ok: false, timedOut: true });
    vi.useRealTimers();
  });

  // A timeout is Chrome not answering; 'unavailable' is Chrome answering "no".
  // Collapsing them would point the reader at the wrong problem.
  it('keeps timeout distinct from a genuine unavailable answer', async () => {
    const R = fakeRecognition({ available: async () => 'unavailable' });
    expect(await checkNativeSpeechAvailability(R, 'zh-TW')).toBe('unavailable');
  });

  it('passes a real answer straight through', async () => {
    for (const state of ['available', 'downloadable', 'downloading', 'unavailable']) {
      const R = fakeRecognition({ available: async () => state });
      expect(await checkNativeSpeechAvailability(R, 'en-US')).toBe(state);
    }
  });

  it('turns a rejected install into a definite answer, not a hang', async () => {
    const R = fakeRecognition({ install: async () => { throw new Error('nope'); } });
    const result = await installNativeSpeech(R, 'zh-TW');
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(false);
  });

  it('reports a refused install as not-ok', async () => {
    const R = fakeRecognition({ install: async () => false });
    expect(await installNativeSpeech(R, 'zh-TW')).toMatchObject({ ok: false, timedOut: false });
  });

  it('resolves normally well inside the deadline', async () => {
    const R = fakeRecognition({ install: async () => true });
    expect(await installNativeSpeech(R, 'en-US')).toMatchObject({ ok: true, timedOut: false });
  });
});

describe('withSpeechTimeout', () => {
  it('yields the value when the promise settles first', async () => {
    expect(await withSpeechTimeout(Promise.resolve('ok'), 1000)).toBe('ok');
  });

  it('yields the timeout marker when it does not', async () => {
    vi.useFakeTimers();
    const pending = withSpeechTimeout(hanging(), 50);
    await vi.advanceTimersByTimeAsync(60);
    expect(isSpeechTimeout(await pending)).toBe(true);
    vi.useRealTimers();
  });

  it('does not mistake a normal value for the timeout marker', () => {
    expect(isSpeechTimeout('available')).toBe(false);
    expect(isSpeechTimeout(undefined)).toBe(false);
    expect(isSpeechTimeout(null)).toBe(false);
  });
});

// Chrome's available() answers "downloadable" for ANY well-formed tag — measured on
// Chrome 151: every tag, in 0 ms, including ones absent from Chrome's own documented
// list. So it cannot be used to discover which languages exist, and the picker has to
// offer a known list instead.
describe('the on-device language list', () => {
  it('matches the tags Chrome documents, so the picker offers real options', () => {
    expect(ON_DEVICE_LANGUAGES.map((e) => e.tag).sort()).toEqual([
      'de-DE', 'en-US', 'es-ES', 'fr-FR', 'hi-IN', 'id-ID', 'it-IT', 'ja-JP', 'ko-KR',
      'pl-PL', 'pt-BR', 'ru-RU', 'th-TH', 'tr-TR', 'vi-VN', 'zh-CN', 'zh-TW',
    ]);
  });

  it('gives every entry a human label, since a bare tag is not a choice', () => {
    for (const entry of ON_DEVICE_LANGUAGES) {
      expect(entry.label).toBeTruthy();
      expect(entry.label).not.toBe(entry.tag);
    }
  });

  it('leads with English, the fallback when the browser language is not offered', () => {
    expect(ON_DEVICE_LANGUAGES[0].tag).toBe('en-US');
  });

  it('names a storage key for the chosen language', () => {
    expect(SPEECH_LANG_KEY).toBe('owl:speechLang');
  });
});
