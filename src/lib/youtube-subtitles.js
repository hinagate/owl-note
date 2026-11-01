// A YouTube video's own subtitles, used in place of speech recognition whenever the
// video has them: the creator's text (or YouTube's server-side captions), timed to
// the video, for the whole video in one request — no playing it through.
//
// Measured on a Mandarin talk, first 75 s against the creator's subtitles: Chrome's
// on-device recognizer got 16% of characters wrong (伊朗戰爭 → 一黨專政). Subtitles,
// where a video has them, are simply the right text.
//
// Two page functions run in the page's own world (chrome.scripting, world: 'MAIN'),
// because YouTube's player API and its subtitle requests exist only there. They are
// serialized into the page, so they use nothing else from this module. Everything
// that decides anything is a pure function below them, tested on its own.

/**
 * In the page: the video's subtitle tracks, and one subtitle request URL made by
 * YouTube's own player. YouTube now answers a subtitle request only when it carries
 * a token its player mints, so the URL is borrowed rather than built. If the player
 * has not asked for subtitles yet, captions are switched on just long enough for it
 * to, then put back the way the reader had them.
 */
export async function youtubeSubtitleInfo(waitMs = 6000) {
  const player = document.getElementById('movie_player');
  const response = player?.getPlayerResponse?.();
  const renderer = response?.captions?.playerCaptionsTracklistRenderer;
  const videoId = response?.videoDetails?.videoId || '';
  const tracks = (renderer?.captionTracks || []).map((t) => ({
    baseUrl: t.baseUrl || '',
    languageCode: t.languageCode || '',
    kind: t.kind || '',
    name: t.name?.simpleText || (t.name?.runs || []).map((r) => r.text).join('') || t.languageCode || '',
  }));
  const info = { videoId, tracks, defaultIndex: renderer?.audioTracks?.[0]?.defaultCaptionTrackIndex ?? -1, playerUrl: '' };
  if (!videoId || !tracks.length) return info;

  // An observer, not getEntriesByType: the resource timing buffer holds 250 entries
  // and a long YouTube session fills it, after which new requests are never listed.
  const seen = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.name.includes('/api/timedtext') && entry.name.includes(`v=${videoId}`)) seen.push(entry.name);
    }
  });
  observer.observe({ type: 'resource', buffered: true });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const button = document.querySelector('.ytp-subtitles-button');
  const isOn = () => button?.getAttribute('aria-pressed') === 'true';
  const wasOn = isOn();
  if (!seen.length && button) {
    // Off: switch on, and the player asks. Already on but not asked yet — a video
    // paused before it started — takes off and on again.
    if (wasOn) button.click();
    button.click();
  }
  const deadline = Date.now() + waitMs;
  while (!seen.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 150));
  observer.disconnect();
  if (button && isOn() !== wasOn) button.click();
  info.playerUrl = seen[seen.length - 1] || '';
  return info;
}

/** In the page: fetch with the page's own origin and cookies. */
export async function fetchPageText(url) {
  try {
    const response = await fetch(url, { credentials: 'include' });
    return response.ok ? await response.text() : '';
  } catch {
    return '';
  }
}

export function isYouTubeWatchUrl(url) {
  try {
    const u = new URL(String(url || ''));
    return /^(www\.|m\.)?youtube\.com$/.test(u.hostname) && u.pathname === '/watch' && !!u.searchParams.get('v');
  } catch {
    return false;
  }
}

const TRADITIONAL = /^zh-(hant|tw|hk|mo)\b/i;
const primary = (code) => String(code || '').split('-')[0].toLowerCase();

/**
 * Which track is the transcript. The spoken language is the auto-generated track's,
 * when YouTube made one; a subtitle the creator uploaded in that language beats the
 * auto-generated one, and an upload in another language is a translation, not what
 * was said. Chinese is read in Traditional characters: a Simplified track is fetched
 * through YouTube's own translation into Traditional.
 * @returns {{ track: object, translateTo: string } | null}
 */
export function pickSubtitleTrack(tracks, defaultIndex = -1) {
  const usable = (tracks || []).filter((t) => t && t.baseUrl && t.languageCode);
  if (!usable.length) return null;
  const auto = usable.find((t) => t.kind === 'asr');
  const uploaded = usable.filter((t) => t.kind !== 'asr');
  const fallback = (tracks || [])[defaultIndex];
  const spoken = primary(auto?.languageCode || fallback?.languageCode || uploaded[0]?.languageCode);
  const rank = (t) => (TRADITIONAL.test(t.languageCode) ? 0 : 2) + (t === fallback ? 0 : 1);
  const [track] = uploaded.filter((t) => primary(t.languageCode) === spoken).sort((a, b) => rank(a) - rank(b));
  const chosen = track || auto || uploaded[0];
  return {
    track: chosen,
    translateTo: primary(chosen.languageCode) === 'zh' && !TRADITIONAL.test(chosen.languageCode) ? 'zh-Hant' : '',
  };
}

// The parameters that say WHICH subtitles; everything else on the player's request
// (its token, client name and version) is what makes YouTube answer at all.
const TRACK_PARAMS = new Set(['v', 'lang', 'kind', 'name', 'tlang', 'fmt']);

/**
 * The chosen track's own URL, carrying the player's token, as JSON. Without a
 * player request to borrow from, the track's URL goes as it is — YouTube still
 * answers it for some sessions (measured: a signed-in one sent no token at all).
 */
export function subtitleFetchUrl(trackUrl, playerUrl, translateTo = '') {
  const url = new URL(trackUrl, 'https://www.youtube.com');
  const borrowed = playerUrl ? new URL(playerUrl, 'https://www.youtube.com').searchParams : [];
  for (const [key, value] of borrowed) {
    if (!TRACK_PARAMS.has(key) && !url.searchParams.has(key)) url.searchParams.set(key, value);
  }
  url.searchParams.set('fmt', 'json3');
  if (translateTo) url.searchParams.set('tlang', translateTo);
  else url.searchParams.delete('tlang');
  return url.href;
}

/**
 * YouTube's json3 subtitle format as transcript cues, timed by the video itself.
 * @returns {{ text: string, videoTime: number, at: number, endAt: number }[]}
 */
export function subtitleCues(json) {
  let data = json;
  if (typeof json === 'string') {
    try { data = JSON.parse(json); } catch { return []; }
  }
  return (data?.events || [])
    .filter((event) => Array.isArray(event.segs))
    .map((event) => {
      const start = Number(event.tStartMs) || 0;
      return {
        text: event.segs.map((seg) => seg.utf8 || '').join('').replace(/\s*\n\s*/g, ' ').trim(),
        videoTime: start / 1000,
        at: start,
        endAt: start + (Number(event.dDurationMs) || 0),
      };
    })
    .filter((cue) => cue.text);
}
