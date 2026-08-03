import { describe, it, expect, beforeEach, vi } from 'vitest';
vi.mock('../src/lib/image-downscale.js', () => ({
  imageFileToDataUri: vi.fn(async () => 'data:image/webp;base64,AAAA'),
}));
let mockPanesState = { noteListHidden: false, editCollapsed: false };
vi.mock('../src/app/panes.js', () => ({
  isNoteListHidden: vi.fn(() => mockPanesState.noteListHidden),
  isEditCollapsed: vi.fn(() => mockPanesState.editCollapsed),
  toggleNoteList: vi.fn(() => { mockPanesState.noteListHidden = !mockPanesState.noteListHidden; }),
  toggleEditPane: vi.fn(() => { mockPanesState.editCollapsed = !mockPanesState.editCollapsed; }),
  initEditSplitter: vi.fn(),
}));

import { renderEditor } from '../src/app/editor.js';

beforeEach(() => {
  document.body.innerHTML = '<main id="editor"></main>';
  mockPanesState = { noteListHidden: false, editCollapsed: false };
});

function render(extra = {}) {
  const c = document.getElementById('editor');
  return renderEditor(c, { title: 'T', body: 'hello world', onSave: () => {}, ...extra });
}

const mousedown = () => new MouseEvent('mousedown', { cancelable: true, bubbles: true });

describe('format bar in the editor', () => {
  it('renders between the title row and the body', () => {
    render();
    const kids = [...document.querySelector('.edit-pane').children];
    const idx = (sel) => kids.findIndex((k) => k.matches(sel));
    expect(idx('.format-bar')).toBeGreaterThan(idx('.title-row'));
    expect(idx('.format-bar')).toBeLessThan(idx('.note-body-wrap'));
  });

  it('Bold button wraps the selection, updates the preview, keeps it selected', () => {
    render();
    const ta = document.querySelector('textarea.note-body');
    ta.setSelectionRange(0, 5);
    document.querySelector('.format-bold').dispatchEvent(mousedown());
    expect(ta.value).toBe('**hello** world');
    expect(document.querySelector('.preview-body').innerHTML).toContain('<strong>hello</strong>');
    expect([ta.selectionStart, ta.selectionEnd]).toEqual([2, 7]);
  });

  it('Highlight wraps in <mark> and it survives into the preview', () => {
    render();
    const ta = document.querySelector('textarea.note-body');
    ta.setSelectionRange(0, 5);
    document.querySelector('.format-highlight').dispatchEvent(mousedown());
    expect(ta.value).toBe('<mark>hello</mark> world');
    expect(document.querySelector('.preview-body').innerHTML).toContain('<mark>hello</mark>');
  });

  it('Ctrl+B applies bold from the keyboard and eats the event', () => {
    render();
    const ta = document.querySelector('textarea.note-body');
    ta.setSelectionRange(0, 5);
    const ev = new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, cancelable: true, bubbles: true });
    const prevented = !ta.dispatchEvent(ev);
    expect(prevented).toBe(true);
    expect(ta.value).toBe('**hello** world');
  });

  it('Ctrl+Shift+B is left alone (only bare Ctrl/Cmd combos)', () => {
    render();
    const ta = document.querySelector('textarea.note-body');
    ta.setSelectionRange(0, 5);
    const ev = new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, shiftKey: true, cancelable: true, bubbles: true });
    ta.dispatchEvent(ev);
    expect(ta.value).toBe('hello world'); // unchanged
  });

  it('ignores Ctrl+B during IME composition (isComposing)', () => {
    render();
    const ta = document.querySelector('textarea.note-body');
    ta.setSelectionRange(0, 5);
    const ev = new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, cancelable: true, bubbles: true });
    Object.defineProperty(ev, 'isComposing', { value: true });
    ta.dispatchEvent(ev);
    expect(ta.value).toBe('hello world'); // unchanged — composition must never be clobbered
  });

  it('numbered-list button skips the heading line', () => {
    render({ body: '## T\nx' });
    const ta = document.querySelector('textarea.note-body');
    ta.setSelectionRange(0, 6);
    document.querySelector('.format-ordered-list').dispatchEvent(mousedown());
    expect(ta.value).toBe('## T\n1. x');
  });

  it('list button on only a heading line does nothing and does not throw', () => {
    render({ body: '## T' });
    const ta = document.querySelector('textarea.note-body');
    ta.setSelectionRange(0, 4);
    document.querySelector('.format-bullet-list').dispatchEvent(mousedown());
    expect(ta.value).toBe('## T');
  });
});

