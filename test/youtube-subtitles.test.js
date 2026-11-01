import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  isYouTubeWatchUrl, pickSubtitleTrack, subtitleCues, subtitleFetchUrl, youtubeSubtitleInfo,
} from '../src/lib/youtube-subtitles.js';

const track = (languageCode, kind = '', name = languageCode) => ({
  baseUrl: `https://www.youtube.com/api/timedtext?v=abc&lang=${languageCode}${kind ? `&kind=${kind}` : ''}&signature=s1`,
  languageCode,
  kind,
  name,
});

describe('isYouTubeWatchUrl', () => {
  it('accepts YouTube watch pages only', () => {
    expect(isYouTubeWatchUrl('https://www.youtube.com/watch?v=JSceD5YxhF8')).toBe(true);
    expect(isYouTubeWatchUrl('https://m.youtube.com/watch?v=abc&t=10')).toBe(true);
    expect(isYouTubeWatchUrl('https://youtube.com/watch?v=abc')).toBe(true);
    expect(isYouTubeWatchUrl('https://www.youtube.com/watch')).toBe(false);
    expect(isYouTubeWatchUrl('https://www.youtube.com/shorts/abc')).toBe(false);
    expect(isYouTubeWatchUrl('https://music.youtube.com/watch?v=abc')).toBe(false);
    expect(isYouTubeWatchUrl('https://notyoutube.com/watch?v=abc')).toBe(false);
    expect(isYouTubeWatchUrl('not a url')).toBe(false);
  });
});

describe('pickSubtitleTrack', () => {
  it('takes the creator’s subtitles over YouTube’s auto-generated ones', () => {
    const picked = pickSubtitleTrack([track('zh-TW', 'asr'), track('zh-Hant')]);
    expect(picked).toEqual({ track: expect.objectContaining({ languageCode: 'zh-Hant', kind: '' }), translateTo: '' });
  });

  // An upload in another language is a translation, not what was said.
  it('prefers auto-generated subtitles in the spoken language to a translation', () => {
    const picked = pickSubtitleTrack([track('zh-Hant'), track('en', 'asr')]);
    expect(picked.track).toMatchObject({ languageCode: 'en', kind: 'asr' });
  });

  it('reads Chinese in Traditional characters when both are uploaded', () => {
    expect(pickSubtitleTrack([track('zh-Hans'), track('zh-Hant'), track('zh', 'asr')]).track.languageCode).toBe('zh-Hant');
    expect(pickSubtitleTrack([track('zh-CN'), track('zh-TW')]).track.languageCode).toBe('zh-TW');
  });

  it('fetches a Simplified-only track through YouTube’s translation into Traditional', () => {
    expect(pickSubtitleTrack([track('zh-Hans')])).toMatchObject({ translateTo: 'zh-Hant' });
    expect(pickSubtitleTrack([track('zh-CN', 'asr')])).toMatchObject({ translateTo: 'zh-Hant' });
    expect(pickSubtitleTrack([track('en')])).toMatchObject({ translateTo: '' });
    expect(pickSubtitleTrack([track('zh-HK')])).toMatchObject({ translateTo: '' });
  });

  it('falls back to the player’s default track when nothing says what was spoken', () => {
    const tracks = [track('en'), track('ja')];
    expect(pickSubtitleTrack(tracks, 1).track.languageCode).toBe('ja');
    expect(pickSubtitleTrack(tracks).track.languageCode).toBe('en');
  });

  it('returns null when there is nothing to read', () => {
    expect(pickSubtitleTrack([])).toBe(null);
    expect(pickSubtitleTrack(undefined)).toBe(null);
    expect(pickSubtitleTrack([{ languageCode: 'en' }])).toBe(null);
  });
});

describe('subtitleFetchUrl', () => {
  const PLAYER = 'https://www.youtube.com/api/timedtext?v=abc&lang=en&kind=asr&tlang=fr&signature=s1&pot=TOKEN&potc=1&c=WEB&cver=2.2026&fmt=srv3';

  // The player's token is what makes YouTube answer; the track says which subtitles.
  it('borrows the player’s token but keeps the chosen track’s identity', () => {
    const url = new URL(subtitleFetchUrl(track('zh-Hant').baseUrl, PLAYER));
    expect(url.searchParams.get('pot')).toBe('TOKEN');
    expect(url.searchParams.get('c')).toBe('WEB');
    expect(url.searchParams.get('cver')).toBe('2.2026');
    expect(url.searchParams.get('lang')).toBe('zh-Hant');
    expect(url.searchParams.has('kind')).toBe(false);
    expect(url.searchParams.has('tlang')).toBe(false);
    expect(url.searchParams.get('fmt')).toBe('json3');
  });

  it('asks YouTube for a translation when one is wanted', () => {
    const url = new URL(subtitleFetchUrl(track('zh-Hans').baseUrl, PLAYER, 'zh-Hant'));
    expect(url.searchParams.get('tlang')).toBe('zh-Hant');
    expect(url.searchParams.get('lang')).toBe('zh-Hans');
  });

  it('sends the track’s own URL when there is no player request to borrow from', () => {
    const url = new URL(subtitleFetchUrl(track('en').baseUrl, ''));
    expect(url.searchParams.has('pot')).toBe(false);
    expect(url.searchParams.get('fmt')).toBe('json3');
  });
});

