// Shared configuration for Chrome's on-device Web Speech API.
//
// SpeechRecognition is exposed only in Window contexts, so the service worker
// cannot use it directly. The offscreen document performs availability checks
// and recognition; the setup page owns the user gesture required to install a
// missing language resource.

// Chrome 150 maps "command" to SODA, the engine used by Live Caption.
// "dictation" selects the newer TinyGemma speech model, which is feature-gated
// and therefore reports "unavailable" on many otherwise supported Chrome
// installations.
export const NATIVE_SPEECH_QUALITY = 'command';

// The languages Chrome documents for on-device recognition, in the W3C explainer's
// own order. Chrome's available() answers "downloadable" for ANY well-formed tag —
// measured: every tag, in 0 ms, including ones absent from this list — so it cannot
// be used to discover what actually exists. This list is what the picker offers; the
// truth about a given language only emerges from install().
//
// Chinese is Mandarin written in Traditional characters, and only that: Chrome's
// zh-CN model writes Simplified, which OWL-Note does not offer. Chrome has no
// on-device Cantonese model (yue-HK answers "unavailable").
export const ON_DEVICE_LANGUAGES = [
  { tag: 'en-US', label: 'English (United States)' },
  { tag: 'de-DE', label: 'German (Germany)' },
  { tag: 'es-ES', label: 'Spanish (Spain)' },
  { tag: 'fr-FR', label: 'French (France)' },
  { tag: 'hi-IN', label: 'Hindi (India)' },
  { tag: 'id-ID', label: 'Indonesian (Indonesia)' },
  { tag: 'it-IT', label: 'Italian (Italy)' },
  { tag: 'ja-JP', label: 'Japanese (Japan)' },
  { tag: 'ko-KR', label: 'Korean (South Korea)' },
  { tag: 'pl-PL', label: 'Polish (Poland)' },
  { tag: 'pt-BR', label: 'Portuguese (Brazil)' },
  { tag: 'ru-RU', label: 'Russian (Russia)' },
  { tag: 'th-TH', label: 'Thai (Thailand)' },
  { tag: 'tr-TR', label: 'Turkish (Turkey)' },
  { tag: 'vi-VN', label: 'Vietnamese (Vietnam)' },
  { tag: 'zh-TW', label: 'Chinese, Mandarin (Traditional)' },
];

// Packs Chrome needs installed alongside a language before it will use it. Measured
// on Chrome 156, three fresh profiles: zh-TW's own pack (cmn-Hant-TW) downloads in
// full and install() resolves true, yet available() stays "downloadable" for good —
// across restarts, with English installed first or not — until zh-CN's pack
// (cmn-Hans-CN) is installed too, at which moment zh-TW turns "available". The
// companion is only ever installed, never recognized with, so transcripts stay
// Traditional. One install() call naming both takes a single click; two calls do
// not, because the first consumes the gesture and the second is refused.
export const SPEECH_PACK_COMPANIONS = { 'zh-TW': ['zh-CN'] };

export function speechPacksFor(lang) {
  const tag = normalizeSpeechLanguage(lang);
  return [tag, ...(SPEECH_PACK_COMPANIONS[tag] || [])];
}

// Where the chosen language is remembered. Device-local: it describes which model
// this machine has, which says nothing about any other machine.
export const SPEECH_LANG_KEY = 'owl:speechLang';

/**
 * The language to start with, from a saved choice or the browser's UI language.
 * Every Chinese tag means Traditional Mandarin here: zh-HK is a trap on its own —
 * Chrome offers it as "downloadable", then hangs on "downloading" forever while
 * fetching the Simplified pack — and zh-CN is Simplified, which is not offered.
 */
export function pickSpeechLanguage(tag) {
  const lang = normalizeSpeechLanguage(tag);
  return /^(zh|cmn)(-|$)/i.test(lang) ? 'zh-TW' : lang;
}

// The language's own name for itself, short enough for a button: English, 中文,
// 日本語. Falls back to the tag where Intl has no name.
export function speechLanguageName(tag) {
  const lang = normalizeSpeechLanguage(tag);
  try {
    return new Intl.DisplayNames([lang], { type: 'language' }).of(lang.split('-')[0]) || lang;
  } catch {
    return lang;
  }
}

export function normalizeSpeechLanguage(tag) {
  const candidate = String(tag || '').trim().replace(/_/g, '-');
  if (!candidate) return 'en-US';
  try {
    return Intl.getCanonicalLocales(candidate)[0] || 'en-US';
  } catch {
    return 'en-US';
  }
}

export function nativeSpeechOptions(lang) {
  return {
    langs: [normalizeSpeechLanguage(lang)],
    processLocally: true,
    // Explicitly select Chrome's widely available SODA/Live Caption path.
    // Older Chrome versions ignore unknown dictionary members.
    quality: NATIVE_SPEECH_QUALITY,
  };
}

// Chrome's speech calls are awaited directly, and on a language it has no model for
// they can simply never settle — reported as "clicked Enable, nothing happened" and
// an overlay stuck on "Checking Chrome's local speech model…" indefinitely. Nothing
// downstream can recover from a promise that never resolves, so every call into the
// API is raced against a deadline and a hang is turned into an answer.
export const SPEECH_CALL_TIMEOUT_MS = 15000;

export function withSpeechTimeout(promise, ms = SPEECH_CALL_TIMEOUT_MS) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(Symbol.for('owl.speech.timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function isSpeechTimeout(value) {
  return value === Symbol.for('owl.speech.timeout');
}

export function nativeSpeechConstructor(scope = globalThis) {
  return scope?.SpeechRecognition || scope?.webkitSpeechRecognition || null;
}

export function hasNativeSpeechSupport(Recognition) {
  return typeof Recognition === 'function'
    && typeof Recognition.available === 'function'
    && Recognition.prototype
    && 'processLocally' in Recognition.prototype;
}

export async function checkNativeSpeechAvailability(Recognition, lang) {
  if (!hasNativeSpeechSupport(Recognition)) return 'unsupported';
  try {
    const result = await withSpeechTimeout(Recognition.available(nativeSpeechOptions(lang)));
    // Reported separately from 'unavailable': one is Chrome answering "no model for
    // that language", the other is Chrome not answering at all. Telling a user the
    // wrong one sends them looking in the wrong place.
    if (isSpeechTimeout(result)) return 'timeout';
    return ['available', 'downloadable', 'downloading', 'unavailable'].includes(result)
      ? result
      : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

// install() resolves only once the download is done, which is no quick answer: the
// two Mandarin packs took 19.5 s on one connection and English alone over 30 s on
// another. The deadline exists for a call that never settles, so it is set well past
// a slow real download — at 15 s, a successful install was reported as a failure.
export const SPEECH_INSTALL_TIMEOUT_MS = 180000;

// install() can hang the same way, and it runs behind a disabled button, so a hang
// leaves the page with no controls at all. Resolves false rather than never.
export async function installNativeSpeech(Recognition, lang, ms = SPEECH_INSTALL_TIMEOUT_MS) {
  try {
    const options = { ...nativeSpeechOptions(lang), langs: speechPacksFor(lang) };
    const result = await withSpeechTimeout(Recognition.install(options), ms);
    return isSpeechTimeout(result) ? { ok: false, timedOut: true } : { ok: !!result, timedOut: false };
  } catch (error) {
    return { ok: false, timedOut: false, error };
  }
}

export function configureNativeRecognition(recognition, lang) {
  recognition.lang = normalizeSpeechLanguage(lang);
  recognition.processLocally = true;
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;
  if ('unspokenPunctuation' in recognition) recognition.unspokenPunctuation = true;
  return recognition;
}
