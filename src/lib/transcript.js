// Turns the raw cue stream from a capture session into a note body. A session
// stores raw cues and derives markdown from them, so recovering an interrupted
// capture is an exact replay. Pure module — no imports, no DOM/chrome APIs.

/**
 * @typedef {{ text: string, videoTime: number|null, at: number }} Cue
 */

// Chrome's Mandarin model falls into putting a space between every character partway
// through a session — measured on a real talk: 中 和 歷 史 上 的 舊 3 0 年. Chinese
// and Japanese take no spaces, so a gap between two such characters, or around digits
// they enclose, is the recognizer's and never the speaker's. Latin words keep theirs
// (用 Python 寫 stays as it is).
const CJK = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\u3000-\\u303f\\uff00-\\uffef';
const CJK_GAP = new RegExp(`(?<=[${CJK}])\\s+(?=[${CJK}])`, 'gu');
const CJK_DIGITS = new RegExp(`(?<=[${CJK}])\\s*\\d(?:\\s*\\d)*\\s*(?=[${CJK}])`, 'gu');

export function tidyRecognizedText(text) {
  return String(text ?? '')
    .replace(CJK_DIGITS, (digits) => digits.replace(/\s+/g, ''))
    .replace(CJK_GAP, '')
    .trim();
}

function words(text) {
  return String(text ?? '').trim().split(/\s+/).filter(Boolean);
}

// Rendered captions roll: each repaint re-states the tail of the previous cue.
// Merge on the longest run of WHOLE words shared between the end of `a` and the
// start of `b` — character overlap would happily splice mid-word.
// Returns null when the two cues share no boundary, meaning they're separate.
function mergeOverlap(a, b) {
  const aw = words(a);
  const bw = words(b);
  const max = Math.min(aw.length, bw.length);
  for (let k = max; k >= 1; k -= 1) {
    const tail = aw.slice(aw.length - k).join(' ').toLowerCase();
    const head = bw.slice(0, k).join(' ').toLowerCase();
    if (tail === head) return [...aw, ...bw.slice(k)].join(' ');
  }
  return null;
}

// A speaker's pause long enough to end a thought. Below this, utterances belong
// to the same paragraph.
const PARAGRAPH_GAP_MS = 10000;

// Bare `## mm:ss` headings this far apart give the heading-aware chunker real
// boundaries (ARCHITECTURE §4.5) without turning prose into a log file.
const HEADING_EVERY_S = 300;

// Utterances in spaced scripts join with a space. After Chinese or Japanese
// punctuation a space is a stray gap (今天很好。 我們走吧); between two unpunctuated
// CJK utterances it stays, as the only mark of where one ended.
const NO_SPACE_AFTER = /[。！？，、；：」』）]$/u;

function joinUtterances(parts) {
  return parts.reduce((out, part) => (out ? `${out}${NO_SPACE_AFTER.test(out) ? '' : ' '}${part}` : part), '');
}

