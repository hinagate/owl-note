// A selection in the Markdown lights up the same text in the preview: the mirror of
// selecting in the preview, which lights up the source. Exact or nothing, both ways.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { blockRanges, locateRendered } from '../src/lib/source-map.js';
import { renderMarkdown } from '../src/lib/markdown.js';
import { renderEditor } from '../src/app/editor.js';

// What a selection of `text` in `note` lights up: the text of each Range, in order.
function lit(note, text, { nth = 0, host = null } = {}) {
  const root = host || document.createElement('div');
  if (!host) root.innerHTML = renderMarkdown(note);
  let start = note.indexOf(text);
  for (let i = 0; i < nth; i += 1) start = note.indexOf(text, start + 1);
  if (start < 0) throw new Error(`not in the note: ${text}`);
  const selection = { start, end: start + text.length };
  const ranges = [];
  blockRanges(note).forEach((block, index) => {
    if (block.end <= selection.start || block.start >= selection.end) return;
    for (const range of locateRendered(root.children[index], note, block, selection) || []) ranges.push(range);
  });
  return ranges;
}
const words = (ranges) => ranges.map((range) => range.toString());

const NOTE = [
  '## Vowels 元音（17 個教學發音目標）',
  '',
  '> 近似音欄：普 = 普通話／注音，粵 = 粵語（粵拼）。',
  '',
  'A plain paragraph with **bold words** and a [link text](http://example.com/elsewhere) in it.',
  '',
  '### Full Monophthongs 完整單元音（10）',
  '| Symbol | Sounds like 近似音 | Mouth |',
  '| --- | --- | --- |',
  '| /i/ (iː) | 普「衣」拉長，嘴角更用力往兩邊<br>see eat need | 咧嘴 |',
  '| /ɛ/ (e) | 普「欸」；粵「些 se1」的元音<br>bed red said | 欸 |',
  '',
  '### Voiceless 清輔音（9）',
  '| Symbol | Sounds like 近似音 | Mouth |',
  '| --- | --- | --- |',
  '| /s/ | 注音ㄙ（絲）<br>see bus nice | 送氣流到下前牙 |',
  '| /h/ | 注音ㄏ（哈）但更輕<br>hi behind hope | |',
].join('\n');

describe('locateRendered — exact or nothing', () => {
  it('lights the same words of a paragraph', () => {
    expect(words(lit(NOTE, 'plain paragraph'))).toEqual(['plain paragraph']);
  });

  it('finds a CJK phrase inside a table cell', () => {
    expect(words(lit(NOTE, '普「衣」拉長，嘴角更用力往兩邊'))).toEqual(['普「衣」拉長，嘴角更用力往兩邊']);
  });

  // The <br> is markup in the source and a line break in the preview.
  it('follows a selection across a <br>', () => {
    expect(words(lit(NOTE, '嘴角更用力往兩邊<br>see eat need'))).toEqual(['嘴角更用力往兩邊', 'see eat need']);
  });

  it('keeps text that is in both tables in the table it was selected in', () => {
    const host = document.createElement('div');
    host.innerHTML = renderMarkdown(NOTE);
    const [first, second] = host.querySelectorAll('table');
    expect(first.contains(lit(NOTE, 'Sounds like 近似音', { host })[0].startContainer)).toBe(true);
    expect(second.contains(lit(NOTE, 'Sounds like 近似音', { host, nth: 1 })[0].startContainer)).toBe(true);
  });

  it('takes the same one of several in a block', () => {
    const note = 'First pasta, then pasta again, and pasta last.';
    const [range] = lit(note, 'pasta', { nth: 1 });
    expect(range.toString()).toBe('pasta');
    expect(range.startOffset).toBe(note.indexOf('pasta', note.indexOf('pasta') + 1));
  });

  // The link's address holds the word too, so the source says it more often than the
  // preview does and the two can no longer be counted off against each other.
  it('lights nothing when the source and the preview disagree on how many there are', () => {
    const note = 'Some [pasta](http://pasta.example) and more pasta here.';
    expect(lit(note, 'pasta', { nth: 2 })).toEqual([]);
    expect(lit(note, 'pasta.example')).toEqual([]);
  });

  it('reads through markup inside the selection', () => {
    expect(words(lit(NOTE, 'with **bold words** and'))).toEqual(['with ', 'bold words', ' and']);
    expect(words(lit(NOTE, 'a [link text](http://example.com/elsewhere) in'))).toEqual(['a ', 'link text', ' in']);
  });

  it('reads a heading without its #', () => {
    expect(words(lit(NOTE, '### Voiceless 清輔音'))).toEqual(['Voiceless 清輔音']);
  });

  it('lights the cells of a table row, not its pipes', () => {
    expect(words(lit(NOTE, '| /s/ | 注音ㄙ（絲）<br>see bus nice | 送氣流到下前牙 |')))
      .toEqual(['/s/', '注音ㄙ（絲）', 'see bus nice', '送氣流到下前牙']);
  });

  it('carries a selection over the row of dashes under a table header', () => {
    expect(words(lit(NOTE, 'Mouth |\n| --- | --- | --- |\n| /s/ | 注音ㄙ（絲）'))).toEqual(['Mouth', '/s/', '注音ㄙ（絲）']);
  });

  it('lights each block of a selection that runs over several', () => {
    const picked = 'A plain paragraph with **bold words** and a [link text](http://example.com/elsewhere) in it.\n\n### Full Monophthongs';
    expect(words(lit(NOTE, picked)).join('')).toBe('A plain paragraph with bold words and a link text in it.Full Monophthongs');
  });

  it('lights all of a block that is selected whole, however short', () => {
    expect(words(lit('One.\n\nOK\n\nThree.', 'OK'))).toEqual(['OK']);
  });

  it('refuses a selection too short to place', () => {
    expect(lit(NOTE, 'see')).toEqual([]);
    expect(lit(NOTE, '普')).toEqual([]);
  });

  it('leaves pronunciation readings unlit, and lights the spaces between words', () => {
    const host = document.createElement('div');
    host.innerHTML = '<p><ruby>hello<rt>həˈloʊ</rt></ruby> <ruby>world<rt>wɝːld</rt></ruby> again</p>';
    expect(words(lit('hello world again', 'hello world', { host }))).toEqual(['hello', ' ', 'world']);
    expect(words(lit('hello world again', 'hello world again', { host })).join('')).toBe('hello world again');
  });

  it('is safe with missing input', () => {
    const block = blockRanges(NOTE)[0];
    expect(locateRendered(null, NOTE, block, { start: 0, end: 9 })).toBeNull();
    expect(locateRendered(document.createElement('p'), NOTE, null, { start: 0, end: 9 })).toBeNull();
    expect(locateRendered(document.createElement('p'), NOTE, block, null)).toBeNull();
    expect(locateRendered(document.createElement('p'), NOTE, block, { start: 0, end: 9 })).toBeNull(); // nothing rendered
    expect(locateRendered(document.createElement('p'), NOTE, block, { start: 5000, end: 5009 })).toBeNull(); // not in this block
  });
});

