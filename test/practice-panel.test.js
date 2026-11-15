import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createPracticePanel } from '../src/app/practice-panel.js';
import { compareWords } from '../src/lib/speech-check.js';

class FakePlayer {
  constructor(url) { this.url = url; this.paused = true; this.currentTime = 0; FakePlayer.made.push(this); }
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
}

let panel;
const blob = new Blob(['x'], { type: 'audio/webm' });
const q = (selector) => panel.el.querySelector(selector);
const text = (selector) => q(selector)?.textContent;

beforeEach(() => {
  FakePlayer.made = [];
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:take');
  globalThis.URL.revokeObjectURL = vi.fn();
  panel = createPracticePanel({ Player: FakePlayer });
  document.body.replaceChildren(panel.el);
});
afterEach(() => { panel.clear(); });

describe('while listening', () => {
  it('is hidden until there is something to show', () => {
    expect(panel.el.hidden).toBe(true);
  });

  it('asks for the words, then shows them as they are heard', () => {
    panel.listening();
    expect(panel.el.hidden).toBe(false);
    expect(text('.practice-status')).toBe('Listening… say it now.');
    panel.listening('I thought the');
    expect(text('.practice-status')).toBe('I thought the');
  });

  // A paragraph being said: the whole of it would push everything else off the bar.
  it('shows the end of a long passage as it is heard', () => {
    panel.listening(`${'word '.repeat(80)}and the last words`);
    expect(text('.practice-status').startsWith('…')).toBe(true);
    expect(text('.practice-status').endsWith('and the last words')).toBe(true);
    expect(text('.practice-status').length).toBe(161);
  });
});

describe('the words of a take', () => {
  it('says so when every word was heard, and shows no transcript', () => {
    panel.show({ comparison: compareWords('select a word', 'Select a word.'), heard: 'Select a word.', blob });
    expect(text('.practice-summary')).toBe('Every word was heard.');
    expect([...panel.el.querySelectorAll('.practice-word')].map((w) => w.className)).toEqual(
      ['practice-word heard', 'practice-word heard', 'practice-word heard'],
    );
    expect(q('.practice-heard')).toBeNull();
  });

  it('marks the word that came out as another, says which, and shows what was heard', () => {
    panel.show({ comparison: compareWords('the leather would', 'the weather would'), heard: 'the weather would', blob });
    expect(text('.practice-summary')).toBe('2 of 3 words were heard.');
    const leather = panel.el.querySelectorAll('.practice-word')[1];
    expect(leather.classList.contains('different')).toBe(true);
    expect(leather.title).toBe('Heard as “weather”');
    expect(text('.practice-heard')).toBe('Heard: “the weather would”');
  });

  it('marks a word that was not heard', () => {
    panel.show({ comparison: compareWords('the whole weekend', 'the weekend'), heard: 'the weekend', blob });
    expect(panel.el.querySelectorAll('.practice-word')[1].title).toBe('Not heard');
  });

  it('speaks of one word as one word', () => {
    panel.show({ comparison: compareWords('language', 'language'), heard: 'language', blob });
    expect(text('.practice-summary')).toBe('The word was heard.');
    panel.show({ comparison: compareWords('language', 'luggage'), heard: 'luggage', blob });
    expect(text('.practice-summary')).toBe('The word was not heard as written.');
  });

  it('shows the transcript when something extra was said, even with every word heard', () => {
    panel.show({ comparison: compareWords('thank you', 'thank you very much'), heard: 'thank you very much', blob });
    expect(text('.practice-heard')).toBe('Heard: “thank you very much”');
  });

  // The recogniser failing is not the speaker missing every word.
  it('does not blame the speaker when the recogniser made nothing of the take', () => {
    panel.show({ comparison: null, unclear: true, heard: '', blob });
    expect(text('.practice-summary')).toContain('could not be made out');
    expect(q('.practice-word')).toBeNull();
  });

  it('still offers the recording where the words cannot be checked at all', () => {
    panel.show({ comparison: null, heard: '', blob });
    expect(text('.practice-summary')).toBe('Recorded. This browser cannot check the words on this device.');
    expect(q('.practice-play')).toBeTruthy();
  });
});

