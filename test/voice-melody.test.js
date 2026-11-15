import { describe, it, expect } from 'vitest';
import { melodyOf, semitones, trackVoice } from '../src/lib/voice-melody.js';

const RATE = 16000;
// A voice-like wave: the note with three overtones, at the pitch `hzAt` gives over time.
function voice(seconds, hzAt, loudness = 0.3) {
  const out = new Float32Array(Math.round(seconds * RATE));
  let phase = 0;
  for (let i = 0; i < out.length; i += 1) {
    phase += (2 * Math.PI * hzAt(i / RATE)) / RATE;
    out[i] = loudness * (Math.sin(phase) + 0.6 * Math.sin(2 * phase) + 0.4 * Math.sin(3 * phase) + 0.2 * Math.sin(4 * phase));
  }
  return out;
}
const join = (...parts) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
};
const quiet = (seconds) => new Float32Array(Math.round(seconds * RATE));
const middle = (values) => { const s = [...values].filter((v) => v > 0).sort((a, b) => a - b); return s[s.length >> 1]; };

describe('trackVoice', () => {
  it('measures the pitch of a low, a middle and a high voice', () => {
    for (const hz of [80, 110, 220, 330, 440]) {
      expect(middle(trackVoice(voice(0.6, () => hz), RATE).pitch)).toBeCloseTo(hz, 0);
    }
  });

  it('finds no pitch in a hiss or in silence', () => {
    const hiss = new Float32Array(RATE);
    let seed = 7;
    for (let i = 0; i < hiss.length; i += 1) { seed = (seed * 16807) % 2147483647; hiss[i] = ((seed / 2147483647) * 2 - 1) * 0.2; }
    expect([...trackVoice(hiss, RATE).pitch].filter((hz) => hz > 0)).toHaveLength(0);
    expect([...trackVoice(quiet(0.5), RATE).pitch].filter((hz) => hz > 0)).toHaveLength(0);
  });

  it('follows where the voice is and where it is not', () => {
    const track = trackVoice(join(quiet(0.3), voice(0.4, () => 150), quiet(0.3)), RATE);
    const at = (seconds) => track.pitch[Math.round(seconds / track.step)];
    expect(at(0.1)).toBe(0);
    expect(at(0.5)).toBeCloseTo(150, 0);
    expect(at(0.9)).toBe(0);
  });

  it('gives one value every hundredth of a second, with the loudness beside it', () => {
    const track = trackVoice(join(voice(0.3, () => 150, 0.1), voice(0.3, () => 150, 0.4)), RATE);
    expect(track.step).toBeCloseTo(0.01, 5);
    expect(track.level[40]).toBeGreaterThan(track.level[10] * 3);
  });

  it('copes with a recording too short to measure', () => {
    expect(trackVoice(new Float32Array(100), RATE).pitch).toHaveLength(0);
  });
});

