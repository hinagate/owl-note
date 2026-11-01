import { describe, it, expect } from 'vitest';
import { dedupeCues, cuesToMarkdown, buildTranscriptNote, tidyRecognizedText } from '../src/lib/transcript.js';

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

describe('cuesToMarkdown — a video’s own subtitles', () => {
  // Subtitle lines run back to back: a 10 s pause never comes, so time breaks them.
  const line = (text, s, len = 2) => ({ text, videoTime: s, at: s * 1000, endAt: (s + len) * 1000 - 100 });

  it('breaks paragraphs by video time, at a small gap once 30 s have passed', () => {
    const cues = [];
    for (let s = 0; s < 70; s += 2) cues.push(line(`L${s}`, s));
    cues[17] = { ...line('L34', 34), at: 34500 }; // a 0.6 s gap past the 30 s mark
    const paragraphs = cuesToMarkdown(cues, { subtitles: true }).split('\n\n');
    expect(paragraphs[0].split(' ').at(-1)).toBe('L32');
    expect(paragraphs[1].startsWith('L34')).toBe(true);
  });

  it('breaks after 45 s even without a gap', () => {
    const cues = [];
    for (let s = 0; s < 60; s += 2) cues.push(line(`L${s}`, s));
    const paragraphs = cuesToMarkdown(cues, { subtitles: true }).split('\n\n');
    expect(paragraphs[0].split(' ').at(-1)).toBe('L44');
  });

  // Subtitles are exact. The rolling-caption merge would eat a repeated word.
  it('never merges lines the way rolling captions are merged', () => {
    const cues = [line('I think that', 0), line('that is right', 2)];
    expect(cuesToMarkdown(cues, { subtitles: true })).toBe('I think that that is right');
    expect(cuesToMarkdown(cues)).toBe('I think that is right');
  });

  it('names the subtitle track in the note header', () => {
    const note = buildTranscriptNote({
      title: 'Talk',
      url: 'https://www.youtube.com/watch?v=abc',
      cues: [line('大家好', 0)],
      startedAt: Date.UTC(2026, 10, 1),
      endedAt: Date.UTC(2026, 10, 1) + 20 * 60000,
      subtitles: 'YouTube subtitles: 中文（繁體字）',
    });
    expect(note.body.split('\n\n')[0]).toBe(
      'Source: <https://www.youtube.com/watch?v=abc> · 2026-11-01 · 20 min · YouTube subtitles: 中文（繁體字）',
    );
  });
});

describe('tidyRecognizedText', () => {
  // Verbatim from Chrome's zh-TW model on a real talk, partway through a session.
  it('closes the spaces Chrome puts between Chinese characters', () => {
    expect(tidyRecognizedText('那 青 山 之 間 合 歷 史 上 的 舊 3 0 年 正 有 什 麼 連 續？ 有 什 麼 區 別？'))
      .toBe('那青山之間合歷史上的舊30年正有什麼連續？有什麼區別？');
    expect(tidyRecognizedText('說 一 下 新 30 年 戰 爭， 那 我 想')).toBe('說一下新30年戰爭，那我想');
  });

  it('leaves the spaces around Latin words and between English words', () => {
    expect(tidyRecognizedText('我們先用 Python 寫一個簡單的 API，然後')).toBe('我們先用 Python 寫一個簡單的 API，然後');
    expect(tidyRecognizedText('we had 2 3 ideas')).toBe('we had 2 3 ideas');
    expect(tidyRecognizedText('  plain English  ')).toBe('plain English');
  });

  it('closes them in Japanese too', () => {
    expect(tidyRecognizedText('今 日 は 晴 れ で す。')).toBe('今日は晴れです。');
  });
});

describe('cuesToMarkdown — Chinese and Japanese', () => {
  it('joins sentences after 。！？ with no space, as the scripts are written', () => {
    const cues = [
      cue('今天很好。', { at: 0 }),
      cue('我們走吧！', { at: 2000 }),
      cue('今日は晴れです。', { at: 4000 }),
      cue('and then English', { at: 6000 }),
    ];
    expect(cuesToMarkdown(cues)).toBe('今天很好。我們走吧！今日は晴れです。and then English');
  });

  // Without punctuation the space is the only mark of where one utterance ended.
  it('keeps a space between unpunctuated utterances', () => {
    const cues = [cue('我們今天討論', { at: 0 }), cue('這個問題', { at: 2000 })];
    expect(cuesToMarkdown(cues)).toBe('我們今天討論 這個問題');
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