describe('subtitleCues', () => {
  const JSON3 = {
    events: [
      { tStartMs: 0, dDurationMs: 50 },
      { tStartMs: 120, dDurationMs: 600, segs: [{ utf8: '大家好 我參老' }] },
      { tStartMs: 720, dDurationMs: 1720, segs: [{ utf8: 'two\nlines' }, { utf8: ' joined' }] },
      { tStartMs: 3000, dDurationMs: 10, segs: [{ utf8: '\n' }] },
    ],
  };

  it('turns timed lines into cues placed by the video’s own clock', () => {
    expect(subtitleCues(JSON3)).toEqual([
      { text: '大家好 我參老', videoTime: 0.12, at: 120, endAt: 720 },
      { text: 'two lines joined', videoTime: 0.72, at: 720, endAt: 2440 },
    ]);
  });

  it('reads the raw response text, and yields nothing for an empty or broken one', () => {
    expect(subtitleCues(JSON.stringify(JSON3))).toHaveLength(2);
    expect(subtitleCues('')).toEqual([]);
    expect(subtitleCues('<html>')).toEqual([]);
    expect(subtitleCues(null)).toEqual([]);
  });
});

// The one part with a side effect the reader can see: captions are switched on for
// the player to ask for subtitles, and must be left exactly as they were found.
describe('youtubeSubtitleInfo, in a page', () => {
  let observers;
  let pending; // timedtext requests the fake player "makes" when captions turn on

  function fakePage({ tracks, captionsOn = false, alreadyRequested = false }) {
    observers = [];
    pending = alreadyRequested ? ['https://www.youtube.com/api/timedtext?v=abc&lang=en&pot=EARLY'] : [];
    document.body.innerHTML = `<div id="movie_player"></div><button class="ytp-subtitles-button" aria-pressed="${captionsOn}"></button>`;
    document.getElementById('movie_player').getPlayerResponse = () => ({
      videoDetails: { videoId: 'abc' },
      captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks, audioTracks: [{ defaultCaptionTrackIndex: 0 }] } },
    });
    const button = document.querySelector('.ytp-subtitles-button');
    button.addEventListener('click', () => {
      const on = button.getAttribute('aria-pressed') !== 'true';
      button.setAttribute('aria-pressed', String(on));
      if (on) pending.push('https://www.youtube.com/api/timedtext?v=abc&lang=en&pot=FRESH');
    });
    class FakeObserver {
      constructor(callback) { this.callback = callback; observers.push(this); }

      observe() {
        const deliver = () => {
          const names = pending.splice(0);
          if (names.length) this.callback({ getEntries: () => names.map((name) => ({ name })) });
        };
        deliver();
        this.timer = setInterval(deliver, 20);
      }

      disconnect() { clearInterval(this.timer); }
    }
    vi.stubGlobal('PerformanceObserver', FakeObserver);
    return button;
  }

  afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ''; });

  const TRACKS = [{ baseUrl: '/api/timedtext?v=abc&lang=en', languageCode: 'en', kind: 'asr', name: { simpleText: 'English (auto-generated)' } }];

  it('switches captions on for the player to ask, then off again', async () => {
    const button = fakePage({ tracks: TRACKS });
    const info = await youtubeSubtitleInfo(2000);
    expect(info.playerUrl).toContain('pot=FRESH');
    expect(info.tracks).toEqual([{ baseUrl: '/api/timedtext?v=abc&lang=en', languageCode: 'en', kind: 'asr', name: 'English (auto-generated)' }]);
    expect(button.getAttribute('aria-pressed')).toBe('false');
  });

  it('uses a request the player already made, touching nothing', async () => {
    const button = fakePage({ tracks: TRACKS, alreadyRequested: true });
    const clicks = vi.fn();
    button.addEventListener('click', clicks);
    expect((await youtubeSubtitleInfo(2000)).playerUrl).toContain('pot=EARLY');
    expect(clicks).not.toHaveBeenCalled();
  });

  // Captions on but never requested: a video paused before it started.
  it('leaves captions on when the reader had them on', async () => {
    const button = fakePage({ tracks: TRACKS, captionsOn: true });
    expect((await youtubeSubtitleInfo(2000)).playerUrl).toContain('pot=FRESH');
    expect(button.getAttribute('aria-pressed')).toBe('true');
  });

  it('does not touch captions on a video without subtitles', async () => {
    const button = fakePage({ tracks: [] });
    const info = await youtubeSubtitleInfo(2000);
    expect(info).toMatchObject({ videoId: 'abc', tracks: [], playerUrl: '' });
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(observers).toHaveLength(0);
  });
});
