import { describe, expect, it, vi } from 'vitest';
import {
  checkNativeSpeechAvailability,
  configureNativeRecognition,
  hasNativeSpeechSupport,
  installNativeSpeech,
  nativeSpeechConstructor,
  nativeSpeechOptions,
  normalizeSpeechLanguage,
  pickSpeechLanguage,
  speechLanguageName,
  speechPacksFor,
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

  // zh-HK hangs on "downloading" forever while fetching the Simplified pack, and
  // zh-CN is Simplified: every Chinese tag starts as Traditional Mandarin.
  it('starts every Chinese browser language as Traditional Mandarin', () => {
    for (const tag of ['zh-HK', 'zh_hk', 'zh-MO', 'zh-CN', 'zh-SG', 'zh', 'zh-Hant', 'zh-TW', 'cmn-Hant-TW']) {
      expect(pickSpeechLanguage(tag)).toBe('zh-TW');
    }
    expect(pickSpeechLanguage('ja-JP')).toBe('ja-JP');
    expect(pickSpeechLanguage('en_us')).toBe('en-US');
    expect(pickSpeechLanguage('')).toBe('en-US');
  });

  // Chrome leaves zh-TW "downloadable" until zh-CN's pack is installed too.
  it('installs the pack Traditional Mandarin depends on, in the same single call', async () => {
    expect(speechPacksFor('zh-TW')).toEqual(['zh-TW', 'zh-CN']);
    expect(speechPacksFor('en-US')).toEqual(['en-US']);
    const Recognition = fakeRecognition();
    Recognition.install = vi.fn(async () => true);
    expect(await installNativeSpeech(Recognition, 'zh-TW')).toMatchObject({ ok: true });
    // One call, both packs: a second install() call would find the gesture spent.
    expect(Recognition.install).toHaveBeenCalledTimes(1);
    expect(Recognition.install).toHaveBeenCalledWith({
      langs: ['zh-TW', 'zh-CN'],
      processLocally: true,
      quality: 'command',
    });
  });

  it('checks Traditional Mandarin on its own, not with the pack it depends on', async () => {
    const Recognition = fakeRecognition('available');
    await checkNativeSpeechAvailability(Recognition, 'zh-TW');
    expect(Recognition.available).toHaveBeenCalledWith(expect.objectContaining({ langs: ['zh-TW'] }));
  });

  it('names each language in its own words, short enough for a button', () => {
    expect(speechLanguageName('zh-TW')).toBe('中文');
    expect(speechLanguageName('ja-JP')).toBe('日本語');
    expect(speechLanguageName('en-US')).toBe('English');
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
