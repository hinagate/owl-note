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
});