describe('hearing it back', () => {
  beforeEach(() => panel.show({ comparison: compareWords('a word', 'a word'), heard: 'a word', blob }));

  it('plays the reader\'s own recording, and stops on a second press', () => {
    q('.practice-play').click();
    expect(FakePlayer.made).toHaveLength(1);
    expect(FakePlayer.made[0].url).toBe('blob:take');
    expect(q('.practice-play').classList.contains('playing')).toBe(true);
    q('.practice-play').click();
    expect(FakePlayer.made[0].paused).toBe(true);
    expect(q('.practice-play').classList.contains('playing')).toBe(false);
  });

  it('goes back to Play when the recording ends', () => {
    q('.practice-play').click();
    FakePlayer.made[0].onended();
    expect(q('.practice-play').classList.contains('playing')).toBe(false);
  });

  it('asks for another take', () => {
    const onAgain = vi.fn();
    panel = createPracticePanel({ onAgain, Player: FakePlayer });
    panel.show({ comparison: null, heard: '', blob });
    panel.el.querySelector('.practice-again').click();
    expect(onAgain).toHaveBeenCalled();
  });

  it('lets go of the recording when it is cleared', () => {
    q('.practice-play').click();
    panel.clear();
    expect(FakePlayer.made[0].paused).toBe(true);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:take');
    expect(panel.el.hidden).toBe(true);
    expect(panel.el.childElementCount).toBe(0);
  });
});

