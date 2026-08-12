import { describe, it, expect, vi } from 'vitest';
import { renderNoteList } from '../src/app/note-list.js';
import { renderEditor } from '../src/app/editor.js';

const trashList = (notes, onOpen) => {
  const el = document.createElement('div');
  el.id = 'note-list';
  document.body.appendChild(el);
  renderNoteList(el, { notes, trashView: true, onOpen });
  return el;
};

// A note in Trash used to render with no click handler at all: you saw a title and a
// 100-character snippet, then had to choose between Restore and Delete forever with
// no way to see the rest. These pin the reading view that replaced that.
describe('previewing a note in Trash', () => {
  it('opens the note when its card is clicked', () => {
    const onOpen = vi.fn();
    const el = trashList([{ bookmarkId: 'b1', title: 'Q3 plan', body: 'the details' }], onOpen);
    el.querySelector('.item.trashed').click();
    expect(onOpen).toHaveBeenCalledWith('b1');
  });

  it('opens from the keyboard, not just the mouse', () => {
    const onOpen = vi.fn();
    const el = trashList([{ bookmarkId: 'b1', title: 'Q3 plan', body: 'x' }], onOpen);
    const card = el.querySelector('.item.trashed');
    expect(card.getAttribute('role')).toBe('button');
    expect(card.tabIndex).toBe(0);
    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onOpen).toHaveBeenCalledWith('b1');
  });

  // Deciding to delete something forever needs to know how stale it is.
  describe('the staleness chip', () => {
    const DAY = 86_400_000;
    const withAge = (ms) => {
      const el = trashList([{ bookmarkId: 'b1', title: 'Old note', body: 'x', updated: Date.now() - ms }], () => {});
      return el.querySelector('.badge-age');
    };

    it('shows just the age, with no "Edited" prefix', () => {
      expect(withAge(3 * DAY).textContent.trim()).toBe('3 days ago');
      expect(withAge(240 * DAY).textContent.trim()).toBe('8 months ago');
    });

    it('sits in the title row like the Drive chip, not on its own line', () => {
      const el = trashList([{ bookmarkId: 'b1', title: 'Old', body: 'x', updated: Date.now() - DAY }], () => {});
      expect(el.querySelector('.card-title > .badge-age')).toBeTruthy();
      expect(el.querySelector('.card-when')).toBeNull(); // the old standalone line is gone
    });

    // The title has to be able to truncate without pushing the chip out of view.
    it('keeps the title text in its own truncating span', () => {
      const el = trashList([{ bookmarkId: 'b1', title: 'A very long title', body: 'x', updated: Date.now() - DAY }], () => {});
      expect(el.querySelector('.card-title-text').textContent).toBe('A very long title');
    });

    it('carries the exact time in a tooltip', () => {
      expect(withAge(3 * DAY).title).toContain('Last edited');
    });

    it('falls back to created, then dateAdded, for notes with no updated stamp', () => {
      const el = trashList([
        { bookmarkId: 'b1', title: 'A', body: 'x', created: Date.now() - 2 * DAY },
        { bookmarkId: 'b2', title: 'B', body: 'x', dateAdded: Date.now() - 5 * DAY },
      ], () => {});
      const chips = [...el.querySelectorAll('.badge-age')].map((n) => n.textContent.trim());
      expect(chips).toEqual(['2 days ago', '5 days ago']);
    });

    it('is omitted when the note carries no usable timestamp', () => {
      const el = trashList([{ bookmarkId: 'b1', title: 'A', body: 'x' }], () => {});
      expect(el.querySelector('.badge-age')).toBeNull();
      expect(el.querySelector('.card-title-text').textContent).toBe('A'); // title still renders
    });
  });

  it('does not open the note when Restore or Delete forever is clicked', () => {
    const onOpen = vi.fn();
    const onRestore = vi.fn();
    const onDeleteForever = vi.fn();
    const el = document.createElement('div');
    document.body.appendChild(el);
    renderNoteList(el, {
      notes: [{ bookmarkId: 'b1', title: 'Q3 plan', body: 'x' }],
      trashView: true, onOpen, onRestore, onDeleteForever,
    });
    el.querySelector('button.restore').click();
    el.querySelector('button.delete-forever').click();
    expect(onRestore).toHaveBeenCalledWith('b1');
    expect(onDeleteForever).toHaveBeenCalledWith('b1');
    expect(onOpen).not.toHaveBeenCalled(); // stopPropagation must still hold
  });
});

