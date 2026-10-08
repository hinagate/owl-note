import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderEditor } from '../src/app/editor.js';
import * as panes from '../src/app/panes.js';

// Reading mode (the « / » button) hides the editor. Typing, pasting or dropping a file
// into the reading view used to go nowhere without a word; now a hint points back at «.

let editor;
beforeEach(() => {
  document.body.innerHTML = '<section id="note-list"><div class="item card" tabindex="0">Plan</div></section><main id="editor"></main><input class="elsewhere">';
});
afterEach(() => {
  editor?.destroy();
  editor = null;
  if (panes.isEditCollapsed()) panes.toggleEditPane(); // the layout is app-wide
});

const open = (opts = {}) => {
  editor = renderEditor(document.getElementById('editor'), { body: '# Plan\n\nSome text', onSave: vi.fn(), ...opts });
  return editor;
};
const hint = () => document.querySelector('.edit-hidden-hint');
const toggle = () => document.querySelector('.toggle-edit');
const readingMode = () => toggle().click();
const press = (el) => el.dispatchEvent(new Event('pointerdown', { bubbles: true }));
const key = (target, k, init = {}) => {
  const event = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
};
const paragraph = () => document.querySelector('.preview-content p');

describe('the hint that the editor is hidden', () => {
  it('appears when the reader types after clicking into the reading view', () => {
    open();
    readingMode();
    expect(hint().hidden).toBe(true);
    press(paragraph());
    const typed = key(document.body, 'h');
    expect(hint().hidden).toBe(false);
    expect(hint().textContent).toContain('Reading mode hides the editor.');
    expect(toggle().classList.contains('attention')).toBe(true); // the « button pulses
    expect(typed.defaultPrevented).toBe(false); // the key itself is left alone
  });

  it('appears for a key aimed straight at the preview, and for Enter and Backspace there', () => {
    open();
    readingMode();
    key(paragraph(), 'Enter');
    expect(hint().hidden).toBe(false);
  });

  it('appears when the reader pastes', () => {
    open();
    readingMode();
    press(paragraph());
    document.body.dispatchEvent(new Event('paste', { bubbles: true }));
    expect(hint().hidden).toBe(false);
  });

  it('appears for a character typed right after opening a note from the list', () => {
    open();
    readingMode();
    const card = document.querySelector('#note-list .card');
    key(card, 'Backspace'); // deletes selected notes there: not typing
    expect(hint().hidden).toBe(true);
    key(card, 'x');
    expect(hint().hidden).toBe(false);
  });

  it('brings the editor back and puts the cursor in the note', () => {
    open();
    readingMode();
    key(paragraph(), 'a');
    hint().querySelector('.edit-hidden-hint-show').click();
    expect(panes.isEditCollapsed()).toBe(false);
    expect(document.activeElement).toBe(document.querySelector('textarea.note-body'));
    expect(hint().hidden).toBe(true);
    expect(toggle().classList.contains('attention')).toBe(false);
  });

  it('goes away on Escape, when the editor is shown, and after a few seconds', () => {
    vi.useFakeTimers();
    try {
      open();
      readingMode();
      key(paragraph(), 'a');
      key(document.body, 'Escape');
      expect(hint().hidden).toBe(true);
      key(paragraph(), 'a');
      toggle().click(); // « shows the editor
      expect(hint().hidden).toBe(true);
      toggle().click(); // back to reading
      key(paragraph(), 'a');
      vi.advanceTimersByTime(6000);
      expect(hint().hidden).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  const dragFile = (target, type = 'dragover') => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    event.dataTransfer = { types: ['Files'], dropEffect: 'copy' };
    target.dispatchEvent(event);
    return event;
  };

  it('refuses a file dragged over the reading view, and says why while it is dragged', () => {
    open();
    readingMode();
    // Chrome never delivers the drop once it is refused, so the hint cannot wait for it.
    const over = dragFile(document.querySelector('.preview'));
    expect(over.defaultPrevented).toBe(true); // no new tab with the file in it
    expect(over.dataTransfer.dropEffect).toBe('none');
    expect(hint().hidden).toBe(false);
    expect(dragFile(document.querySelector('.preview'), 'drop').defaultPrevented).toBe(true);
    expect(dragFile(hint()).defaultPrevented).toBe(true); // the hint itself is covered too
  });

  it('appears for keys typed right after starting a new note, which rebuilds the editor', () => {
    open();
    readingMode();
    press(document.querySelector('#note-list .card')); // "+ New note" sits in the list
    editor.destroy();
    open({ body: '' });
    key(document.body, 'm');
    expect(hint().hidden).toBe(false);
  });

  it('appears for a character typed while a control in the editor has focus', () => {
    open();
    readingMode();
    key(toggle(), 'h'); // focus stays on « after clicking it
    expect(hint().hidden).toBe(false);
  });

  it('leaves Enter to the control that has focus', () => {
    open();
    readingMode();
    key(toggle(), 'Enter');
    key(document.querySelector('#note-list .card'), 'Enter');
    expect(hint().hidden).toBe(true);
  });

  it('counts characters typed with AltGr', () => {
    open();
    readingMode();
    const altGr = new KeyboardEvent('keydown', { key: '@', ctrlKey: true, altKey: true, bubbles: true, cancelable: true });
    Object.defineProperty(altGr, 'getModifierState', { value: (name) => name === 'AltGraph' });
    paragraph().dispatchEvent(altGr);
    expect(hint().hidden).toBe(false);
  });

  it('stays while the reader is reaching for its button', () => {
    vi.useFakeTimers();
    try {
      open();
      readingMode();
      key(paragraph(), 'a');
      const button = hint().querySelector('.edit-hidden-hint-show');
      button.focus();
      vi.advanceTimersByTime(10000);
      expect(hint().hidden).toBe(false);
      button.blur();
      vi.advanceTimersByTime(6000);
      expect(hint().hidden).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a photo dragged within the reading view, which also lists Files', () => {
    open();
    readingMode();
    const preview = document.querySelector('.preview');
    paragraph().dispatchEvent(new Event('dragstart', { bubbles: true }));
    expect(dragFile(preview).defaultPrevented).toBe(false);
    expect(hint().hidden).toBe(true);
    paragraph().dispatchEvent(new Event('dragend', { bubbles: true }));
    dragFile(preview); // a file from outside again
    expect(hint().hidden).toBe(false);
  });

  it('still goes away when it appears under a pointer that is not moving', () => {
    vi.useFakeTimers();
    try {
      open();
      readingMode();
      key(paragraph(), 'a');
      hint().dispatchEvent(new Event('pointerenter')); // it appeared under the pointer
      vi.advanceTimersByTime(6000);
      expect(hint().hidden).toBe(true);
      key(paragraph(), 'a');
      hint().dispatchEvent(new Event('pointermove')); // the reader moves onto it
      vi.advanceTimersByTime(10000);
      expect(hint().hidden).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('forgets a click into the note once focus has moved elsewhere by keyboard', () => {
    open();
    readingMode();
    press(paragraph());
    const input = document.querySelector('.elsewhere');
    input.focus(); // e.g. tabbing to the toolbar
    input.blur(); // and focus falls back to the page
    key(document.body, 'x');
    expect(hint().hidden).toBe(true);
  });

  it('counts characters typed with Option on a Mac, and only there', () => {
    const platform = Object.getOwnPropertyDescriptor(Navigator.prototype, 'platform');
    const typeAt = () => paragraph().dispatchEvent(new KeyboardEvent('keydown', { key: '€', altKey: true, bubbles: true, cancelable: true }));
    try {
      open();
      readingMode();
      Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true });
      typeAt(); // Alt+key on Windows is a shortcut
      expect(hint().hidden).toBe(true);
      Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
      typeAt();
      expect(hint().hidden).toBe(false);
    } finally {
      delete navigator.platform;
      if (platform) Object.defineProperty(Navigator.prototype, 'platform', platform);
    }
  });

  it('re-places the arrow on every show, as the bar can wrap while it is up', () => {
    open();
    readingMode();
    const rect = (r) => () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, ...r });
    toggle().getBoundingClientRect = rect({ left: 314, width: 32, top: 70, bottom: 99 });
    const split = document.querySelector('.editor-split');
    split.getBoundingClientRect = rect({ left: 300, top: 100 });
    key(paragraph(), 'a');
    expect(hint().classList.contains('no-arrow')).toBe(false);
    split.getBoundingClientRect = rect({ left: 300, top: 190 }); // the window narrowed
    key(paragraph(), 'b'); // still showing
    expect(hint().classList.contains('no-arrow')).toBe(true);
  });

  it('points at « only when it sits right above the reading view', () => {
    open();
    readingMode();
    const rect = (r) => () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, ...r });
    toggle().getBoundingClientRect = rect({ left: 314, width: 32, top: 70, bottom: 99 });
    const split = document.querySelector('.editor-split');
    split.getBoundingClientRect = rect({ left: 300, top: 100 });
    key(paragraph(), 'a');
    expect(hint().classList.contains('no-arrow')).toBe(false);
    expect(hint().style.left).toBe('12px'); // the arrow's tip under the middle of «
    key(document.body, 'Escape');
    split.getBoundingClientRect = rect({ left: 300, top: 190 }); // the bar wrapped onto more rows
    key(paragraph(), 'a');
    expect(hint().classList.contains('no-arrow')).toBe(true);
  });

  describe('stays out of the way', () => {
    it('while the editor is showing', () => {
      open();
      press(paragraph());
      key(document.body, 'h');
      document.body.dispatchEvent(new Event('paste', { bubbles: true }));
      expect(hint().hidden).toBe(true);
    });

    it('for reading keys and shortcuts', () => {
      open();
      readingMode();
      press(paragraph());
      for (const k of [' ', 'ArrowDown', 'PageDown', 'Home', 'Tab', 'Shift']) key(document.body, k);
      key(document.body, 'c', { ctrlKey: true }); // copy
      key(document.body, 'f', { metaKey: true });
      expect(hint().hidden).toBe(true);
    });

    it('when the reader is typing somewhere else', () => {
      open();
      readingMode();
      const input = document.querySelector('.elsewhere');
      key(input, 'h');
      input.dispatchEvent(new Event('paste', { bubbles: true }));
      press(input); // a click outside the editor, then keys on the page
      key(document.body, 'h');
      expect(hint().hidden).toBe(true);
    });

    it('for a note that cannot be edited anyway', () => {
      panes.toggleEditPane(); // reading mode left on from another note
      open({ readOnly: true, readOnlyNotice: 'In Trash — read only.' });
      key(paragraph(), 'h');
      expect(hint().hidden).toBe(true);
    });

    it('once the editor is gone', () => {
      open();
      readingMode();
      const shown = hint();
      editor.destroy();
      key(document.body, 'h');
      expect(shown.hidden).toBe(true);
    });
  });
});
