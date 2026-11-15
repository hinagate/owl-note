// The melody of a spoken take: how high the voice is, moment by moment, and how loud.
// Plain arithmetic on the recording, with no model: the pitch of a voice is the rate at
// which its waveform repeats, and that can be measured directly.
//
// Used by speaking practice to draw the line of the reader's own voice, and to say about
// how far it moved. It describes; it does not judge. Two things it does not say, because
// they were measured and did not hold:
// - which syllable of a word was stressed: told from loudness, pitch and length, it was
//   right about one time in ten against teachers' marks;
// - whether the voice rose or fell at the end: an earlier version said so, and agreed with
//   Praat's pitch of the same recording three times in four on a clean recording and half
//   the time through a poor microphone, whichever of six ways it was decided. The end of
//   a sentence is where a voice trails off and is measured worst. The picture and its
//   pointer show the ending; no sentence claims it.
//
// How it is measured. Every 10 ms the wave is laid over itself, shifted by each length a
// voice's period can have, and the shifts at which it matches itself best are kept as
// candidates. One frame alone cannot tell the true period from twice or half of it, and
// in a real room (echo, a fan, a thin laptop microphone) the match is never clean. So the
// line is not chosen frame by frame: the cheapest path through the candidates of the whole
// take is, where a path pays for every jump in pitch, for every switch between voice and
// no voice, and for straying from the speaker's usual pitch. This is how the phonetics
// programs do it (Praat, RAPT).
//
// The numbers below were set against Praat's own pitch of 251 recordings of real people
// (men, women and children), clean and as a quiet, noisy, echoing or distant microphone
// would have heard them. An earlier version took the first clean repeat in each frame on
// its own. It was right on a clean recording and found a third of the voice or less
// through a laptop microphone in a room, in fragments an octave apart.

const LOW_HZ = 60;      // below any speaking voice
const HIGH_HZ = 500;    // above any, children's included
const STEP_S = 0.01;
const WINDOW_S = 0.03;  // the stretch of wave laid over itself
const WORK_HZ = 8000;   // samples a second it is measured at: enough for pitch, and quick
const RUMBLE_HZ = 70;   // below this is the desk, the mains and the wind, not the voice
const KEEP = 6;         // candidates kept in a frame
const WEAKEST = 0.25;   // a match poorer than this is not a candidate (1 is a perfect match)
const HUSH = 0.04;      // a frame this much quieter than the take's loud parts is not voice
// What a path pays:
const NO_VOICE = 0.55;  // to call a frame voiceless, so a voice must match better than 0.45
const CHANGE = 0.14;    // to switch between voice and no voice
const JUMP = 0.35;      // per octave moved between neighbouring frames
const LONGER = 0.02;    // per octave of period, so that twice the true period does not win a tie
const AWAY = 0.07;      // per octave from the speaker's usual pitch
// A scrap of line that is not the voice (see where it is used):
const STRAY = {
  frames: 10,   // shorter than this many frames (0.1 s),
  step: 4,      // or cut off from its own stretch by a step of more than this many semitones,
  apart: 5,     // and more than this many semitones from
  around: 25,   // the voice within this many frames (0.25 s) either side,
  enough: 5,    // where there are at least this many frames of voice to compare it with
};
// A dip or a leap that is not the melody (see where it is used):
const LEAP = {
  below: 8,     // reaching more than this many semitones under the line around it,
  above: 10,    // or more than this many over it (a stressed word rises six or eight; ten is an octave slip),
  around: 50,   // the line around it being the middle of the voice within 0.5 s either side,
  enough: 10,   // where that is at least this many frames of voice,
  edge: 3,      // counted from where it left that line by this many semitones,
  frames: 50,   // and over in less than this many frames (0.5 s),
  bridge: 10,   // a few voiceless frames inside it not ending it
};

const median = (values) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
export const semitones = (hz, from) => 12 * Math.log2(hz / from);

