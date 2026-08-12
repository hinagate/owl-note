import { describe, it, expect } from 'vitest';
import { relativeTime, DAY } from '../src/lib/relative-time.js';

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

  // The Trash list asks a different question — how stale is this — so it keeps going.
  describe("with maxUnit: 'year', for the Trash list", () => {
    const opts = { maxUnit: 'year' };

    it('still uses minutes and hours for recent notes', () => {
      expect(relativeTime(ago(5 * MINUTE), NOW, opts)).toBe('5 minutes ago');
      expect(relativeTime(ago(7 * HOUR), NOW, opts)).toBe('7 hours ago');
    });

    it('counts days, and calls a single one "yesterday"', () => {
      expect(relativeTime(ago(DAY), NOW, opts)).toBe('yesterday');
      expect(relativeTime(ago(3 * DAY), NOW, opts)).toBe('3 days ago');
      expect(relativeTime(ago(29 * DAY), NOW, opts)).toBe('29 days ago');
    });

    it('rolls up to months, then years', () => {
      expect(relativeTime(ago(30 * DAY), NOW, opts)).toBe('last month');
      expect(relativeTime(ago(8 * 30 * DAY), NOW, opts)).toBe('8 months ago');
      expect(relativeTime(ago(365 * DAY), NOW, opts)).toBe('last year');
      expect(relativeTime(ago(3 * 365 * DAY), NOW, opts)).toBe('3 years ago');
    });

    it('never returns null, so a card always has something to show', () => {
      for (const age of [0, MINUTE, HOUR, DAY, 45 * DAY, 500 * DAY, 5000 * DAY]) {
        expect(relativeTime(ago(age), NOW, opts)).toBeTruthy();
      }
    });
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