// What a real room does to a voice. A tracker that wants a clean wave draws a real take as
// scattered fragments, an octave apart: that is what the first version did.
describe('trackVoice through a poor microphone', () => {
  // The same noise on every run.
  const noise = (seconds, loudness, seed = 11) => {
    const out = new Float32Array(Math.round(seconds * RATE));
    let state = seed;
    for (let i = 0; i < out.length; i += 1) { state = (state * 16807) % 2147483647; out[i] = ((state / 2147483647) * 2 - 1) * loudness; }
    return out;
  };
  const add = (a, b) => a.map((value, i) => value + (b[i] || 0));
  const voicedBetween = (track, from, to) => {
    const frames = [...track.pitch].slice(Math.round(from / track.step), Math.round(to / track.step));
    return frames.filter((hz) => hz > 0).length / frames.length;
  };

  it('finds the voice under noise almost as loud as it is', () => {
    const take = add(join(quiet(0.3), voice(1, (t) => 140 + 30 * t), quiet(0.3)), noise(1.6, 0.35));
    const track = trackVoice(take, RATE);
    expect(voicedBetween(track, 0.35, 1.25)).toBeGreaterThan(0.9);
    expect(middle(track.pitch)).toBeGreaterThan(145);
    expect(middle(track.pitch)).toBeLessThan(165);
    // ... and draws none of the noise on its own as voice.
    expect(voicedBetween(track, 0, 0.2)).toBe(0);
    expect(voicedBetween(track, 1.4, 1.6)).toBe(0);
  });

  it('measures a quiet microphone like a loud one', () => {
    const take = join(quiet(0.3), voice(0.6, () => 150), quiet(0.3));
    const loud = trackVoice(take, RATE);
    const faint = trackVoice(take.map((value) => value * 0.004), RATE);
    expect([...faint.pitch].filter((hz) => hz > 0)).toHaveLength([...loud.pitch].filter((hz) => hz > 0).length);
    expect(middle(faint.pitch)).toBeCloseTo(150, 0);
  });

  // A laptop microphone passes little below 200 Hz, so a low voice arrives without its
  // own fundamental: only the overtones. It still repeats at the voice's pitch.
  it('hears a voice that has lost its bass', () => {
    const thin = new Float32Array(RATE);
    for (let i = 0; i < thin.length; i += 1) {
      const phase = (2 * Math.PI * 120 * i) / RATE;
      thin[i] = 0.3 * (Math.sin(2 * phase) + 0.6 * Math.sin(3 * phase) + 0.4 * Math.sin(4 * phase));
    }
    expect(middle(trackVoice(thin, RATE).pitch)).toBeCloseTo(120, 0);
  });

  it('holds the line through a moment where the wave is unclear', () => {
    const take = voice(1, () => 150);
    take.set(add(take.slice(8000, 8640), noise(0.04, 0.9, 5)), 8000); // 40 ms of crackle, mid-word
    for (const hz of trackVoice(take, RATE).pitch) {
      if (hz) expect(Math.abs(semitones(hz, 150))).toBeLessThan(1);
    }
  });

  it('is not drawn into the hum of the mains', () => {
    const hum = new Float32Array(RATE * 2);
    for (let i = 0; i < hum.length; i += 1) {
      const t = i / RATE;
      hum[i] = 0.02 * (Math.sin(2 * Math.PI * 50 * t) + 0.6 * Math.sin(2 * Math.PI * 100 * t) + 0.4 * Math.sin(2 * Math.PI * 150 * t));
    }
    const take = add(join(quiet(0.5), voice(1, () => 210), quiet(0.5)), hum);
    const track = trackVoice(take, RATE);
    expect(voicedBetween(track, 0, 0.4)).toBe(0);
    expect(middle(track.pitch)).toBeCloseTo(210, 0);
  });

  // What a noisy wave does for a few frames: matches itself better at half its period. On
  // the picture that was a spike.
  it('does not draw a scrap of line far from the line around it', () => {
    const take = join(voice(0.5, () => 150), quiet(0.02), voice(0.05, () => 300), quiet(0.02), voice(0.5, () => 150));
    for (const hz of trackVoice(take, RATE).pitch) {
      if (hz) expect(Math.abs(semitones(hz, 150))).toBeLessThan(2);
    }
  });

  // Up a fifth for a third of a second, as on a stressed word.
  // Seen at the end of a real take: a breath after the last word, drawn at the top of the
  // picture with nothing near it.
  it('does not draw a scrap that stands alone, far from the voice of the take', () => {
    const take = join(voice(0.8, () => 150), quiet(0.6), voice(0.06, () => 290), quiet(0.2));
    for (const hz of trackVoice(take, RATE).pitch) {
      if (hz) expect(Math.abs(semitones(hz, 150))).toBeLessThan(2);
    }
  });

  it('keeps a short word that stands alone at the voice\'s own pitch', () => {
    const take = join(voice(0.8, () => 150), quiet(0.6), voice(0.07, () => 160), quiet(0.2));
    const track = trackVoice(take, RATE);
    const late = [...track.pitch].slice(Math.round(1.4 / track.step)).filter((hz) => hz > 0);
    expect(late.length).toBeGreaterThan(3);
  });

  it('keeps a step in pitch that lasts: that is the voice', () => {
    const track = trackVoice(join(voice(0.4, () => 150), quiet(0.03), voice(0.3, () => 225), quiet(0.03), voice(0.4, () => 150)), RATE);
    const high = [...track.pitch].filter((hz) => hz > 215 && hz < 235);
    expect(high.length).toBeGreaterThan(20);
  });

  // A voice that turns creaky for a moment (on "um", at the end of a phrase, between two
  // words) really does repeat at half the rate there. Drawn, that was a row of spikes to
  // the floor of the picture: reported from a real take with six of them in one sentence.
  describe('a plunge of an octave and back', () => {
    // A creaky moment: every other pulse of the voice at a quarter of its strength, so
    // that the wave repeats at half the rate.
    const creak = (seconds, hz) => {
      const out = new Float32Array(Math.round(seconds * RATE));
      for (let i = 0; i < out.length; i += 1) {
        const phase = (2 * Math.PI * hz * i) / RATE;
        const weak = Math.floor(phase / (2 * Math.PI)) % 2 ? 0.25 : 1;
        out[i] = 0.3 * weak * (Math.sin(phase) + 0.6 * Math.sin(2 * phase) + 0.4 * Math.sin(3 * phase) + 0.2 * Math.sin(4 * phase));
      }
      return out;
    };
    // The voice sliding down an octave, staying a moment, and sliding back: 0.4 s in all.
    const slide = (hz) => join(voice(0.15, (t) => hz * 2 ** (-t / 0.15)), voice(0.1, () => hz / 2), voice(0.15, (t) => (hz / 2) * 2 ** (t / 0.15)));
    const steady = () => voice(0.6, () => 130);
    const lowest = (track) => Math.min(...[...track.pitch].filter((v) => v > 0));
    const voiced = (track) => [...track.pitch].filter((v) => v > 0).length;

    it('is not drawn where the voice turned creaky for a moment', () => {
      for (const seconds of [0.15, 0.3]) {
        const track = trackVoice(join(steady(), creak(seconds, 130), steady()), RATE);
        expect(Math.abs(semitones(lowest(track), 130))).toBeLessThan(1);
        expect(voiced(track)).toBeGreaterThan(115); // the voice either side is all still there
      }
    });

    it('is not drawn where the voice slid down and back, shoulders and all', () => {
      const track = trackVoice(join(steady(), slide(130), steady()), RATE);
      expect(semitones(lowest(track), 130)).toBeGreaterThan(-4);
      expect(voiced(track)).toBeGreaterThan(115);
    });

    it('leaves a gap short enough for the picture to join across', () => {
      const track = trackVoice(join(steady(), creak(0.2, 130), steady()), RATE);
      let longest = 0;
      let run = 0;
      for (let frame = 10; frame < track.pitch.length - 10; frame += 1) {
        run = track.pitch[frame] ? 0 : run + 1;
        longest = Math.max(longest, run);
      }
      expect(longest).toBeGreaterThan(10);
      expect(longest).toBeLessThan(35); // under the 0.35 s the picture takes for a pause
    });

    it('is drawn when the voice stays down there: that is the melody', () => {
      const low = trackVoice(join(steady(), voice(0.8, () => 65), steady()), RATE);
      expect([...low.pitch].filter((hz) => hz > 60 && hz < 70).length).toBeGreaterThan(60);
      const longCreak = trackVoice(join(steady(), creak(0.7, 130), steady()), RATE);
      expect([...longCreak.pitch].filter((hz) => hz > 60 && hz < 70).length).toBeGreaterThan(50);
    });

    it('leaves a fall of a few semitones alone, however brief', () => {
      const dip = voice(0.3, (t) => 130 * 2 ** ((-5 / 12) * Math.sin((Math.PI * t) / 0.3) ** 2));
      const track = trackVoice(join(steady(), dip, steady()), RATE);
      expect(semitones(lowest(track), 130)).toBeLessThan(-4);
      expect(voiced(track)).toBeGreaterThan(140);
    });

    it('leaves a rise on a stressed word alone', () => {
      const rise = voice(0.3, (t) => 130 * 2 ** ((8 / 12) * Math.sin((Math.PI * t) / 0.3) ** 2));
      const track = trackVoice(join(steady(), rise, steady()), RATE);
      expect(semitones(Math.max(...track.pitch), 130)).toBeGreaterThan(7);
      expect(voiced(track)).toBeGreaterThan(140);
    });
  });

  // The pointer on the picture is placed by these times, against the recording's clock.
  it('puts each value at its own moment', () => {
    const track = trackVoice(join(quiet(0.5), voice(0.2, () => 180), quiet(0.5)), RATE);
    const voiced = [...track.pitch].map((hz, i) => (hz ? i * track.step : -1)).filter((t) => t >= 0);
    expect(Math.abs(voiced[0] - 0.5)).toBeLessThan(0.025);
    expect(Math.abs(voiced[voiced.length - 1] - 0.7)).toBeLessThan(0.025);
  });

  it('measures a recording at any sample rate', () => {
    const fine = new Float32Array(48000);
    for (let i = 0; i < fine.length; i += 1) {
      const phase = (2 * Math.PI * 220 * i) / 48000;
      fine[i] = 0.3 * (Math.sin(phase) + 0.5 * Math.sin(2 * phase));
    }
    const track = trackVoice(fine, 48000);
    expect(track.step).toBeCloseTo(0.01, 5);
    expect(middle(track.pitch)).toBeCloseTo(220, 0);
  });
});