// Half as many samples a second, smoothed first so that what is dropped does not fold back.
function halved(input) {
  const out = new Float32Array(input.length >> 1);
  for (let i = 0; i < out.length; i += 1) {
    const at = 2 * i;
    out[i] = ((at ? input[at - 1] : 0) + 3 * input[at] + 3 * input[at + 1] + (at + 2 < input.length ? input[at + 2] : 0)) / 8;
  }
  return out;
}

/**
 * @param {Float32Array} samples mono
 * @param {number} [rate] samples a second
 * @returns {{ step: number, pitch: Float32Array, level: Float32Array }} one value every
 *   `step` seconds, for the moment i * step: the pitch in Hz, 0 where there is no voice
 *   (silence, or a sound like s that has no pitch), and the loudness (root mean square)
 */
export function trackVoice(samples, rate = 16000) {
  while (rate >= WORK_HZ * 2) { samples = halved(samples); rate /= 2; }
  const step = Math.round(STEP_S * rate);
  const size = Math.round(WINDOW_S * rate);
  const shortest = Math.floor(rate / HIGH_HZ);
  const longest = Math.ceil(rate / LOW_HZ);
  const frames = Math.floor(samples.length / step);
  const pitch = new Float32Array(frames);
  const level = new Float32Array(frames);
  if (!frames) return { step: step / rate, pitch, level };

  // The wave with the rumble taken out, and room at both ends so that every frame is
  // centred on its moment.
  const lead = (size + ((shortest + longest) >> 1)) >> 1;
  const wave = new Float32Array(lead + samples.length + size + longest + 2);
  {
    const keep = 1 / (1 + (2 * Math.PI * RUMBLE_HZ) / rate);
    let once = 0; let twice = 0; let before = 0; let beforeOnce = 0;
    for (let i = 0; i < samples.length; i += 1) {
      once = keep * (once + samples[i] - before); before = samples[i];
      twice = keep * (twice + once - beforeOnce); beforeOnce = once;
      wave[lead + i] = twice;
    }
  }
  const energy = new Float64Array(wave.length + 1); // energy[i]: the sum of squares before i
  for (let i = 0; i < wave.length; i += 1) energy[i + 1] = energy[i] + wave[i] * wave[i];

  const half = size >> 1;
  for (let frame = 0; frame < frames; frame += 1) {
    const mid = lead + frame * step;
    level[frame] = Math.sqrt((energy[Math.min(wave.length, mid + half)] - energy[Math.max(0, mid - half)]) / size);
  }
  // Against the take's own loud parts, so a quiet microphone is measured like a loud one.
  const hush = [...level].sort((a, b) => a - b)[Math.floor(frames * 0.9)] * HUSH;

  // The candidates of every frame: a period, in samples, and how well the wave matches
  // itself when shifted by it.
  const periods = new Float32Array(frames * KEEP);
  const matches = new Float32Array(frames * KEEP);
  const counts = new Uint8Array(frames);
  const match = new Float32Array(longest + 2);
  for (let frame = 0; frame < frames; frame += 1) {
    if (!(level[frame] > hush)) continue;
    const at = frame * step;
    const own = energy[at + size] - energy[at];
    if (!own) continue;
    for (let lag = shortest - 1; lag <= longest + 1; lag += 1) {
      const shifted = at + lag;
      let sum = 0;
      for (let i = 0; i < size; i += 1) sum += wave[at + i] * wave[shifted + i];
      const other = energy[shifted + size] - energy[shifted];
      match[lag] = other ? sum / Math.sqrt(own * other) : 0;
    }
    const base = frame * KEEP;
    let count = 0;
    for (let lag = shortest; lag <= longest; lag += 1) {
      const here = match[lag];
      if (here < WEAKEST || here <= match[lag - 1] || here < match[lag + 1]) continue;
      // Between samples: a curve through the peak and its two neighbours.
      const curve = match[lag - 1] - 2 * here + match[lag + 1];
      const shift = curve < 0 ? (0.5 * (match[lag - 1] - match[lag + 1])) / curve : 0;
      const top = Math.min(1, here - 0.25 * (match[lag - 1] - match[lag + 1]) * shift);
      let slot = count;
      if (count < KEEP) count += 1;
      else {
        // Full: the new one takes the place of the poorest, if it is better.
        slot = 0;
        for (let k = 1; k < KEEP; k += 1) if (matches[base + k] < matches[base + slot]) slot = k;
        if (matches[base + slot] >= top) continue;
      }
      periods[base + slot] = lag + shift;
      matches[base + slot] = top;
    }
    counts[frame] = count;
  }

  // The cheapest path. State 0 is "no voice"; state k + 1 is the frame's candidate k.
  const states = KEEP + 1;
  const cost = new Float32Array(frames * states);
  const back = new Uint8Array(frames * states);
  const cheapestPath = (usual) => {
    const own = (frame, state) => {
      if (!state) return NO_VOICE;
      const period = periods[frame * KEEP + state - 1];
      return 1 - matches[frame * KEEP + state - 1] + LONGER * Math.log2(period / shortest)
        + (usual ? AWAY * Math.abs(Math.log2(rate / period / usual)) : 0);
    };
    for (let state = 0; state <= counts[0]; state += 1) cost[state] = own(0, state);
    for (let frame = 1; frame < frames; frame += 1) {
      const row = frame * states;
      for (let state = 0; state <= counts[frame]; state += 1) {
        const period = state ? periods[frame * KEEP + state - 1] : 0;
        let best = Infinity;
        let from = 0;
        for (let was = 0; was <= counts[frame - 1]; was += 1) {
          let move = 0;
          if (!state !== !was) move = CHANGE;
          else if (state) move = JUMP * Math.abs(Math.log2(period / periods[(frame - 1) * KEEP + was - 1]));
          const total = cost[row - states + was] + move;
          if (total < best) { best = total; from = was; }
        }
        cost[row + state] = best + own(frame, state);
        back[row + state] = from;
      }
    }
    const last = (frames - 1) * states;
    let state = 0;
    for (let s = 1; s <= counts[frames - 1]; s += 1) if (cost[last + s] < cost[last + state]) state = s;
    for (let frame = frames - 1; frame >= 0; frame -= 1) {
      pitch[frame] = state ? rate / periods[frame * KEEP + state - 1] : 0;
      state = back[frame * states + state];
    }
  };
  cheapestPath(0);
  // And again, now that it is known where this voice usually sits: a stretch that went an
  // octave off pays for it.
  const found = [...pitch].filter((hz) => hz > 0);
  if (found.length >= 20) cheapestPath(median(found));

  // A scrap of line far from the line around it. The path is only held together from one
  // voiced frame to the next, so across a voiceless frame it can come back an octave off
  // for a few frames, where a noisy wave happens to match itself better at half or twice
  // its period. On the picture that is a spike. A voice does not leap five semitones for
  // under a tenth of a second and leap back, so such a scrap is not drawn.
  {
    const scraps = [];
    for (let frame = 0; frame < frames;) {
      if (!pitch[frame]) { frame += 1; continue; }
      let end = frame + 1;
      while (end < frames && pitch[end] && Math.abs(semitones(pitch[end], pitch[end - 1])) <= STRAY.step) end += 1;
      if (end - frame < STRAY.frames) scraps.push([frame, end]);
      frame = end;
    }
    // A scrap with no voice near it (a click before the first word, a breath after the
    // last) is held against the voice of the whole take instead.
    const all = [...pitch].filter((hz) => hz > 0);
    const usual = all.length >= 20 ? median(all) : 0;
    const stray = scraps.filter(([from, to]) => {
      const around = [];
      for (let frame = Math.max(0, from - STRAY.around); frame < Math.min(frames, to + STRAY.around); frame += 1) {
        if ((frame < from || frame >= to) && pitch[frame]) around.push(pitch[frame]);
      }
      const line = around.length >= STRAY.enough ? median(around) : usual;
      return line > 0 && Math.abs(semitones(median([...pitch.subarray(from, to)]), line)) > STRAY.apart;
    });
    for (const [from, to] of stray) pitch.fill(0, from, to);
  }

  // A dip to the floor and back. Where a voice turns creaky (at the end of a phrase, on
  // "um", between two words begun with a catch in the throat) every other pulse weakens,
  // and the wave really does repeat at half the rate for a moment: a plunge of about an
  // octave, lasting a tenth of a second or two, then back. That is the voice's quality
  // there, not its melody, and on the picture it is a row of spikes that hides the melody.
  // The opposite slip, an octave up, is the method's own on a thin, noisy recording. Either
  // way the stretch has no pitch worth drawing, so it is left out, the whole of it from
  // where it left the line, and the picture joins across it as it does across an s.
  // What stays: any rise or fall that does not go that far (a stressed word, a question),
  // and any that lasts.
  {
    const away = new Float32Array(frames); // semitones from the line around each frame
    const far = new Uint8Array(frames);
    const near = [];
    for (let frame = 0; frame < frames; frame += 1) {
      if (!pitch[frame]) continue;
      near.length = 0;
      for (let other = Math.max(0, frame - LEAP.around); other < Math.min(frames, frame + LEAP.around + 1); other += 1) {
        if (pitch[other]) near.push(pitch[other]);
      }
      if (near.length < LEAP.enough) continue;
      away[frame] = semitones(pitch[frame], median(near));
      if (away[frame] < -LEAP.below || away[frame] > LEAP.above) far[frame] = 1;
    }
    const leaps = [];
    for (let frame = 0; frame < frames;) {
      if (!far[frame]) { frame += 1; continue; }
      let end = frame + 1;
      let last = frame;
      while (end < frames && (far[end] || (!pitch[end] && end - last <= LEAP.bridge))) { if (far[end]) last = end; end += 1; }
      const side = Math.sign(away[frame]);
      let from = frame;
      let to = last + 1;
      while (from > 0 && pitch[from - 1] && away[from - 1] * side > LEAP.edge) from -= 1;
      while (to < frames && pitch[to] && away[to] * side > LEAP.edge) to += 1;
      if (to - from < LEAP.frames) leaps.push([from, to]);
      frame = end;
    }
    for (const [from, to] of leaps) pitch.fill(0, from, to);
  }

  // Voiced stretches shorter than 30 ms are clicks and breaths.
  for (let frame = 0; frame < frames;) {
    if (!pitch[frame]) { frame += 1; continue; }
    let end = frame;
    while (end < frames && pitch[end]) end += 1;
    if (end - frame < 3) for (let i = frame; i < end; i += 1) pitch[i] = 0;
    frame = end;
  }
  return { step: step / rate, pitch, level };
}

