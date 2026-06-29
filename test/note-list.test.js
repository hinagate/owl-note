import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderNoteList } from '../src/app/note-list.js';

beforeEach(() => { document.body.innerHTML = '<section id="note-list"></section>'; });

describe('note list', () => {
  it('renders rows and fires onOpen', () => {
    const onOpen = vi.fn();
    const el = document.getElementById('note-list');
    renderNoteList(el, {
      notes: [{ bookmarkId: 'b1', title: 'One' }, { bookmarkId: 'b2', title: 'Two' }],
      activeHandle: 'b1', onOpen,
    });
    const rows = el.querySelectorAll('.item');
    expect(rows).toHaveLength(2);
    rows[1].click();
    expect(onOpen).toHaveBeenCalledWith('b2');
    expect(rows[0].classList.contains('active')).toBe(true);
    expect(rows[1].classList.contains('active')).toBe(false);
  });

  it('shows empty state', () => {
    const el = document.getElementById('note-list');
    renderNoteList(el, { notes: [], activeHandle: null, onOpen: vi.fn() });
    expect(el.textContent).toContain('No notes');
  });

  it('renders a snippet from the note body when present', () => {
    const el = document.getElementById('note-list');
    renderNoteList(el, {
      notes: [{ bookmarkId: 'b1', title: 'T', body: '# T\nsome body text here' }],
      activeHandle: null, onOpen: vi.fn(),
    });
    expect(el.querySelector('.card-snippet').textContent).toContain('some body text');
  });

  it('marks a draft entry with the draft class and shows its name', () => {
    const el = document.getElementById('note-list');
    renderNoteList(el, {
      notes: [{ bookmarkId: '__draft__', title: 'New note', draft: true }],
      activeHandle: '__draft__', onOpen: vi.fn(),
    });
    const item = el.querySelector('.item');
    expect(item.classList.contains('draft')).toBe(true);
    expect(item.classList.contains('active')).toBe(true);
    expect(item.textContent).toContain('New note');
  });

  it('makes real note cards draggable but not the draft entry', () => {
    const el = document.getElementById('note-list');
    renderNoteList(el, {
      notes: [
        { bookmarkId: 'b1', title: 'Real' },
        { bookmarkId: '__draft__', title: 'New note', draft: true },
      ],
      activeHandle: null, onOpen: vi.fn(),
    });
    const cards = el.querySelectorAll('.item');
    expect(cards[0].draggable).toBe(true);
    expect(cards[1].draggable).toBe(false);
  });
});

describe('renderNoteList local-only notes', () => {
  it('renders a local badge and opens local-only notes by id', () => {
    const c = document.createElement('div');
    let opened = null;
    renderNoteList(c, {
      notes: [{ id: 'L1', bookmarkId: null, localOnly: true, title: 'Local', body: 'b' }],
      activeHandle: null,
      onOpen: (h) => { opened = h; },
    });
    expect(c.querySelector('.badge-local')).toBeTruthy();
    c.querySelector('.card').click();
    expect(opened).toBe('L1');
  });

  it('opens a normal note by bookmarkId and shows no badge', () => {
    const c = document.createElement('div');
    let opened = null;
    renderNoteList(c, {
      notes: [{ id: 'N1', bookmarkId: 'bm9', title: 'Synced', body: 'b' }],
      activeHandle: 'bm9',
      onOpen: (h) => { opened = h; },
    });
    expect(c.querySelector('.badge-local')).toBeNull();
    expect(c.querySelector('.card.active')).toBeTruthy();
    c.querySelector('.card').click();
    expect(opened).toBe('bm9');
  });
});

describe('renderNoteList pin button', () => {
  function container() { return document.createElement('div'); }

  it('renders a pin button per non-draft card and toggles via onTogglePin (not onOpen)', () => {
    const c = container();
    let opened = null; let toggled = null;
    renderNoteList(c, {
      notes: [{ id: 'N1', bookmarkId: 'bm1', title: 'A', body: 'b' }],
      activeHandle: null,
      onOpen: (h) => { opened = h; },
      onTogglePin: (h) => { toggled = h; },
    });
    const pin = c.querySelector('.pin');
    expect(pin).not.toBeNull();
    expect(pin.classList.contains('pinned')).toBe(false);
    pin.click();
    expect(toggled).toBe('bm1');
    expect(opened).toBeNull(); // stopPropagation — clicking the pin must not open the note
  });

  it('marks a pinned note with the pinned class', () => {
    const c = container();
    renderNoteList(c, { notes: [{ id: 'N1', bookmarkId: 'bm1', title: 'A', body: 'b', pinned: true }], activeHandle: null, onOpen: () => {} });
    expect(c.querySelector('.pin.pinned')).not.toBeNull();
  });

  it('does not render a pin button on a draft card', () => {
    const c = container();
    renderNoteList(c, { notes: [{ bookmarkId: '__draft__', title: 'New', body: '', draft: true }], activeHandle: '__draft__', onOpen: () => {} });
    expect(c.querySelector('.pin')).toBeNull();
  });
});

describe('renderNoteList new-note button', () => {
  it('renders a + New note button first and calls onNew when clicked', () => {
    const c = document.createElement('div');
    const onNew = vi.fn();
    renderNoteList(c, { notes: [{ id: 'N1', bookmarkId: 'b1', title: 'A', body: 'x' }], activeHandle: null, onOpen: vi.fn(), onNew });
    const btn = c.querySelector('button.new');
    expect(btn).not.toBeNull();
    expect(c.firstChild).toBe(btn);            // it is the FIRST child (top of the list)
    expect(btn.textContent).toContain('New note');
    btn.click();
    expect(onNew).toHaveBeenCalled();
  });
  it('shows the + New note button even when there are no notes', () => {
    const c = document.createElement('div');
    renderNoteList(c, { notes: [], activeHandle: null, onOpen: vi.fn(), onNew: vi.fn() });
    expect(c.querySelector('button.new')).not.toBeNull();
    expect(c.querySelector('.empty')).not.toBeNull();
  });
});