describe('Enter inside a table', () => {
  const TABLE = '| Step | Sketch |\n| --- | --- |\n| walk | sketch |';

  function pressEnter(ta, caret) {
    ta.selectionStart = ta.selectionEnd = caret;
    const ev = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true, bubbles: true });
    const prevented = !ta.dispatchEvent(ev);
    return prevented;
  }

  it('adds a matching empty row and consumes the keypress', () => {
    render({ body: TABLE });
    const ta = document.querySelector('.note-body');
    expect(pressEnter(ta, TABLE.length)).toBe(true); // preventDefault -> no stray newline
    expect(ta.value.split('\n')[3]).toBe('|  |  |');
  });

  it('leaves Enter alone outside a table', () => {
    render({ body: 'plain prose' });
    const ta = document.querySelector('.note-body');
    expect(pressEnter(ta, 5)).toBe(false); // not prevented -> the textarea inserts its own newline
    expect(ta.value).toBe('plain prose');
  });

  it('does not hijack Shift+Enter', () => {
    render({ body: TABLE });
    const ta = document.querySelector('.note-body');
    ta.selectionStart = ta.selectionEnd = TABLE.length;
    const ev = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, cancelable: true, bubbles: true });
    expect(!ta.dispatchEvent(ev)).toBe(false);
    expect(ta.value).toBe(TABLE);
  });

  it('walks out of the table when Enter lands on an empty row', () => {
    const body = `${TABLE}\n|  |  |`;
    render({ body });
    const ta = document.querySelector('.note-body');
    pressEnter(ta, body.length - 3);
    expect(ta.value).toBe(`${TABLE}\n`);
  });
});

describe('Alt+Enter inside a table cell', () => {
  const TABLE = '| Symbol | Mouth |\n| --- | --- |\n| ɔi | boy |';

  function pressAltEnter(ta, start, end = start) {
    ta.setSelectionRange(start, end);
    const ev = new KeyboardEvent('keydown', { key: 'Enter', altKey: true, cancelable: true, bubbles: true });
    return !ta.dispatchEvent(ev);
  }

  it('inserts <br> in the source and renders another line in the same cell', () => {
    render({ body: TABLE });
    const ta = document.querySelector('.note-body');
    const caret = TABLE.indexOf('boy') + 3;
    expect(pressAltEnter(ta, caret)).toBe(true);
    expect(ta.value).toContain('| ɔi | boy<br> |');
    expect(document.querySelector('.preview-body td:last-child').innerHTML).toBe('boy<br>');
    expect(ta.selectionStart).toBe(caret + 4);
  });

  it('does not consume Alt+Enter outside a table', () => {
    render({ body: 'plain prose' });
    const ta = document.querySelector('.note-body');
    expect(pressAltEnter(ta, 5)).toBe(false);
    expect(ta.value).toBe('plain prose');
  });
});