/**
 * What can be said about the line as a whole.
 * @returns {{ centre: number, range: number,
 *   spans: { from: number, to: number, points: number[] }[] } | null} centre is the
 *   voice's middle pitch in Hz; range is about how far it moved, in semitones; spans are
 *   the voiced stretches, each point in semitones from the centre. null when there was no
 *   voice to measure.
 */
export function melodyOf({ step, pitch }) {
  const voiced = [...pitch].filter((hz) => hz > 0);
  if (voiced.length < 8) return null;
  const centre = median(voiced);
  const relative = voiced.map((hz) => semitones(hz, centre)).sort((a, b) => a - b);
  // The middle four fifths of the voice. The extremes are where it is measured worst, and
  // a figure that includes them swings with them: taken this way it comes within two
  // semitones of Praat's nine times in ten on a clean recording, and three in four through
  // a poor microphone. So it is shown as "about".
  const low = relative[Math.floor(relative.length * 0.1)];
  const high = relative[Math.min(relative.length - 1, Math.floor(relative.length * 0.9))];

  const spans = [];
  for (let frame = 0; frame < pitch.length;) {
    if (!pitch[frame]) { frame += 1; continue; }
    const points = [];
    const from = frame;
    while (frame < pitch.length && pitch[frame]) { points.push(semitones(pitch[frame], centre)); frame += 1; }
    spans.push({ from: from * step, to: frame * step, points });
  }

  return { centre, range: high - low, spans };
}