describe('melodyOf', () => {
  // Which way the voice went at the end was once said too. Against Praat it was right three
  // times in four at best, so it is no longer claimed.
  it('makes no claim about how the voice ended', () => {
    expect('ending' in melodyOf(trackVoice(voice(1.2, (t) => 120 + 100 * (t / 1.2)), RATE))).toBe(false);
  });

  it('measures about how far the voice moved, in semitones', () => {
    expect(melodyOf(trackVoice(voice(1, () => 150), RATE)).range).toBeCloseTo(0, 0);
    // A steady glide through an octave (twelve semitones): its middle four fifths.
    const octave = melodyOf(trackVoice(voice(1.5, (t) => 110 * 2 ** (t / 1.5)), RATE)).range;
    expect(octave).toBeGreaterThan(8.5);
    expect(octave).toBeLessThan(10.5);
  });

  // One stray extreme must not set the figure.
  it('is not swung by a moment at the edge of the voice', () => {
    const steady = melodyOf(trackVoice(voice(2, (t) => 150 + 20 * Math.sin(t * 5)), RATE)).range;
    const withPeak = melodyOf(trackVoice(join(voice(2, (t) => 150 + 20 * Math.sin(t * 5)), voice(0.12, () => 235)), RATE)).range;
    expect(Math.abs(withPeak - steady)).toBeLessThan(1);
  });

  it('gives the voiced stretches apart, each around the voice\'s own middle', () => {
    const melody = melodyOf(trackVoice(join(voice(0.4, () => 200), quiet(0.3), voice(0.4, () => 100)), RATE));
    expect(melody.spans).toHaveLength(2);
    expect(melody.spans[0].from).toBeLessThan(0.05);
    expect(melody.spans[1].from).toBeGreaterThan(0.6);
    // An octave apart, so the two stretches sit about twelve semitones from each other.
    expect(melody.spans[0].points[10] - melody.spans[1].points[10]).toBeCloseTo(12, 0);
  });

  it('is null when there is no voice to measure', () => {
    expect(melodyOf(trackVoice(quiet(1), RATE))).toBeNull();
  });
});