describe('selecting in the editor', () => {
  const BODY = 'First paragraph here.\n\nSecond has **bold** words in it, and pasta too.\n\nThird paragraph ends.';
  let el;
  let highlights;
  beforeEach(() => {
    document.body.innerHTML = '<main id="editor"></main>';
    el = document.getElementById('editor');
    highlights = new Map();
    vi.stubGlobal('CSS', { highlights });
    vi.stubGlobal('Highlight', class {
      constructor(...ranges) { this.ranges = ranges; [this.range] = ranges; }
      add(range) { this.ranges.push(range); }
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  const area = () => el.querySelector('textarea.note-body');
  const painted = () => highlights.get('owl-note-mirror')?.ranges.map((range) => range.toString()).join('');
  const linked = () => el.querySelector('.note-body-highlights mark.note-linked-hit');
  // As Shift+arrows would: the selection is made, then a key is let go.
  const select = (text) => {
    const ta = area();
    const start = ta.value.indexOf(text);
    ta.focus();
    ta.setSelectionRange(start, start + text.length);
    ta.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }));
  };
  const caret = (at = 0) => {
    area().setSelectionRange(at, at);
    area().dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowLeft', bubbles: true }));
  };

  it('lights the same words in the preview', () => {
    renderEditor(el, { body: BODY });
    select('paragraph here');
    expect(painted()).toBe('paragraph here');
    expect(el.querySelector('.preview-body').contains(highlights.get('owl-note-mirror').ranges[0].startContainer)).toBe(true);
  });

  it('reads through markup', () => {
    renderEditor(el, { body: BODY });
    select('has **bold** words');
    expect(painted()).toBe('has bold words');
  });

  it('follows a selection made with the mouse, wherever the button is let go', () => {
    vi.useFakeTimers();
    renderEditor(el, { body: BODY });
    const ta = area();
    ta.focus();
    ta.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    ta.setSelectionRange(BODY.indexOf('Third'), BODY.indexOf('Third') + 15);
    el.querySelector('.preview').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(painted()).toBeUndefined(); // the browser has not settled the selection yet
    vi.runAllTimers();
    expect(painted()).toBe('Third paragraph');
  });

  it('ends when the selection is reduced to a caret', () => {
    renderEditor(el, { body: BODY });
    select('paragraph here');
    caret(3);
    expect(highlights.size).toBe(0);
  });

  it('does not light the whole preview when the whole note is selected', () => {
    renderEditor(el, { body: BODY });
    select('paragraph here');
    select(BODY);
    expect(highlights.size).toBe(0);
  });

  it('lights nothing for a selection it cannot place', () => {
    renderEditor(el, { body: 'Some [pasta](http://pasta.example) and more pasta here.\n\nSecond.' });
    select('pasta.example');
    expect(highlights.size).toBe(0);
  });

  it('ends when the editor loses focus, where its selection stops showing', () => {
    renderEditor(el, { body: BODY });
    select('paragraph here');
    area().blur();
    expect(highlights.size).toBe(0);
  });

  it('ends when the text is edited, whose offsets it no longer matches', () => {
    renderEditor(el, { body: BODY });
    select('paragraph here');
    const ta = area();
    ta.value = `x${ta.value}`;
    ta.dispatchEvent(new Event('input'));
    expect(highlights.size).toBe(0);
  });

  it('survives the preview being rebuilt', () => {
    const api = renderEditor(el, { body: BODY });
    select('paragraph here');
    const before = highlights.get('owl-note-mirror').ranges[0];
    api.refresh();
    const after = highlights.get('owl-note-mirror').ranges[0];
    expect(after).not.toBe(before);
    expect(painted()).toBe('paragraph here');
    expect(el.querySelector('.preview-body').contains(after.startContainer)).toBe(true);
  });

  it('takes over from a preview selection mirrored in the source', () => {
    renderEditor(el, { body: BODY });
    window.getSelection().selectAllChildren(el.querySelector('.preview-body p'));
    el.querySelector('.preview-content').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(linked().textContent).toBe('First paragraph here.');
    select('Third paragraph');
    expect(linked()).toBeNull();
    expect(painted()).toBe('Third paragraph');
    window.getSelection().removeAllRanges();
  });

  it('takes over from a keyword opened from a search', () => {
    const api = renderEditor(el, { body: BODY });
    api.revealKeyword('pasta');
    expect(highlights.has('owl-note-keyword')).toBe(true);
    select('Third paragraph');
    expect(highlights.has('owl-note-keyword')).toBe(false);
    expect(linked()).toBeNull();
    expect(painted()).toBe('Third paragraph');
  });

  it('leaves a keyword opened from a search alone on a plain click or key', () => {
    const api = renderEditor(el, { body: BODY });
    api.revealKeyword('pasta');
    area().focus();
    caret(3);
    expect(highlights.has('owl-note-keyword')).toBe(true);
    expect(linked().textContent).toBe('pasta');
  });

  it('ends when the editor goes away', () => {
    const api = renderEditor(el, { body: BODY });
    select('paragraph here');
    api.destroy();
    expect(highlights.size).toBe(0);
  });

  it('stands up to a browser without the Highlight API', () => {
    vi.unstubAllGlobals();
    const api = renderEditor(el, { body: BODY });
    expect(() => { select('paragraph here'); api.refresh(); caret(0); }).not.toThrow();
  });

  describe('and the preview', () => {
    const place = (top) => { Range.prototype.getBoundingClientRect = () => ({ top, bottom: top + 20, left: 0, right: 40, width: 40, height: 20 }); };
    afterEach(() => { delete Range.prototype.getBoundingClientRect; });
    let api;
    const open = (body = BODY) => {
      api = renderEditor(el, { body });
      const preview = el.querySelector('.preview');
      Object.defineProperty(preview, 'clientHeight', { value: 300, configurable: true });
      preview.getBoundingClientRect = () => ({ top: 0, bottom: 300, left: 0, right: 600, width: 600, height: 300 });
      return preview;
    };

    it('scrolls to text that is out of view, a third of the way down the pane', () => {
      const preview = open();
      place(900);
      select('paragraph here');
      expect(preview.scrollTop).toBe(800);
    });

    it('stays where it is when the text is already in view', () => {
      const preview = open();
      preview.scrollTop = 40;
      place(120);
      select('paragraph here');
      expect(preview.scrollTop).toBe(40);
    });

    it('scrolls once for a selection: not for another key, nor when the preview is rebuilt', () => {
      const preview = open();
      place(900);
      select('paragraph here');
      preview.scrollTop = 0; // the reader scrolled away
      area().dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true })); // the same selection still
      expect(preview.scrollTop).toBe(0);
      api.refresh();
      expect(preview.scrollTop).toBe(0);
      expect(painted()).toBe('paragraph here');
    });

    it('brings the text into view inside a table that scrolls sideways', () => {
      const preview = open('| a | b |\n| --- | --- |\n| 1 | pasta |');
      Range.prototype.getBoundingClientRect = () => ({ top: 50, bottom: 70, left: 900, right: 940, width: 40, height: 20 });
      const table = el.querySelector('.preview-body table');
      Object.defineProperty(table, 'scrollWidth', { value: 2000, configurable: true });
      Object.defineProperty(table, 'clientWidth', { value: 600, configurable: true });
      table.getBoundingClientRect = () => ({ top: 0, bottom: 200, left: 0, right: 600, width: 600, height: 200 });
      select('pasta');
      expect(table.scrollLeft).toBe(700);
      expect(preview.scrollTop).toBe(0);
    });
  });
});