describe('the read-only editor', () => {
  const render = (opts = {}) => {
    const el = document.createElement('div');
    el.id = 'editor';
    document.body.appendChild(el);
    const api = renderEditor(el, { title: 'Q3 plan', body: '# Heading\n\nthe details', ...opts });
    return { el, api };
  };

  it('shows the note but strips every editing control', () => {
    const { el } = render({ readOnly: true, readOnlyNotice: 'In Trash — read only.' });
    expect(el.classList.contains('editor-readonly')).toBe(true);
    expect(el.querySelector('button.save')).toBeNull();
    expect(el.querySelector('.share-button')).toBeNull();
    expect(el.querySelector('.readonly-notice').textContent).toContain('read only');
    expect(el.querySelector('textarea.note-title').readOnly).toBe(true);
    expect(el.querySelector('.preview')).toBeTruthy(); // the note is still shown
  });

  // The important one: hiding Save is not enough, because autosave and keyboard
  // shortcuts bypass the button entirely.
  // Type into the body the way the user would, so the editor is genuinely dirty —
  // doSave ignores a clean autosave, which would make these assertions vacuous.
  const typeInto = (el, text) => {
    const ta = el.querySelector('textarea.note-body');
    ta.value = text;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  };

  it('never writes back, even when the note is dirty and autosave is forced', async () => {
    const onSave = vi.fn();
    const { el, api } = render({ readOnly: true, onSave });
    typeInto(el, 'edited somehow'); // whatever drives the textarea, nothing may persist
    await api.flush(); // the timer path — the one a hidden Save button does not cover
    await new Promise((r) => setTimeout(r, 50));
    expect(onSave).not.toHaveBeenCalled();
  });

  // Proves the assertion above can actually fail: identical steps on a normal note save.
  it('an editable note does save through that same path', async () => {
    const onSave = vi.fn();
    const { el, api } = render({ onSave });
    typeInto(el, 'edited somehow');
    await api.flush();
    expect(onSave).toHaveBeenCalled();
  });

  it('leaves a normal note fully editable', () => {
    const { el } = render();
    expect(el.classList.contains('editor-readonly')).toBe(false);
    expect(el.querySelector('button.save')).toBeTruthy();
    expect(el.querySelector('textarea.note-title').readOnly).toBe(false);
    expect(el.querySelector('.readonly-notice')).toBeNull();
  });

  // Regression: renderEditor clears the container's CHILDREN but not its classes, and
  // #editor is reused for every note. Adding editor-readonly instead of toggling it
  // left the next note stuck in the collapsed reading layout with a squashed toolbar.
  it('returns to full editing when the same container renders a normal note next', () => {
    const el = document.createElement('div');
    el.id = 'editor';
    document.body.appendChild(el);

    renderEditor(el, { title: 'Trashed', body: 'x', readOnly: true, readOnlyNotice: 'In Trash' });
    expect(el.classList.contains('editor-readonly')).toBe(true);

    renderEditor(el, { title: 'Live note', body: 'y' }); // same container, as the app does
    expect(el.classList.contains('editor-readonly')).toBe(false);
    expect(el.querySelector('button.save')).toBeTruthy();
    expect(el.querySelector('.readonly-notice')).toBeNull();
    expect(el.querySelector('textarea.note-title').readOnly).toBe(false);
    expect(el.querySelector('textarea.note-body').hidden).toBe(false);
  });
});
