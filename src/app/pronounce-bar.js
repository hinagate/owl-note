// With Phonetic Assistance on, selecting a word in the preview offers to read it aloud: a
// small bar beside the selection, with a speaker and a Slow switch.
//
// Speech comes from the browser's own speechSynthesis, which needs no permission and no
// download. A voice on this computer keeps everything on the device. An online voice sends
// the selected text to the browser's provider, so the reader is asked before the first one
// is used, and can turn the permission off again from the same bar.
//
// Which voice reads is normally worked out here. A reader who chose one in Settings gets
// that voice instead, for as long as the browser still lists it.

import {
  MAX_PASSAGE_CHARS, MAX_PRACTICE_CHARS, MAX_SPOKEN_CHARS, createVoiceSource, languageName, rateFor, readVoiceChoices, selectionLanguage, spokenText,
  voiceProvider,
} from '../lib/pronounce.js';
import { compareReadings, compareWords } from '../lib/speech-check.js';
import { melodyOf, trackVoice } from '../lib/voice-melody.js';
import {
  SPEECH_TAGS, decodeTake, installSpeech, readMicChoice, recogniseRecording, speechReadiness, startTake,
} from '../lib/voice-take.js';
import { createPracticePanel } from './practice-panel.js';

const SLOW_KEY = 'owl:pronounceSlow';
const ONLINE_OK_KEY = 'owl:pronounceOnlineOk';
// An online voice with no connection can say nothing at all, not even that it failed.
const START_TIMEOUT_MS = 8000;
const GAP = 8;

// Drawn rather than an emoji, which Windows renders too pale at this size and which then
// reads as a disabled button.
function speakerIcon() {
  const SVG = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('aria-hidden', 'true');
  const body = document.createElementNS(SVG, 'path');
  body.setAttribute('d', 'M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4z');
  body.setAttribute('fill', 'currentColor');
  const waves = document.createElementNS(SVG, 'path');
  waves.setAttribute('d', 'M15 9a4 4 0 0 1 0 6M17.5 6.5a7.5 7.5 0 0 1 0 11');
  waves.setAttribute('fill', 'none');
  waves.setAttribute('stroke', 'currentColor');
  waves.setAttribute('stroke-width', '2');
  waves.setAttribute('stroke-linecap', 'round');
  svg.append(body, waves);
  svg.classList.add('pronounce-icon-speaker');
  return svg;
}

// Shown in the speaker's place while a passage is being read: the same button stops it.
function stopIcon() {
  const SVG = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('pronounce-icon-stop');
  const square = document.createElementNS(SVG, 'rect');
  square.setAttribute('x', '6.5');
  square.setAttribute('y', '6.5');
  square.setAttribute('width', '11');
  square.setAttribute('height', '11');
  square.setAttribute('rx', '2');
  square.setAttribute('fill', 'currentColor');
  svg.append(square);
  return svg;
}

// The other half of practice: the reader says it, and the bar listens.
function micIcon() {
  const SVG = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('pronounce-icon-mic');
  const capsule = document.createElementNS(SVG, 'rect');
  capsule.setAttribute('x', '9');
  capsule.setAttribute('y', '3');
  capsule.setAttribute('width', '6');
  capsule.setAttribute('height', '11');
  capsule.setAttribute('rx', '3');
  capsule.setAttribute('fill', 'currentColor');
  const stand = document.createElementNS(SVG, 'path');
  stand.setAttribute('d', 'M6 11a6 6 0 0 0 12 0M12 17v4');
  stand.setAttribute('fill', 'none');
  stand.setAttribute('stroke', 'currentColor');
  stand.setAttribute('stroke-width', '2');
  stand.setAttribute('stroke-linecap', 'round');
  svg.append(capsule, stand);
  return svg;
}

// More than a phrase. Only a voice on this device reads one, and it can be stopped.
const isPassage = (text) => String(text || '').length > MAX_SPOKEN_CHARS;

// Samples a second the take is measured at: all that the pitch of a voice needs.
const TAKE_RATE = 16000;