function mmss(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// A repaint of the same utterance lands within a second or two. Past this, a
// textual overlap is coincidence — a new sentence that happens to start the way
// the last one ended — and merging it would fuse two unrelated utterances.
const ROLL_WINDOW_MS = 3000;

/**
 * Collapse a rolling caption window into distinct utterances.
 * @param {Cue[]} cues
 * @returns {Cue[]}
 */
export function dedupeCues(cues) {
  const out = [];
  let lastAt = 0; // when the most recent cue arrived, NOT when its utterance began
  for (const cue of cues || []) {
    const prev = out[out.length - 1];
    const inWindow = prev && Number(cue.at) - lastAt <= ROLL_WINDOW_MS;
    const merged = inWindow ? mergeOverlap(prev.text, cue.text) : null;
    lastAt = Number(cue.at) || 0;
    if (merged === null) {
      out.push({ ...cue, text: words(cue.text).join(' '), endAt: lastAt });
    } else {
      // The utterance keeps the timing of its first cue, but `endAt` tracks the
      // last repaint — otherwise a long sentence looks like a long silence.
      prev.text = merged;
      prev.endAt = lastAt;
    }
  }
  return out;
}

// A video's subtitles are short timed lines with no pause worth the name — measured
// on a 20-minute talk: the longest gap between lines 1.6 s, the median 0.16 s, and no
// punctuation at all. Breaking on a speaker's pause would make each five-minute
// section one block, so subtitle paragraphs break by video time instead: past 30 s,
// at the next gap of 0.3 s or more; past 45 s, at the next line regardless.
const SUBTITLE_PARAGRAPH_S = 30;
const SUBTITLE_PARAGRAPH_MAX_S = 45;
const SUBTITLE_BREAK_GAP_MS = 300;

/**
 * Render a session's raw cues as the note body: de-duplicated utterances packed
 * into prose paragraphs, broken where the speaker paused. A video's own subtitles
 * (`subtitles: true`) are exact already — never merged — and break by video time.
 * @param {Cue[]} cues
 * @returns {string}
 */
export function cuesToMarkdown(cues, { subtitles = false } = {}) {
  const out = [];
  let current = [];
  let prevAt = 0;
  let paragraphStart = 0; // video time the open paragraph began at
  let block = null; // which HEADING_EVERY_S block of the video we're in
  const flush = () => {
    if (current.length) out.push(joinUtterances(current));
    current = [];
  };

  let firstAt = null;
  for (const u of subtitles ? (cues || []) : dedupeCues(cues)) {
    if (firstAt === null) firstAt = Number(u.at) || 0;
    // Player position when the page exposes it; otherwise how long we've been
    // recording — the ASR path has no player to ask.
    const vt = u.videoTime == null ? NaN : Number(u.videoTime); // Number(null) is 0, not NaN
    const t = Number.isFinite(vt) ? vt : ((Number(u.at) || 0) - firstAt) / 1000;
    const b = Math.floor(t / HEADING_EVERY_S);
    if (block === null) {
      block = b; // anchor to where we started; a short session gets no heading
    } else if (b > block) {
      // Strictly greater, so scrubbing backwards never emits a lower heading and
      // re-crossing a boundary never emits it twice.
      flush();
      out.push(`## ${mmss(b * HEADING_EVERY_S)}`);
      block = b;
    }
    const gap = Number(u.at) - prevAt;
    const elapsed = t - paragraphStart;
    const breakHere = subtitles
      ? elapsed >= SUBTITLE_PARAGRAPH_MAX_S || (elapsed >= SUBTITLE_PARAGRAPH_S && gap >= SUBTITLE_BREAK_GAP_MS)
      : gap >= PARAGRAPH_GAP_MS;
    if (current.length && breakHere) flush();
    if (!current.length) paragraphStart = t;
    current.push(u.text);
    prevAt = Number(u.endAt ?? u.at) || 0;
  }
  flush();
  return out.join('\n\n');
}

// Only http(s) sources are worth recording — a file:// or extension URL is noise
// in a note that may sync to another device where the path means nothing.
function sourceLine(url) {
  try {
    const u = new URL(String(url || ''));
    return u.protocol === 'http:' || u.protocol === 'https:' ? `Source: <${u.href}>` : '';
  } catch {
    return '';
  }
}

function isoDate(ms) {
  const d = new Date(Number(ms) || 0);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : '';
}

/**
 * Turn a finished session into the note that gets saved.
 * @returns {{ title: string, body: string }}
 */
export function buildTranscriptNote({
  title = '', url = '', cues = [], startedAt = 0, endedAt = 0, subtitles = '',
} = {}) {
  // Floor, not round: a 42½-minute recording is "42 min", never "43".
  const minutes = Math.max(0, Math.floor((Number(endedAt) - Number(startedAt)) / 60000));
  // `subtitles` names the track the text came from, so a reader can tell the
  // creator's own words from speech recognition.
  const header = [sourceLine(url), isoDate(startedAt), minutes ? `${minutes} min` : '', subtitles]
    .filter(Boolean)
    .join(' · ');
  const body = [header, cuesToMarkdown(cues, { subtitles: !!subtitles })].filter(Boolean).join('\n\n');
  return { title: String(title ?? '').replace(/\s+/g, ' ').trim(), body };
}
