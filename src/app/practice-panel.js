// What speaking practice shows under the speaker bar once a take has been recorded: the
// words that were meant with what happened to each, the reader's own recording to hear
// back, and the line of their voice's pitch, with a pointer that moves along it as the
// recording plays.
//
// It only draws. The take itself is lib/voice-take.js; the words are compared in
// lib/speech-check.js and the pitch is measured in lib/voice-melody.js.

const SVG = 'http://www.w3.org/2000/svg';

function icon(path, className) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  if (className) svg.classList.add(className);
  const shape = document.createElementNS(SVG, 'path');
  shape.setAttribute('d', path);
  shape.setAttribute('fill', 'currentColor');
  svg.append(shape);
  return svg;
}
const PLAY = 'M8 5.5v13l10.5-6.5L8 5.5z';
const STOP = 'M7 7h10v10H7z';

const WORD_TITLES = {
  heard: () => 'Heard',
  different: (word) => (word.as ? `Heard as “${word.as}”` : 'Heard differently'),
  missed: () => 'Not heard',
};

// The line of the reader's voice: time left to right, pitch bottom to top, a little over
// an octave tall. Only what the take measured is drawn; nothing here says what it should be.
const MELODY = {
  width: 400,
  height: 80,
  reach: 9,       // semitones above and below the voice's middle
  fits: 16,       // seconds of take that are drawn across the panel, however wide it is
  perSecond: 32,  // pixels a second a longer take is given: it scrolls sideways
  joined: 0.35,   // seconds: a gap in the voice shorter than this is a sound, not a pause
};
// What the picture means, in words, since a line alone does not say.
const MELODY_KEY = 'The line is the pitch of your voice: up is higher. '
  + 'Dots join it where there is no clear pitch, as in s and t. A gap is a pause.';
// What is shown of the words while they are being heard: the end of them, on one or two lines.
const INTERIM_CHARS = 160;
// The stretch of the take that has a voice in it, with a little air either side. A take
// begins and ends in silence, and drawn whole the line would be squeezed into the middle.
function spokenPart(melody, seconds) {
  const first = melody.spans[0];
  const last = melody.spans[melody.spans.length - 1];
  const from = Math.max(0, first.from - 0.15);
  const to = Math.max(from + 0.2, Math.min(seconds, last.to + 0.15));
  return { from, to };
}

function melodyGraph(melody, part) {
  const { width, height, reach } = MELODY;
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'The pitch of your voice over the take. Click to hear it from that point.');
  svg.classList.add('practice-melody-graph');
  const middle = document.createElementNS(SVG, 'line');
  middle.setAttribute('x1', '0');
  middle.setAttribute('x2', String(width));
  middle.setAttribute('y1', String(height / 2));
  middle.setAttribute('y2', String(height / 2));
  middle.classList.add('practice-melody-middle');
  svg.append(middle);
  // A long take is not squeezed into the width of the panel: it is given its room and
  // scrolls sideways, following the pointer as it plays. A sentence or two is not: a
  // scroll bar for the last few pixels of a take that all but fits is only in the way.
  if (part.to - part.from > MELODY.fits) svg.style.minWidth = `${Math.round((part.to - part.from) * MELODY.perSecond)}px`;
  const x = (t) => ((t - part.from) / (part.to - part.from)) * width;
  const y = (st) => height / 2 - (Math.max(-reach, Math.min(reach, st)) / reach) * (height / 2 - 4);
  const at = (t, st) => `${x(t).toFixed(1)},${y(st).toFixed(1)}`;
  let before = null; // where the last stretch of voice ended
  for (const span of melody.spans) {
    const step = (span.to - span.from) / span.points.length;
    // A voice has no pitch during s, t, k, f or h, so the line stops there although the
    // speaker did not. Those short gaps are joined with dots, so that the line breaks only
    // where the speaker did: at a pause.
    if (before && span.from - before.to <= MELODY.joined) {
      const join = document.createElementNS(SVG, 'polyline');
      join.setAttribute('points', `${at(before.t, before.st)} ${at(span.from, span.points[0])}`);
      join.classList.add('practice-melody-join');
      svg.append(join);
    }
    const line = document.createElementNS(SVG, 'polyline');
    line.setAttribute('points', span.points.map((st, i) => at(span.from + i * step, st)).join(' '));
    line.classList.add('practice-melody-line');
    svg.append(line);
    before = { to: span.to, t: span.from + (span.points.length - 1) * step, st: span.points[span.points.length - 1] };
  }
  // Where the recording is while it plays. Hidden until it does.
  const head = document.createElementNS(SVG, 'line');
  head.setAttribute('y1', '0');
  head.setAttribute('y2', String(height));
  head.setAttribute('visibility', 'hidden');
  head.classList.add('practice-melody-head');
  svg.append(head);
  return { svg, head };
}

