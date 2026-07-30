import { describe, expect, it, vi } from 'vitest';
import {
  checkNativeSpeechAvailability,
  configureNativeRecognition,
  hasNativeSpeechSupport,
  nativeSpeechConstructor,
  nativeSpeechOptions,
  normalizeSpeechLanguage,
} from '../src/lib/native-speech.js';

function fakeRecognition(status = 'available') {
  class Recognition {
    unspokenPunctuation = false;
  }
  Object.defineProperty(Recognition.prototype, 'processLocally', {
    configurable: true,
    get() { return this._processLocally || false; },
    set(value) { this._processLocally = value; },
  });
  Recognition.available = vi.fn(async () => status);
  return Recognition;
}

describe('native speech configuration', () => {
  it('normalizes BCP-47 languages and safely falls back', () => {
    expect(normalizeSpeechLanguage('ja_jp')).toBe('ja-JP');
    expect(normalizeSpeechLanguage('not a locale')).toBe('en-US');
    expect(normalizeSpeechLanguage('')).toBe('en-US');
  });

  it('always requests Chrome local SODA recognition', () => {
    expect(nativeSpeechOptions('en_us')).toEqual({
      langs: ['en-US'],
      processLocally: true,
      quality: 'command',
    });
  });

  it('accepts the prefixed Chrome constructor', () => {
    const Recognition = fakeRecognition();
    expect(nativeSpeechConstructor({ webkitSpeechRecognition: Recognition })).toBe(Recognition);
  });

  it('rejects the legacy cloud-only Web Speech surface', async () => {
    class LegacyRecognition {}
    LegacyRecognition.available = vi.fn(async () => 'available');
    expect(hasNativeSpeechSupport(LegacyRecognition)).toBe(false);
    expect(await checkNativeSpeechAvailability(LegacyRecognition, 'en-US')).toBe('unsupported');
  });

  it('passes local-only options into Chrome availability checks', async () => {
    const Recognition = fakeRecognition('downloadable');
    expect(await checkNativeSpeechAvailability(Recognition, 'en-US')).toBe('downloadable');
    expect(Recognition.available).toHaveBeenCalledWith({
      langs: ['en-US'],
      processLocally: true,
      quality: 'command',
    });
  });

  it('configures continuous local recognition without a cloud fallback', () => {
    const recognition = configureNativeRecognition(new (fakeRecognition())(), 'en-US');
    expect(recognition).toMatchObject({
      lang: 'en-US',
      processLocally: true,
      continuous: true,
      interimResults: true,
      maxAlternatives: 1,
      unspokenPunctuation: true,
    });
  });
});
