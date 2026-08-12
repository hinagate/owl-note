// src/lib/relative-time.js — "5 minutes ago" for recent edits, an absolute date
// once that stops being the useful answer.
//
// Within a day, how long ago you touched a note is what you actually want to know;
// past that, "31 hours ago" is arithmetic homework and the date is clearer.
//
// Intl.RelativeTimeFormat rather than hand-built strings: it handles plurals and
// localizes, which matters for a notebook whose users write in Chinese, Japanese
// and Korean — "5 分钟前" comes free, an English-only template would not.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

let cached = null;
function formatter() {
  // Built once and reused: constructing an Intl formatter is the expensive part,
  // and this runs on a timer while a note is open.
  if (!cached) cached = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  return cached;
}

// A localized "x ago" for anything under 24h, or null when the caller should show
// an absolute date instead. Null is the signal, not an error — it keeps the choice
// of absolute format with the caller that already owns one.
export function relativeTime(value, now = Date.now()) {
  const then = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(then)) return null;

  const elapsed = now - then;
  // A timestamp in the future means clock skew between two synced devices, not time
  // travel. Report it as "now" rather than counting down to it.
  if (elapsed < MINUTE) return formatter().format(0, 'second'); // "now"
  if (elapsed < HOUR) return formatter().format(-Math.floor(elapsed / MINUTE), 'minute');
  if (elapsed < DAY) return formatter().format(-Math.floor(elapsed / HOUR), 'hour');
  return null; // older than a day — the caller shows the date
}

// How long until the label above would change, so a caller can wake exactly then
// instead of polling. Minute-by-minute for the first hour, hourly after that.
export function msUntilRelativeTimeChanges(value, now = Date.now()) {
  const then = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(then)) return null;
  const elapsed = now - then;
  if (elapsed < 0) return -elapsed + MINUTE; // future stamp: recheck once it is past
  if (elapsed < HOUR) return MINUTE - (elapsed % MINUTE);
  if (elapsed < DAY) return HOUR - (elapsed % HOUR);
  return null; // absolute date from here on — nothing left to refresh
}