describe('Tab between table cells', () => {
  const TABLE = '| one | two |\n| --- | --- |\n| aa | bb |';

  function pressTab(ta, caret, shift = false) {
    ta.selectionStart = ta.selectionEnd = caret;
    const ev = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, cancelable: true, bubbles: true });
    return !ta.dispatchEvent(ev); // true when prevented
  }

  it('selects the next cell and consumes the keypress', () => {
    render({ body: TABLE });
    const ta = document.querySelector('.note-body');
    expect(pressTab(ta, TABLE.indexOf('one'))).toBe(true);
    expect(ta.value.slice(ta.selectionStart, ta.selectionEnd)).toBe('two');
  });

  it('Shift+Tab selects the previous cell', () => {
    render({ body: TABLE });
    const ta = document.querySelector('.note-body');
    pressTab(ta, TABLE.indexOf('two'), true);
    expect(ta.value.slice(ta.selectionStart, ta.selectionEnd)).toBe('one');
  });

  it('opens a new row when tabbing past the last cell', () => {
    render({ body: TABLE });
    const ta = document.querySelector('.note-body');
    pressTab(ta, TABLE.indexOf('bb'));
    expect(ta.value).toBe(`${TABLE}\n|  |  |`);
  });

  // Tab must stay escapable: outside a table, and on Shift+Tab in the first
  // cell, the keypress is NOT consumed so focus can leave the textarea.
  it('does not consume Tab outside a table', () => {
    render({ body: 'plain prose' });
    const ta = document.querySelector('.note-body');
    expect(pressTab(ta, 3)).toBe(false);
  });

  it('does not consume Shift+Tab in the very first cell', () => {
    render({ body: TABLE });
    const ta = document.querySelector('.note-body');
    expect(pressTab(ta, TABLE.indexOf('one'), true)).toBe(false);
  });
});

describe('typing a new header cell widens the rows below', () => {
  // The reported case: the user types a third header cell and the rows below
  // must gain their empty cells in the NOTE TEXT, with no button press.
  const TYPED = '| title 1 | title 2 | xxx|\n| --- | --- |\n|  |  |\n|  |  ';

  it('fills the rows out on the input event', () => {
    render({ body: '' });
    const ta = document.querySelector('.note-body');
    ta.value = TYPED;
    ta.selectionStart = ta.selectionEnd = TYPED.indexOf('xxx') + 3;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    expect(ta.value.split('\n')).toEqual([
      '| title 1 | title 2 | xxx |',
      '| --- | --- | --- |',
      '|  |  |  |',
      '|  |  |  |',
    ]);
  });

  it('keeps the caret where the user was typing', () => {
    render({ body: '' });
    const ta = document.querySelector('.note-body');
    ta.value = TYPED;
    ta.selectionStart = ta.selectionEnd = TYPED.indexOf('xxx') + 3;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    expect(ta.value.slice(0, ta.selectionStart)).toBe('| title 1 | title 2 | xxx');
  });

  it('does not fight ordinary typing outside a table', () => {
    render({ body: 'prose' });
    const ta = document.querySelector('.note-body');
    ta.value = 'prose and more';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    expect(ta.value).toBe('prose and more');
  });

  it('settles after one pass rather than looping', () => {
    render({ body: '' });
    const ta = document.querySelector('.note-body');
    ta.value = TYPED;
    ta.selectionStart = ta.selectionEnd = TYPED.indexOf('xxx') + 3;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const settled = ta.value;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    expect(ta.value).toBe(settled);
  });
});

describe('deleting a table column', () => {
  // Regression: sizing every row to the WIDEST meant the body rows instantly
  // re-widened the header, so deleting a column undid itself and a table could
  // never go back to fewer columns.
  const WIDE = '| title 1 | title 2 | xxx |\n| --- | --- | --- |\n|  |  |  |';

  function typeBody(ta, value, caret) {
    ta.value = value;
    ta.selectionStart = ta.selectionEnd = caret ?? value.length;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }

  it('narrows the whole table when the header cell is deleted', () => {
    render({ body: WIDE });
    const ta = document.querySelector('.note-body');
    typeBody(ta, WIDE.replace('| title 1 | title 2 | xxx |', '| title 1 | title 2 |'), 5);
    expect(ta.value.split('\n')).toEqual([
      '| title 1 | title 2 |',
      '| --- | --- |',
      '|  |  |',
    ]);
  });

  it('keeps a cell that still has content in it', () => {
    render({ body: '' });
    const ta = document.querySelector('.note-body');
    typeBody(ta, '| a | b |\n| --- | --- | --- |\n| 1 | 2 | keep |', 3);
    expect(ta.value.split('\n')[2]).toBe('| 1 | 2 | keep |');
  });
});