// A take in which the voice could be measured only here and there (a loud room, a distant
// microphone) gives scattered pieces of line that mean little. Better to say so than to
// leave the reader wondering what they did.
const ROUGH = { least: 0.2, over: 1.5 }; // under a fifth of the take measured, in a take over 1.5 s
const ROUGH_WORDS = 'Only a little of your voice could be measured, so this line is rough. '
  + 'Try a quieter room, speak closer to the microphone, or choose another microphone in Settings.';
function isRough(melody) {
  const first = melody.spans[0];
  const last = melody.spans[melody.spans.length - 1];
  const whole = last.to - first.from;
  const measured = melody.spans.reduce((sum, span) => sum + (span.to - span.from), 0);
  return whole > ROUGH.over && measured / whole < ROUGH.least;
}

// About how far the voice moved, and no more than that: the figure is good to a semitone
// or two (lib/voice-melody.js), and which way the voice went at the end is not said at
// all, because it could not be told reliably. The picture shows it.
function melodyWords(melody) {
  const moved = Math.round(melody.range);
  return moved < 3
    ? 'Your voice stayed almost level.'
    : `Your voice moved over about ${moved} semitones.`;
}

function summary(comparison) {
  if (!comparison.total) return '';
  if (comparison.heard === comparison.total) return comparison.total === 1 ? 'The word was heard.' : 'Every word was heard.';
  if (comparison.total === 1) return 'The word was not heard as written.';
  return `${comparison.heard} of ${comparison.total} words were heard.`;
}

/**
 * @param {{ onAgain?: () => void, Player?: typeof Audio }} [options]
 */
