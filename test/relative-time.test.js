import { describe, it, expect } from 'vitest';
import { relativeTime, msUntilRelativeTimeChanges, DAY } from '../src/lib/relative-time.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.parse('2026-08-11T12:00:00Z');
const ago = (ms) => NOW - ms;

describe('relativeTime', () => {
  it('reads as "now" for the last minute', () => {
    expect(relativeTime(ago(0), NOW)).toBe('now');
    expect(relativeTime(ago(59_000), NOW)).toBe('now');
  });

  it('counts minutes for the first hour', () => {
    expect(relativeTime(ago(MINUTE), NOW)).toBe('1 minute ago');
    expect(relativeTime(ago(5 * MINUTE), NOW)).toBe('5 minutes ago');
    expect(relativeTime(ago(59 * MINUTE), NOW)).toBe('59 minutes ago');
  });

  it('counts hours up to a day', () => {
    expect(relativeTime(ago(HOUR), NOW)).toBe('1 hour ago');
    expect(relativeTime(ago(5 * HOUR), NOW)).toBe('5 hours ago');
    expect(relativeTime(ago(23 * HOUR), NOW)).toBe('23 hours ago');
  });

  it('rounds down rather than up, so a label never overstates the age', () => {
    expect(relativeTime(ago(2 * MINUTE + 59_000), NOW)).toBe('2 minutes ago');
    expect(relativeTime(ago(3 * HOUR + 59 * MINUTE), NOW)).toBe('3 hours ago');
  });

  // Past 24h the caller shows an absolute date; null is how it is told to.
  it('returns null once the note is a day old', () => {
    expect(relativeTime(ago(DAY), NOW)).toBeNull();
    expect(relativeTime(ago(DAY + HOUR), NOW)).toBeNull();
    expect(relativeTime(ago(400 * DAY), NOW)).toBeNull();
  });

  it('holds the boundaries exactly', () => {
    expect(relativeTime(ago(HOUR - 1), NOW)).toBe('59 minutes ago');
    expect(relativeTime(ago(DAY - 1), NOW)).toBe('23 hours ago');
  });

  // Two synced devices with skewed clocks can stamp a note slightly in the future.
  it('treats a future timestamp as now, never counting down to it', () => {
    expect(relativeTime(NOW + 5 * MINUTE, NOW)).toBe('now');
  });

  it('accepts a Date as well as a number, and rejects junk', () => {
    expect(relativeTime(new Date(ago(5 * MINUTE)), NOW)).toBe('5 minutes ago');
    expect(relativeTime(null, NOW)).toBeNull();
    expect(relativeTime('not a date', NOW)).toBeNull();
    expect(relativeTime(NaN, NOW)).toBeNull();
  });
});

describe('msUntilRelativeTimeChanges', () => {
  it('wakes on the next minute boundary within the first hour', () => {
    expect(msUntilRelativeTimeChanges(ago(0), NOW)).toBe(MINUTE);
    expect(msUntilRelativeTimeChanges(ago(90_000), NOW)).toBe(30_000); // 1m30s in -> 30s to "2 minutes"
  });

  it('wakes on the next hour boundary after that', () => {
    expect(msUntilRelativeTimeChanges(ago(HOUR), NOW)).toBe(HOUR);
    expect(msUntilRelativeTimeChanges(ago(HOUR + 20 * MINUTE), NOW)).toBe(40 * MINUTE);
  });

  // Once it is an absolute date there is nothing left to tick, so no timer is armed.
  it('stops scheduling once the label is a fixed date', () => {
    expect(msUntilRelativeTimeChanges(ago(DAY), NOW)).toBeNull();
    expect(msUntilRelativeTimeChanges(ago(30 * DAY), NOW)).toBeNull();
  });

  it('never returns zero or negative, which would spin a timer', () => {
    for (const offset of [0, 1, 999, MINUTE, HOUR - 1, HOUR, DAY - 1]) {
      const wait = msUntilRelativeTimeChanges(ago(offset), NOW);
      if (wait !== null) expect(wait).toBeGreaterThan(0);
    }
  });

  it('rejects junk the same way', () => {
    expect(msUntilRelativeTimeChanges(null, NOW)).toBeNull();
    expect(msUntilRelativeTimeChanges('nope', NOW)).toBeNull();
  });
});
