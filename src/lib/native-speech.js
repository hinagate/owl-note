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
    const result = await Recognition.available(nativeSpeechOptions(lang));
    return ['available', 'downloadable', 'downloading', 'unavailable'].includes(result)
      ? result
      : 'unavailable';
  } catch {
    return 'unavailable';
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
