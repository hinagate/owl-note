import { describe, it, expect } from 'vitest';
import { renderNoteList } from '../src/app/note-list.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;

// The same fact is presented two ways on purpose: a live card has room for a line
// under the snippet, while a trashed card puts it in a title chip so it reads at a
// glance next to Restore / Delete forever.
const render = (notes, opts = {}) => {
  const el = document.createElement('div');
  el.id = 'note-list';
  document.body.appendChild(el);
  renderNoteList(el, { notes, ...opts });
  return el;
};

describe('last-edited on a live note card', () => {
  it('shows a line under the snippet', () => {
    const el = render([{ bookmarkId: 'b1', title: 'A', body: 'text', updated: Date.now() - 2 * HOUR }]);
    expect(el.querySelector('.card-when').textContent).toBe('Edited 2 hours ago');
  });

  it('keeps counting past a day, all the way to years', () => {
    const el = render([
      { bookmarkId: 'b1', title: 'A', body: 'x', updated: Date.now() - 4 * DAY },
      { bookmarkId: 'b2', title: 'B', body: 'x', updated: Date.now() - 240 * DAY },
      { bookmarkId: 'b3', title: 'C', body: 'x', updated: Date.now() - 800 * DAY },
    ]);
    expect([...el.querySelectorAll('.card-when')].map((n) => n.textContent))
      .toEqual(['Edited 4 days ago', 'Edited 8 months ago', 'Edited 2 years ago']);
  });

  it('uses a line, not the chip the Trash list uses', () => {
    const el = render([{ bookmarkId: 'b1', title: 'A', body: 'x', updated: Date.now() - DAY }]);
    expect(el.querySelector('.card-when')).toBeTruthy();
    expect(el.querySelector('.badge-age')).toBeNull();
  });

  it('carries the exact time in a tooltip', () => {
    const el = render([{ bookmarkId: 'b1', title: 'A', body: 'x', updated: Date.now() - DAY }]);
    expect(el.querySelector('.card-when').title).toContain('Last edited');
  });

  it('falls back to created, then dateAdded', () => {
    const el = render([
      { bookmarkId: 'b1', title: 'A', body: 'x', created: Date.now() - 2 * DAY },
      { bookmarkId: 'b2', title: 'B', body: 'x', dateAdded: Date.now() - 5 * DAY },
    ]);
    expect([...el.querySelectorAll('.card-when')].map((n) => n.textContent))
      .toEqual(['Edited 2 days ago', 'Edited 5 days ago']);
  });

  it('is omitted when the note has no usable timestamp', () => {
    const el = render([{ bookmarkId: 'b1', title: 'A', body: 'x' }]);
    expect(el.querySelector('.card-when')).toBeNull();
  });

  // The unsaved draft row has never been written, so it has no edit time to report.
  it('is omitted for the unsaved draft row', () => {
    const el = render([{ bookmarkId: '__draft__', title: 'New note', body: 'typing', draft: true }]);
    expect(el.querySelector('.card-when')).toBeNull();
  });
});