// How long a take may run: time to say the words slowly, with room to start late.
const takeLimitMs = (text) => Math.min(180000, Math.max(6000, 4000 + String(text).length * 180));
// How long a silence ends the take. A reader part-way through a paragraph stops to breathe
// between sentences, or to work out a hard word, and must not be cut off there.
const takeQuietMs = (text) => (isPassage(text) ? 2500 : 1400);
// A take the recogniser made nothing of is played to it once more, which takes as long as
// the take did. Past this, that is too long to be kept waiting.
const SECOND_HEARING_S = 30;

// The same regions annotateRuby leaves alone: no reading is shown there, so there is
// nothing to practise.
const NO_READING = 'code, pre, kbd, samp, .katex, .mermaid-diagram';

const UNAVAILABLE = { prime() {}, hide() {}, destroy() {} };

// One per page, not per bar. The app builds a new editor for every note, and a list started
// afresh each time would make the speaker wait again after every switch of note.
const voiceSources = new WeakMap();
function voiceSourceFor(synth) {
  if (!voiceSources.has(synth)) voiceSources.set(synth, createVoiceSource(synth));
  return voiceSources.get(synth);
}

/**
 * @param {{ root: Element, isActive: () => boolean, synth?: SpeechSynthesis,
 *   Utterance?: typeof SpeechSynthesisUtterance, storage?: chrome.storage.StorageArea,
 *   voiceSource?: ReturnType<typeof createVoiceSource> }} options
 */