export function createPracticePanel({
  onAgain = () => {},
  Player = globalThis.Audio,
  // Once per repaint, so the pointer moves as smoothly as the screen can show it.
  nextFrame = (step) => (globalThis.requestAnimationFrame ? globalThis.requestAnimationFrame(step) : setTimeout(step, 16)),
} = {}) {
  const el = document.createElement('div');
  el.className = 'pronounce-practice';
  el.hidden = true;
  let clipUrl = null;
  let player = null;
  let graph = null; // { part, head, scroller }: the stretch of the take the picture shows, its pointer, and what it scrolls in

  const stopPlayer = () => {
    if (!player) return;
    player.pause();
    player.onended = null;
    player = null;
    el.querySelector('.practice-play')?.classList.remove('playing');
    graph?.head.setAttribute('visibility', 'hidden');
  };

  // The pointer is what ties the line to the sound: without it there is no telling which
  // rise or fall belongs to which word. It is placed from the player's own clock on every
  // repaint, so it cannot drift from what is heard.
  const follow = () => {
    if (!player) return;
    if (graph) {
      const { part, head, scroller } = graph;
      const now = player.currentTime;
      if (now >= part.to) { stopPlayer(); return; } // the quiet after the last word is not played
      const along = Math.max(0, Math.min(1, (now - part.from) / (part.to - part.from)));
      const x = (along * MELODY.width).toFixed(1);
      head.setAttribute('x1', x);
      head.setAttribute('x2', x);
      head.setAttribute('visibility', 'visible');
      // A take too long for the panel: keep the pointer in the middle of what is shown.
      if (scroller.scrollWidth > scroller.clientWidth) {
        scroller.scrollLeft = Math.max(0, along * scroller.scrollWidth - scroller.clientWidth / 2);
      }
    }
    nextFrame(follow);
  };

  const playFrom = (seconds) => {
    stopPlayer();
    if (!clipUrl) return;
    const mine = new Player(clipUrl);
    player = mine;
    mine.onended = stopPlayer;
    if (seconds > 0) {
      try { mine.currentTime = seconds; } catch { /* it plays from the start instead */ }
    }
    el.querySelector('.practice-play')?.classList.add('playing');
    Promise.resolve(mine.play())
      .then(() => { if (player === mine) follow(); })
      .catch(() => { if (player === mine) stopPlayer(); });
  };

  const clear = () => {
    stopPlayer();
    graph = null;
    if (clipUrl) URL.revokeObjectURL(clipUrl);
    clipUrl = null;
    el.replaceChildren();
    el.hidden = true;
  };

  const line = (className, text) => {
    const div = document.createElement('div');
    div.className = className;
    div.textContent = text;
    return div;
  };

  return {
    el,
    clear,

    /** While the microphone is open: what has been heard so far. */
    listening(interim = '') {
      stopPlayer();
      el.hidden = false;
      const said = interim.length > INTERIM_CHARS ? `…${interim.slice(-INTERIM_CHARS)}` : interim;
      const status = line('practice-status', said || 'Listening… say it now.');
      status.setAttribute('role', 'status');
      el.replaceChildren(status);
    },

    /** Between the take and its result. */
    working(message) {
      el.hidden = false;
      const status = line('practice-status', message);
      status.setAttribute('role', 'status');
      el.replaceChildren(status);
    },

    /**
     * @param {{ comparison: ReturnType<import('../lib/speech-check.js').compareWords>|null,
     *   unclear?: boolean, heard: string, blob: Blob }} take `comparison` is null where
     *   the words could not be checked: on a device with no recogniser, or (`unclear`)
     *   when the recogniser made nothing of the take. The recording can still be heard back
     */
    show({ comparison, unclear = false, heard, blob }) {
      clear();
      el.hidden = false;
      const parts = [];

      if (comparison) {
        parts.push(line('practice-summary', summary(comparison)));
        const words = document.createElement('div');
        words.className = 'practice-words';
        comparison.words.forEach((word, i) => {
          const item = document.createElement('span');
          item.className = `practice-word ${word.status}`;
          item.dataset.word = String(i);
          item.title = WORD_TITLES[word.status](word);
          const text = document.createElement('span');
          text.className = 'practice-word-text';
          text.textContent = word.text;
          item.append(text);
          words.append(item);
        });
        parts.push(words);
        const everyWord = comparison.heard === comparison.total && !comparison.extra.length;
        if (!everyWord && heard) parts.push(line('practice-heard', `Heard: “${heard}”`));
      } else {
        parts.push(line('practice-summary', unclear
          ? 'Recorded, but the words could not be made out. Try again, a little closer to the microphone.'
          : 'Recorded. This browser cannot check the words on this device.'));
      }

      const actions = document.createElement('div');
      actions.className = 'practice-actions';
      clipUrl = URL.createObjectURL(blob);
      const play = document.createElement('button');
      play.type = 'button';
      play.className = 'practice-play';
      play.append(icon(PLAY, 'practice-icon-play'), icon(STOP, 'practice-icon-stop'), 'Hear yourself');
      play.addEventListener('click', () => {
        if (player) { stopPlayer(); return; }
        // From where the voice begins, not from the silence a take starts with.
        playFrom(graph ? graph.part.from : 0);
      });
      const again = document.createElement('button');
      again.type = 'button';
      again.className = 'practice-again';
      again.textContent = 'Again';
      again.addEventListener('click', () => onAgain());
      actions.append(play, again);
      parts.push(actions);

      el.append(...parts);
    },

    /**
     * The melody of the take, added under the words once it has been measured. While the
     * recording plays, a pointer moves along it.
     * @param {ReturnType<import('../lib/voice-melody.js').melodyOf>} melody null when the
     *   take had no voice to measure
     * @param {number} seconds the length of the take
     */
    showMelody(melody, seconds) {
      el.querySelector('.practice-melody')?.remove();
      graph = null;
      if (!melody || el.hidden) return;
      const box = document.createElement('div');
      box.className = 'practice-melody';
      const part = spokenPart(melody, seconds);
      const { svg, head } = melodyGraph(melody, part);
      const scroller = document.createElement('div');
      scroller.className = 'practice-melody-scroll';
      scroller.append(svg);
      // Which way is up, said on the picture itself. They stay put while the line scrolls.
      const frame = document.createElement('div');
      frame.className = 'practice-melody-frame';
      frame.append(scroller, line('practice-melody-high', 'higher'), line('practice-melody-low', 'lower'));
      graph = { part, head, scroller };
      // A click on the line plays the recording from that moment.
      svg.addEventListener('click', (event) => {
        const area = svg.getBoundingClientRect();
        const along = area.width ? Math.max(0, Math.min(1, (event.clientX - area.left) / area.width)) : 0;
        playFrom(part.from + along * (part.to - part.from));
      });
      box.append(frame, line('practice-melody-key', MELODY_KEY));
      if (isRough(melody)) box.append(line('practice-melody-rough', ROUGH_WORDS));
      else box.append(line('practice-melody-words', melodyWords(melody)));
      el.insertBefore(box, el.querySelector('.practice-actions'));
    },
  };
}
