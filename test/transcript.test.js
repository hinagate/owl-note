import { describe, it, expect } from 'vitest';
import { dedupeCues, cuesToMarkdown, buildTranscriptNote } from '../src/lib/transcript.js';

const cue = (text, over = {}) => ({ text, videoTime: null, at: 0, ...over });

describe('dedupeCues — rolling caption windows', () => {
  it('collapses a rolling window into one utterance', () => {
    // YouTube repaints a two-line window, so each cue re-states the tail of the
    // previous one. The words actually spoken are "hello world this is a test".
    const cues = [
      cue('hello world'),
      cue('hello world this is'),
      cue('world this is a test'),
    ];
    expect(dedupeCues(cues).map((c) => c.text)).toEqual(['hello world this is a test']);
  });

  it('does not merge overlapping cues separated by a long gap', () => {
    // A repaint arrives within a second or two. Half a minute later, the same
    // words are a new sentence that happens to start how the last one ended —
    // "the end" must not swallow them into one utterance.
    const cues = [
      cue('and that is the end', { at: 0 }),
      cue('the end of the lecture', { at: 30000 }),
    ];
    expect(dedupeCues(cues).map((c) => c.text)).toEqual([
      'and that is the end',
      'the end of the lecture',
    ]);
  });
});

describe('cuesToMarkdown — paragraphs', () => {
  it('joins cues into a paragraph and starts a new one after a long pause', () => {
    const cues = [
      cue('First sentence here.', { at: 0, videoTime: 0 }),
      cue('Still the same thought.', { at: 4000, videoTime: 4 }),
      cue('A new topic entirely.', { at: 30000, videoTime: 30 }),
    ];
    expect(cuesToMarkdown(cues)).toBe(
      'First sentence here. Still the same thought.\n\nA new topic entirely.',
    );
  });
});

describe('cuesToMarkdown — pauses are measured from when speech stopped', () => {
  it('keeps a long unbroken utterance in the same paragraph as what follows it', () => {
    // Twelve seconds of continuous speech arriving as rolling repaints, then the
    // next sentence one second later. There is no pause anywhere, so this is one
    // paragraph — even though the utterance STARTED more than a pause ago.
    const cues = [
      cue('so the gradient descent', { at: 0 }),
      cue('gradient descent algorithm takes', { at: 2000 }),
      cue('algorithm takes a small step', { at: 4000 }),
      cue('a small step downhill each', { at: 6000 }),
      cue('downhill each iteration until it', { at: 8000 }),
      cue('iteration until it converges', { at: 10000 }),
      cue('converges to a minimum', { at: 12000 }),
      cue('Any questions so far?', { at: 13000 }),
    ];
    expect(cuesToMarkdown(cues)).toBe(
      'so the gradient descent algorithm takes a small step downhill each iteration'
        + ' until it converges to a minimum Any questions so far?',
    );
  });
});

describe('cuesToMarkdown — timestamp headings', () => {
  it('emits a heading when the video crosses a five-minute boundary', () => {
    const cues = [
      cue('Before the boundary.', { at: 0, videoTime: 290 }), // 04:50
      cue('After the boundary.', { at: 20000, videoTime: 305 }), // 05:05
    ];
    expect(cuesToMarkdown(cues)).toBe(
      'Before the boundary.\n\n## 05:00\n\nAfter the boundary.',
    );
  });

  it('does not open a short session with a 00:00 heading', () => {
    const cues = [cue('Just a minute of talking.', { at: 0, videoTime: 3 })];
    expect(cuesToMarkdown(cues)).toBe('Just a minute of talking.');
  });
});

  it('falls back to elapsed recording time when no player time is available', () => {
    const cues = [
      cue('Start of the recording.', { at: 0, videoTime: null }),
      cue('Six minutes later.', { at: 360000, videoTime: null }),
    ];
    expect(cuesToMarkdown(cues)).toBe(
      'Start of the recording.\n\n## 05:00\n\nSix minutes later.',
    );
  });

describe('buildTranscriptNote', () => {
  it('titles the note after the page and opens with source, date and duration', () => {
    const note = buildTranscriptNote({
      title: '  Gradient   Descent Explained ',
      url: 'https://example.com/watch?v=abc',
      startedAt: Date.parse('2026-07-29T10:00:00Z'),
      endedAt: Date.parse('2026-07-29T10:42:30Z'),
      cues: [cue('Some spoken words.', { at: 0, videoTime: 1 })],
    });
    expect(note.title).toBe('Gradient Descent Explained');
    expect(note.body.split('\n\n')[0]).toBe(
      'Source: <https://example.com/watch?v=abc> · 2026-07-29 · 42 min',
    );
    expect(note.body).toContain('Some spoken words.');
  });

  it('omits an unusable source URL rather than emitting an empty one', () => {
    const note = buildTranscriptNote({
      title: 'Local file',
      url: 'file:///C:/video.mp4',
      startedAt: 0,
      endedAt: 60000,
      cues: [cue('Words.', { at: 0 })],
    });
    expect(note.body.startsWith('Source:')).toBe(false);
  });
});