export function createPronounceBar({
  root,
  isActive,
  synth = globalThis.speechSynthesis,
  Utterance = globalThis.SpeechSynthesisUtterance,
  storage = globalThis.chrome?.storage?.local,
  voiceSource = null,
  // For speaking practice. `readingOf` gives a word's IPA, which is how two spellings of
  // one spoken word (their, there) are known to be the same; `segmenter` gives the
  // function that cuts text into words with readings, which Japanese is compared by.
  readingOf = null,
  segmenter = null,
  scope = globalThis,
}) {
  if (!synth || !Utterance) return UNAVAILABLE;

  const voices = voiceSource || voiceSourceFor(synth);
  let bar = null;
  let els = null;
  let take = null;  // the recording in progress, if the microphone is open
  let panel = null; // what the last take showed
  let selection = null; // { text, lang } of what the bar is showing for
  let attempt = 0; // a newer click, or a closed bar, abandons whatever was waiting
  let current = null; // Chrome can drop an utterance nothing refers to, and its events with it
  let startTimer = null;
  let destroyed = false;

  const read = async (key) => {
    try { return (await storage?.get(key))?.[key]; } catch { return undefined; }
  };
  const write = async (key, value) => {
    try { await storage?.set({ [key]: value }); } catch { /* the choice just lasts this page */ }
  };

  const liveRange = () => {
    const sel = globalThis.getSelection?.();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    return root.contains(range.commonAncestorContainer) ? range : null;
  };

  const showNote = (message, actions = []) => {
    els.note.replaceChildren();
    els.note.hidden = !message;
    if (message) {
      const text = document.createElement('div');
      text.textContent = message;
      els.note.append(text);
    }
    if (actions.length) {
      const row = document.createElement('div');
      row.className = 'pronounce-note-actions';
      for (const { label, run, primary } of actions) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        if (primary) button.className = 'primary';
        button.addEventListener('click', run);
        row.append(button);
      }
      els.note.append(row);
    }
    place();
  };

  // The part of the page the preview is seen through: the nearest box that scrolls.
  const visibleArea = () => {
    for (let el = root; el && el !== document.body; el = el.parentElement) {
      const overflow = globalThis.getComputedStyle?.(el).overflowY;
      if (overflow === 'auto' || overflow === 'scroll') return el.getBoundingClientRect();
    }
    return root.getBoundingClientRect();
  };

  const place = () => {
    if (!bar) return;
    const range = liveRange();
    const rect = range?.getBoundingClientRect?.();
    if (!rect) return;
    const area = root.getBoundingClientRect();
    if (rect.bottom < area.top || rect.top > area.bottom) { hide(); return; } // scrolled away
    const { width, height } = bar.getBoundingClientRect();
    const above = rect.top - height - GAP;
    const below = rect.bottom + GAP;
    const fitsBelow = below + height <= globalThis.innerHeight - GAP;
    // Above the selection where it fits inside the preview, under it where it does not,
    // and failing both at the top of the preview. "Above" used to mean anywhere on the
    // page, which put a tall bar (a practice result, or a passage scrolled past its
    // start) over the toolbars, hiding their buttons.
    const view = visibleArea();
    const highest = Math.max(GAP, view.top + GAP);
    let top = highest;
    if (above >= highest) top = above;
    else if (fitsBelow) top = below;
    const left = Math.max(GAP, Math.min(rect.left + rect.width / 2 - width / 2, globalThis.innerWidth - width - GAP));
    bar.style.top = `${top}px`;
    bar.style.left = `${left}px`;
  };

  const labelPlay = (label) => {
    els.play.title = label;
    els.play.setAttribute('aria-label', label);
  };

  const stopWatching = () => {
    clearTimeout(startTimer);
    startTimer = null;
    if (!els) return;
    els.play.classList.remove('speaking', 'stoppable');
    labelPlay('Hear this');
  };

  const stopSpeaking = () => {
    attempt += 1;
    stopWatching();
    if (current) {
      current = null;
      synth.cancel();
    }
  };

  // The voice for a language, and whether it is one the reader chose in Settings.
  const voiceFor = async (lang) => {
    const preferred = (await readVoiceChoices(storage))[lang] || null;
    const voice = await voices.voiceFor(lang, preferred);
    return { voice, chosen: !!preferred && voice?.name === preferred };
  };

  const speak = (voice, chosen = false) => {
    const utterance = new Utterance(selection.text);
    utterance.voice = voice;
    utterance.lang = voice.lang;
    utterance.rate = rateFor(voice, els.slow.checked);
    const failed = () => {
      stopWatching();
      if (current !== utterance) return;
      current = null;
      if (!bar) return;
      if (!voice.localService) {
        showNote('Could not read this aloud. The online voice needs an internet connection.');
      } else if (chosen) {
        // A chosen voice is often an add-on with a part of its own that has to be running.
        showNote(`"${voice.name}" could not read this aloud. Check that it is running, or choose another voice in Settings.`);
      } else {
        showNote('Could not read this aloud.');
      }
    };
    utterance.onstart = () => {
      clearTimeout(startTimer);
      if (!els) return;
      els.play.classList.add('speaking');
      // A word is over before anyone could stop it. A passage is not.
      if (isPassage(utterance.text)) {
        els.play.classList.add('stoppable');
        labelPlay('Stop');
      }
    };
    utterance.onend = () => {
      stopWatching();
      if (current === utterance) current = null;
    };
    utterance.onerror = (event) => {
      // Cut off by the next word, or by leaving the note: both on purpose.
      if (event.error === 'canceled' || event.error === 'interrupted') return;
      failed();
    };
    current = utterance;
    synth.cancel();
    synth.speak(utterance);
    startTimer = setTimeout(() => {
      synth.cancel();
      failed();
    }, START_TIMEOUT_MS);
  };

  const askForOnline = (voice, turn, chosen) => {
    const provider = voiceProvider(voice);
    const who = provider ? `${provider}'s online voice` : 'your browser\'s online voice';
    const sentTo = provider || 'that voice service';
    const why = chosen
      ? `The ${languageName(selection.lang)} voice chosen in Settings is ${who}.`
      : `This computer has no ${languageName(selection.lang)} voice, so ${who} would read it.`;
    showNote(`${why} Whatever you select to hear goes to ${sentTo}.`, [
      {
        label: 'Allow',
        primary: true,
        run: async () => {
          await write(ONLINE_OK_KEY, true);
          if (turn !== attempt) return;
          showNote('');
          els.online.hidden = false;
          speak(voice, chosen);
        },
      },
      { label: 'Not now', run: () => { attempt += 1; showNote(''); } },
    ]);
  };

  const play = async () => {
    // While a passage is being read, the same button stops it.
    if (current && isPassage(current.text) && els.play.classList.contains('speaking')) {
      stopSpeaking();
      return;
    }
    // The voice and the microphone take turns: a take in progress is dropped, not kept
    // with the voice recorded over it.
    if (take) {
      take.stop();
      take = null;
      labelMic('Say it yourself', false);
      panel.clear();
    }
    attempt += 1;
    const turn = attempt;
    showNote('');
    const { text, lang } = selection;
    if (text.length > MAX_PASSAGE_CHARS) {
      showNote(`This is too long to read in one go. Select up to ${MAX_PASSAGE_CHARS.toLocaleString('en-US')} characters.`);
      return;
    }
    const { voice, chosen } = await voiceFor(lang);
    if (turn !== attempt) return;
    if (!voice) {
      showNote(`This computer has no ${languageName(lang)} voice.`);
      return;
    }
    // Checked before anything is asked or sent: an online voice gets a phrase, never a passage.
    if (!voice.localService && isPassage(text)) {
      const sentTo = voiceProvider(voice) || 'its provider';
      showNote(`An online voice reads up to ${MAX_SPOKEN_CHARS} characters at a time, because what it reads is sent to ${sentTo}. `
        + 'Select less, or choose a voice on this computer in Settings.');
      return;
    }
    if (!voice.localService && !(await read(ONLINE_OK_KEY))) {
      if (turn === attempt) askForOnline(voice, turn, chosen);
      return;
    }
    if (turn !== attempt) return;
    speak(voice, chosen);
  };

  // --- Saying it back ----------------------------------------------------------------
  // The reader hears the words, then says them. The take is recorded and written down by
  // the browser's on-device recogniser, and the two are shown against each other.

  const canPractise = (lang) => !!SPEECH_TAGS[lang] && !!scope.navigator?.mediaDevices?.getUserMedia
    && typeof scope.MediaRecorder === 'function';

  const labelMic = (label, recording) => {
    if (!els) return;
    els.mic.classList.toggle('recording', recording);
    els.mic.title = label;
    els.mic.setAttribute('aria-label', label);
  };

  // What was meant against what was heard, in the way each language can be compared.
  const compare = (text, heard, lang) => {
    if (lang === 'ja') {
      const segment = segmenter?.();
      if (!segment) return null;
      const kana = segment(heard).map((run) => run.reading || run.text).join('');
      return compareReadings(segment(text), kana);
    }
    const same = readingOf
      ? (a, b) => { const reading = readingOf(a); return !!reading && reading === readingOf(b); }
      : undefined;
    return compareWords(text, heard, same ? { same } : undefined);
  };

  // Whether the last take had its words checked. "Again" is the same take again, so a
  // reader who chose to just record is not asked about the speech pack a second time.
  let lastChecked = true;

  async function practise({ recognise = true } = {}) {
    if (take) { take.stop(); return; } // while the microphone is open, the same button ends the take
    lastChecked = recognise;
    const { text, lang } = selection;
    if (text.length > MAX_PRACTICE_CHARS) {
      showNote(`This is too long to say in one go. Select up to ${MAX_PRACTICE_CHARS.toLocaleString('en-US')} characters, about a paragraph.`);
      return;
    }
    stopSpeaking(); // the voice must not be what the microphone hears
    const turn = attempt;
    showNote('');
    panel.clear();

    let ready = 'skip';
    if (recognise) {
      ready = await speechReadiness(lang, scope);
      if (turn !== attempt || !bar) return;
    }
    if (ready === 'downloadable') {
      showNote(`Checking what you say needs Chrome's ${languageName(lang)} speech pack on this computer. `
        + 'It is downloaded once, and what you say never leaves the device.', [
        {
          label: 'Download',
          primary: true,
          run: async () => {
            showNote('Downloading the speech pack…');
            const installed = await installSpeech(lang, scope);
            if (turn !== attempt || !bar) return;
            if (installed) practise();
            else showNote('The speech pack could not be downloaded.', [{ label: 'Just record', run: () => practise({ recognise: false }) }]);
          },
        },
        { label: 'Just record', run: () => practise({ recognise: false }) },
      ]);
      return;
    }
    if (ready === 'downloading') {
      showNote('Chrome is still downloading the speech pack. Try again in a moment.');
      return;
    }

    const microphone = await readMicChoice(storage); // the one chosen in Settings, if any
    if (turn !== attempt || !bar) return;
    labelMic('Stop', true);
    panel.listening();
    place();
    const mine = startTake({
      lang,
      deviceId: microphone?.id || null,
      recognise: ready === 'available',
      maxMs: takeLimitMs(text),
      quietMs: takeQuietMs(text),
      onInterim: (heard) => { if (take === mine) panel?.listening(heard); },
      scope,
    });
    take = mine;
    let result = null;
    let failure = null;
    try { result = await mine.done; } catch (error) { failure = error; }
    if (take !== mine) return; // the bar closed, or moved on to another selection
    take = null;
    labelMic('Say it yourself', false);
    if (failure || result.ended === 'nothing') {
      panel.clear();
      if (!failure) showNote('Nothing was heard. Check the microphone and try again.');
      else if (failure.code === 'mic-blocked') showNote('OWL-Note is not allowed to use the microphone. Allow it for this page in the browser\'s site settings, then try again.');
      else if (failure.code === 'no-mic') showNote('No microphone was found on this computer.');
      else showNote('The microphone could not be used.');
      return;
    }
    // A recogniser that wrote nothing has not found every word missing: it has failed to
    // make the take out at all, and saying "0 words heard" would blame the speaker for it.
    const shown = panel;
    let heard = result.heard.trim();
    if (result.recognised && !heard && result.seconds <= SECOND_HEARING_S) {
      // Not the speaker's doing, so they are not asked to say it again: the recording is
      // played to the recogniser once more (lib/voice-take.js).
      shown.working('Listening to the recording…');
      place();
      heard = await recogniseRecording(result.blob, lang, { scope });
      if (panel !== shown || !bar) return;
    }
    const comparison = heard ? compare(text, heard, lang) : null;
    shown.show({ comparison, unclear: result.recognised && !heard, heard, blob: result.blob });
    // Better a take on the wrong microphone than none, but the reader should know.
    if (result.usedDefault) {
      showNote(`"${microphone?.label || 'The microphone chosen in Settings'}" was not found, so the computer's default microphone was used.`);
    }
    place();

    // The words are shown at once. The melody takes a moment to measure and follows.
    try {
      const samples = await decodeTake(result.blob, { scope });
      if (panel !== shown || !bar) return;
      shown.showMelody(melodyOf(trackVoice(samples, TAKE_RATE)), samples.length / TAKE_RATE);
      place();
    } catch { /* the recording could not be read back; the words stand on their own */ }
  }

  // Shown only where it applies: the reader has allowed online voices and this selection
  // would use one. Turning it off here is why "ask once" is not "ask once, forever".
  const showOnlineSwitch = async () => {
    const shown = selection;
    const [{ voice }, allowed] = await Promise.all([voiceFor(shown.lang), read(ONLINE_OK_KEY)]);
    if (!bar || shown !== selection) return;
    els.online.hidden = !(allowed && voice && !voice.localService);
    place();
  };

  const build = () => {
    bar = document.createElement('div');
    bar.className = 'pronounce-bar';
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Hear this selection');
    // Keeps the selection: a press here must not move it, or the bar would close itself.
    bar.addEventListener('mousedown', (event) => event.preventDefault());

    const playButton = document.createElement('button');
    playButton.type = 'button';
    playButton.className = 'pronounce-play';
    playButton.append(speakerIcon(), stopIcon());
    playButton.title = 'Hear this';
    playButton.setAttribute('aria-label', 'Hear this');
    playButton.addEventListener('click', play);

    const slowLabel = document.createElement('label');
    slowLabel.className = 'pronounce-slow';
    const slow = document.createElement('input');
    slow.type = 'checkbox';
    slow.addEventListener('change', () => write(SLOW_KEY, slow.checked));
    slowLabel.append(slow, 'Slow');

    const online = document.createElement('button');
    online.type = 'button';
    online.className = 'pronounce-online';
    online.textContent = 'Online voice ✕';
    online.title = 'Stop using online voices. You will be asked again next time.';
    online.hidden = true;
    online.addEventListener('click', async () => {
      attempt += 1;
      online.hidden = true;
      await write(ONLINE_OK_KEY, false);
      place();
    });

    const note = document.createElement('div');
    note.className = 'pronounce-note';
    note.hidden = true;

    const micButton = document.createElement('button');
    micButton.type = 'button';
    micButton.className = 'pronounce-mic';
    micButton.append(micIcon(), stopIcon());
    micButton.title = 'Say it yourself';
    micButton.setAttribute('aria-label', 'Say it yourself');
    micButton.hidden = true; // shown once the selection's language is known to be one that can be checked
    micButton.addEventListener('click', () => practise());

    panel = createPracticePanel({ onAgain: () => practise({ recognise: lastChecked }) });

    bar.append(playButton, micButton, slowLabel, online, note, panel.el);
    els = { play: playButton, mic: micButton, slow, online, note };
    read(SLOW_KEY).then((value) => { if (els?.slow === slow) slow.checked = !!value; });
    document.body.append(bar);
    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('keydown', onKeydown);
    document.addEventListener('scroll', place, true);
    globalThis.addEventListener('resize', hide);
  };

  function hide() {
    if (!bar) return;
    attempt += 1;
    document.removeEventListener('selectionchange', onSelectionChange);
    document.removeEventListener('keydown', onKeydown);
    document.removeEventListener('scroll', place, true);
    globalThis.removeEventListener('resize', hide);
    take?.stop(); // the microphone closes with the bar
    take = null;
    panel?.clear();
    panel = null;
    bar.remove();
    bar = null;
    els = null;
    selection = null;
    clearTimeout(startTimer); // a word already speaking carries on to its end
    // A passage does not: nobody is following it any more, and it could run for minutes.
    if (current && isPassage(current.text)) {
      current = null;
      synth.cancel();
    }
  }

  function onSelectionChange() {
    if (!liveRange()) hide();
  }

  function onKeydown(event) {
    if (event.key === 'Escape') hide();
  }

  const onMouseUp = (event) => {
    if (bar?.contains(event.target)) return;
    // The browser settles the selection after this event for a click inside an old one.
    setTimeout(() => {
      if (destroyed) return;
      if (!isActive()) { hide(); return; }
      const range = liveRange();
      const start = range?.startContainer;
      const element = start?.nodeType === 1 ? start : start?.parentElement;
      const text = range && !element?.closest(NO_READING) ? spokenText(range) : '';
      // Any length gets the bar. What may be read is settled on the press, once the voice
      // is known, so a selection that is too long is told why instead of getting nothing.
      const lang = text ? selectionLanguage(range, text) : null;
      if (!lang) { hide(); return; }
      if (selection?.text === text && selection.lang === lang) return; // already showing it
      hide();
      build();
      selection = { text, lang };
      els.mic.hidden = !canPractise(lang);
      voices.prime();
      place();
      showOnlineSwitch();
    }, 0);
  };
  document.addEventListener('mouseup', onMouseUp);

  return {
    prime: () => voices.prime(),
    hide,
    destroy() {
      destroyed = true;
      document.removeEventListener('mouseup', onMouseUp);
      hide();
      if (current) {
        current = null;
        synth.cancel();
      }
    },
  };
}