describe('the melody', () => {
  const melody = (over) => ({ centre: 180, range: 9.2, spans: [{ from: 0.2, to: 0.5, points: [0, 1, 2, 1] }, { from: 0.8, to: 1.1, points: [-1, -2, -3] }], ...over });
  beforeEach(() => panel.show({ comparison: compareWords('a word', 'a word'), heard: 'a word', blob }));

  it('draws one line for each stretch of voice, above the buttons', () => {
    panel.showMelody(melody(), 1.5);
    expect(panel.el.querySelectorAll('.practice-melody-line')).toHaveLength(2);
    expect(q('.practice-melody').nextElementSibling).toBe(q('.practice-actions'));
  });

  it('says about how far the voice moved, without judging it', () => {
    panel.showMelody(melody(), 1.5);
    expect(text('.practice-melody-words')).toBe('Your voice moved over about 9 semitones.');
    panel.showMelody(melody({ range: 2.4 }), 1.5);
    expect(text('.practice-melody-words')).toBe('Your voice stayed almost level.');
    panel.showMelody(melody({ range: 6 }), 1.5);
    expect(text('.practice-melody-words')).toBe('Your voice moved over about 6 semitones.');
    // Nothing is said of how it ended: that could not be told reliably.
    expect(text('.practice-melody-words')).not.toMatch(/end/);
  });

  it('keeps the line inside the picture however far the voice went', () => {
    panel.showMelody(melody({ spans: [{ from: 0, to: 1, points: [40, -40] }] }), 1);
    const ys = q('.practice-melody-line').getAttribute('points').split(' ').map((p) => Number(p.split(',')[1]));
    for (const y of ys) { expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThanOrEqual(80); }
  });

  // A take begins and ends in silence. Drawn whole, the line would sit squeezed in the middle.
  it('shows the spoken part of the take, not the silence around it', () => {
    panel.showMelody(melody(), 10);
    const xs = [...panel.el.querySelectorAll('.practice-melody-line')].flatMap((l) => l.getAttribute('points').split(' ').map((p) => Number(p.split(',')[0])));
    expect(Math.min(...xs)).toBeLessThan(60);
    expect(Math.max(...xs)).toBeGreaterThan(300);
  });

  // A voice has no pitch during s, t or k, so the measured line stops there although the
  // speaker did not. Left as gaps, the picture reads as if they had stopped.
  it('joins the line across a sound with no pitch, and leaves a pause open', () => {
    panel.showMelody(melody({
      spans: [
        { from: 0.2, to: 0.5, points: [0, 1, 2] },
        { from: 0.6, to: 0.9, points: [3, 2, 1] },   // 0.1 s after the first: a consonant
        { from: 1.7, to: 2.0, points: [0, -1, -2] }, // 0.8 s after the second: a pause
      ],
    }), 2.2);
    expect(panel.el.querySelectorAll('.practice-melody-line')).toHaveLength(3);
    const joins = [...panel.el.querySelectorAll('.practice-melody-join')];
    expect(joins).toHaveLength(1);
    // From where the first stretch ended to where the second began.
    const [from, to] = joins[0].getAttribute('points').split(' ');
    const lines = [...panel.el.querySelectorAll('.practice-melody-line')].map((l) => l.getAttribute('points').split(' '));
    expect(from).toBe(lines[0][lines[0].length - 1]);
    expect(to).toBe(lines[1][0]);
  });

  it('says on the picture which way is up, and what its dots and gaps are', () => {
    panel.showMelody(melody(), 1.5);
    expect(text('.practice-melody-high')).toBe('higher');
    expect(text('.practice-melody-low')).toBe('lower');
    expect(text('.practice-melody-key')).toBe('The line is the pitch of your voice: up is higher. '
      + 'Dots join it where there is no clear pitch, as in s and t. A gap is a pause.');
  });

  // Squeezed into the panel, a paragraph's line is too fine to read.
  it('gives a long take room, to scroll sideways', () => {
    panel.showMelody(melody(), 1.5);
    expect(q('.practice-melody-graph').style.minWidth).toBe('');
    // A sentence or two is drawn across the panel. Reported: a scroll bar under a 13 s take
    // that overflowed by a few pixels.
    panel.showMelody(melody({ spans: [{ from: 0.2, to: 0.5, points: [0, 1] }, { from: 13, to: 13.6, points: [1, 0] }] }), 14);
    expect(q('.practice-melody-graph').style.minWidth).toBe('');
    panel.showMelody(melody({ spans: [{ from: 0.2, to: 0.5, points: [0, 1] }, { from: 39.5, to: 40, points: [1, 0] }] }), 41);
    expect(parseInt(q('.practice-melody-graph').style.minWidth, 10)).toBeGreaterThan(1200);
    expect(q('.practice-melody-graph').parentElement).toBe(q('.practice-melody-scroll'));
  });

  // A loud room or a distant microphone: scattered pieces of line, which mean little. The
  // first version drew them and called it 24 semitones.
  it('says so, and gives no figures, when only a little of the voice could be measured', () => {
    panel.showMelody(melody({
      range: 24,
      spans: [{ from: 0.5, to: 0.6, points: [0, 1] }, { from: 3, to: 3.1, points: [12, 11] }, { from: 6, to: 6.1, points: [-12, -11] }],
    }), 7);
    expect(text('.practice-melody-rough')).toBe('Only a little of your voice could be measured, so this line is rough. '
      + 'Try a quieter room, speak closer to the microphone, or choose another microphone in Settings.');
    expect(q('.practice-melody-words')).toBeNull();
    // An ordinary take, pauses and all, is not called rough.
    panel.showMelody(melody(), 1.5);
    expect(q('.practice-melody-rough')).toBeNull();
    expect(text('.practice-melody-words')).toMatch(/^Your voice moved/);
  });

  it('shows nothing for a take with no voice in it', () => {
    panel.showMelody(null, 1);
    expect(q('.practice-melody')).toBeNull();
  });

  it('replaces the old line with the new one', () => {
    panel.showMelody(melody(), 1.5);
    panel.showMelody(melody(), 1.5);
    expect(panel.el.querySelectorAll('.practice-melody')).toHaveLength(1);
  });
});

