// Turns the raw cue stream from a capture session into a note body. A session
// stores raw cues and derives markdown from them, so recovering an interrupted
// capture is an exact replay. Pure module — no imports, no DOM/chrome APIs.

/**
 * @typedef {{ text: string, videoTime: number|null, at: number }} Cue
 */

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

/**
 * Render a session's raw cues as the note body: de-duplicated utterances packed
 * into prose paragraphs, broken where the speaker paused.
 * @param {Cue[]} cues
 * @returns {string}
 */
export function cuesToMarkdown(cues) {
  const out = [];
  let current = [];
  let prevAt = 0;
  let block = null; // which HEADING_EVERY_S block of the video we're in
  const flush = () => {
    if (current.length) out.push(current.join(' '));
    current = [];
  };

  let firstAt = null;
  for (const u of dedupeCues(cues)) {
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
    if (current.length && Number(u.at) - prevAt >= PARAGRAPH_GAP_MS) flush();
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
export function buildTranscriptNote({ title = '', url = '', cues = [], startedAt = 0, endedAt = 0 } = {}) {
  // Floor, not round: a 42½-minute recording is "42 min", never "43".
  const minutes = Math.max(0, Math.floor((Number(endedAt) - Number(startedAt)) / 60000));
  const header = [sourceLine(url), isoDate(startedAt), minutes ? `${minutes} min` : '']
    .filter(Boolean)
    .join(' · ');
  const body = [header, cuesToMarkdown(cues)].filter(Boolean).join('\n\n');
  return { title: String(title ?? '').replace(/\s+/g, ' ').trim(), body };
}