// What ties the line to the sound: without it there is no telling which rise or fall
// belongs to which word.
describe('the pointer on the pitch line', () => {
  // The voice runs from 0.2 s to 1.1 s of a 2 s take; the picture shows 0.05 s to 1.25 s.
  const melody = { centre: 180, range: 9.2, spans: [{ from: 0.2, to: 0.5, points: [0, 1, 2, 1] }, { from: 0.8, to: 1.1, points: [-1, -2, -3] }] };
  let frames;
  const repaint = async () => {
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
    frames.splice(0).forEach((step) => step());
  };
  const head = () => q('.practice-melody-head');
  const player = () => FakePlayer.made[FakePlayer.made.length - 1];
  const at = () => Number(head().getAttribute('x1'));

  beforeEach(() => {
    frames = [];
    panel = createPracticePanel({ Player: FakePlayer, nextFrame: (step) => frames.push(step) });
    document.body.replaceChildren(panel.el);
    panel.show({ comparison: compareWords('a word', 'a word'), heard: 'a word', blob });
    panel.showMelody(melody, 2);
  });

  it('is out of sight until the recording plays', () => {
    expect(head().getAttribute('visibility')).toBe('hidden');
  });

  // A take starts with a moment of silence; nobody wants to wait through it.
  it('starts the recording where the voice starts', () => {
    q('.practice-play').click();
    expect(player().currentTime).toBeCloseTo(0.05, 5);
    expect(player().paused).toBe(false);
  });

  it('moves along the line with the recording', async () => {
    q('.practice-play').click();
    await repaint();
    expect(head().getAttribute('visibility')).toBe('visible');
    expect(at()).toBeCloseTo(0, 1);
    player().currentTime = 0.65; // half-way through the 1.2 s shown
    await repaint();
    expect(at()).toBeCloseTo(200, 1);
    expect(head().getAttribute('x2')).toBe(head().getAttribute('x1'));
    player().currentTime = 0.95;
    await repaint();
    expect(at()).toBeCloseTo(300, 1);
  });

  it('stops where the voice stops, and goes out of sight', async () => {
    q('.practice-play').click();
    await repaint();
    player().currentTime = 1.3; // past the end of the spoken part
    await repaint();
    expect(player().paused).toBe(true);
    expect(head().getAttribute('visibility')).toBe('hidden');
    expect(q('.practice-play').classList.contains('playing')).toBe(false);
    await repaint();
    expect(frames).toHaveLength(0); // and it stops following
  });

  it('goes out of sight when the recording is stopped or ends', async () => {
    q('.practice-play').click();
    await repaint();
    q('.practice-play').click();
    expect(head().getAttribute('visibility')).toBe('hidden');
    q('.practice-play').click();
    await repaint();
    player().onended();
    expect(head().getAttribute('visibility')).toBe('hidden');
  });

  it('scrolls a long take along with the pointer', async () => {
    const scroller = q('.practice-melody-scroll');
    Object.defineProperty(scroller, 'scrollWidth', { value: 1200, configurable: true });
    Object.defineProperty(scroller, 'clientWidth', { value: 400, configurable: true });
    q('.practice-play').click();
    await repaint();
    player().currentTime = 0.65; // half-way along the picture
    await repaint();
    expect(scroller.scrollLeft).toBeCloseTo(400, 0); // the pointer, at 600, sits in the middle of the 400 shown
  });

  it('plays from the point clicked on the line', async () => {
    const graph = q('.practice-melody-graph');
    graph.getBoundingClientRect = () => ({ left: 100, width: 400, top: 0, height: 60 });
    graph.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 400 })); // three quarters along
    expect(player().currentTime).toBeCloseTo(0.05 + 0.75 * 1.2, 5);
    expect(q('.practice-play').classList.contains('playing')).toBe(true);
    await repaint();
    expect(at()).toBeCloseTo(300, 1);
  });

  it('starts again from a new point when clicked while it is playing', async () => {
    const graph = q('.practice-melody-graph');
    graph.getBoundingClientRect = () => ({ left: 0, width: 400, top: 0, height: 60 });
    q('.practice-play').click();
    await repaint();
    graph.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 100 }));
    expect(FakePlayer.made).toHaveLength(2);
    expect(FakePlayer.made[0].paused).toBe(true);
    expect(player().currentTime).toBeCloseTo(0.05 + 0.25 * 1.2, 5);
  });

  it('plays the whole recording, with no pointer, when there is no line to show', async () => {
    panel.showMelody(null, 2);
    q('.practice-play').click();
    await repaint();
    expect(player().currentTime).toBe(0);
    expect(head()).toBeNull();
    expect(player().paused).toBe(false);
  });

  it('picks up the line if it is drawn while the recording is already playing', async () => {
    panel.showMelody(null, 2);
    q('.practice-play').click();
    await repaint();
    panel.showMelody(melody, 2);
    player().currentTime = 0.65;
    await repaint();
    expect(head().getAttribute('visibility')).toBe('visible');
    expect(at()).toBeCloseTo(200, 1);
  });

  it('stops following when the panel is cleared', async () => {
    q('.practice-play').click();
    await repaint();
    panel.clear();
    await repaint();
    expect(frames).toHaveLength(0);
    expect(player().paused).toBe(true);
  });
});
