// Two things that make a search stay noticed and useful: a hint over the filtered list
// that cancels it, and opening a result on the keyword rather than at the top of the note.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { findKeyword } from '../src/lib/search.js';
import { keywordRange } from '../src/lib/source-map.js';
import { renderNoteList } from '../src/app/note-list.js';
import { renderToolbar } from '../src/app/toolbar.js';
import { renderEditor } from '../src/app/editor.js';
import { installFakeChrome } from './helpers/fake-chrome.js';
import { _resetCache } from '../src/lib/note-key.js';

const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

describe('findKeyword', () => {
  it('ignores case and reports offsets into the original text', () => {
    expect(findKeyword('Boil the PASTA now', 'pasta')).toEqual({ start: 9, end: 14 });
  });

  it('finds the first occurrence', () => {
    expect(findKeyword('owl, owl', 'owl').start).toBe(0);
  });

  it('trims the query, as the list filter does', () => {
    expect(findKeyword('a pasta', '  pasta ')).toEqual({ start: 2, end: 7 });
  });

  it('treats regular expression characters as plain text', () => {
    expect(findKeyword('total (a+b) here', '(a+b)')).toEqual({ start: 6, end: 11 });
    expect(findKeyword('abc', 'a.c')).toBeNull();
    expect(findKeyword('path\\to', '\\')).toEqual({ start: 4, end: 5 });
  });

  it('keeps offsets right when lowercasing would change the length of earlier text', () => {
    // 'İ'.toLowerCase() is two characters, so an index found in a lowercased copy is off by one.
    const text = 'İİ pasta';
    const spot = findKeyword(text, 'PASTA');
    expect(text.slice(spot.start, spot.end)).toBe('pasta');
  });

  it('matches Chinese text and reports nothing for a miss or an empty query', () => {
    expect(findKeyword('普通話 注音', '注音')).toEqual({ start: 4, end: 6 });
    expect(findKeyword('abc', 'xyz')).toBeNull();
    expect(findKeyword('abc', '   ')).toBeNull();
    expect(findKeyword(null, 'a')).toBeNull();
  });
});

describe('keywordRange', () => {
  const dom = (html) => {
    const root = document.createElement('div');
    root.innerHTML = html;
    return root;
  };

  it('finds a word inside one text node, ignoring case', () => {
    const range = keywordRange(dom('<p>Boil the PASTA now</p>'), 'pasta');
    expect(range.toString()).toBe('PASTA');
  });

  it('spans a word split across formatting', () => {
    const range = keywordRange(dom('<p>the <b>pas</b><i>ta</i> pot</p>'), 'pasta');
    expect(range.toString()).toBe('pasta');
  });

  it('reads a word through its ruby readings, without matching the readings', () => {
    const root = dom('<p><ruby>注<rt>zyu</rt></ruby><ruby>音<rt>jam</rt></ruby></p>');
    expect(keywordRange(root, 'zyu')).toBeNull();
    expect(keywordRange(root, '注音').startContainer.data).toBe('注');
    expect(keywordRange(root, '注音').endContainer.data).toBe('音');
  });

  it('skips text the app added around the note', () => {
    const root = dom('<pre><code>x</code><button>Copy</button></pre>'
      + '<span class="owl-image-placeholder">Loading image…</span>'
      + '<svg><style>.pasta{}</style></svg><p>real copy and image and pasta</p>');
    expect(keywordRange(root, 'copy').startContainer.parentElement.tagName).toBe('P');
    expect(keywordRange(root, 'image').startContainer.parentElement.tagName).toBe('P');
    expect(keywordRange(root, 'pasta').startContainer.parentElement.tagName).toBe('P');
  });

  it('returns null with nothing to search or nothing found', () => {
    expect(keywordRange(null, 'a')).toBeNull();
    expect(keywordRange(dom('<p>abc</p>'), 'xyz')).toBeNull();
    expect(keywordRange(dom(''), 'a')).toBeNull();
  });
});

describe('the filter hint over the note list', () => {
  const notes = [{ bookmarkId: 'b1', title: 'One' }, { bookmarkId: 'b2', title: 'Two' }];
  let el;
  beforeEach(() => {
    document.body.innerHTML = '<section id="note-list"></section>';
    el = document.getElementById('note-list');
  });

  it('says what the list is filtered by and how much of it is showing', () => {
    renderNoteList(el, { notes, query: 'pasta', totalCount: 42, onClearQuery: vi.fn() });
    const hint = el.querySelector('.list-filter');
    expect(hint.querySelector('.list-filter-keyword').textContent).toBe('Filtered by “pasta”');
    expect(hint.querySelector('.list-filter-count').textContent).toBe('2 of 42');
    expect(hint.tagName).toBe('BUTTON');
  });

  it('sits above the cards, below "+ New note"', () => {
    renderNoteList(el, { notes, query: 'pasta', totalCount: 42, onClearQuery: vi.fn() });
    const order = [...el.children].map((c) => c.className.split(' ')[0]);
    expect(order).toEqual(['new', 'list-filter', 'item', 'item']);
  });

  it('cancels the filter when clicked anywhere on it', () => {
    const onClearQuery = vi.fn();
    renderNoteList(el, { notes, query: 'pasta', totalCount: 42, onClearQuery });
    el.querySelector('.list-filter-keyword').click();
    expect(onClearQuery).toHaveBeenCalledTimes(1);
  });

  it('keeps Enter on the hint from opening the focused note instead', () => {
    const onOpenFocused = vi.fn();
    renderNoteList(el, { notes, query: 'pasta', totalCount: 42, onClearQuery: vi.fn(), onOpenFocused });
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    el.querySelector('.list-filter').dispatchEvent(enter);
    expect(onOpenFocused).not.toHaveBeenCalled();
    expect(enter.defaultPrevented).toBe(false); // the browser still turns it into a click
  });

  it('moves the keyboard to the list, since the hint is about to be rebuilt away', () => {
    renderNoteList(el, { notes, query: 'pasta', totalCount: 42, onClearQuery: vi.fn() });
    el.querySelector('.list-filter').click();
    expect(document.activeElement).toBe(el);
  });

  it('stays when nothing matches, as that is when it is needed most', () => {
    renderNoteList(el, { notes: [], query: 'zzz', totalCount: 42, onClearQuery: vi.fn() });
    expect(el.querySelector('.list-filter-count').textContent).toBe('0 of 42');
    expect(el.textContent).toContain('No keyword matches');
  });

  it('shows in the Trash too, where a search also filters', () => {
    const onClearQuery = vi.fn();
    renderNoteList(el, { notes, query: 'pasta', totalCount: 5, onClearQuery, trashView: true });
    const order = [...el.children].map((c) => c.className.split(' ')[0]);
    expect(order).toEqual(['trash-bar', 'list-filter', 'item', 'item']);
    el.querySelector('.list-filter').click();
    expect(onClearQuery).toHaveBeenCalledTimes(1);
  });

  it('is absent without a search, or with only spaces in the box', () => {
    renderNoteList(el, { notes, query: '', onClearQuery: vi.fn() });
    expect(el.querySelector('.list-filter')).toBeNull();
    renderNoteList(el, { notes, query: '   ', onClearQuery: vi.fn() });
    expect(el.querySelector('.list-filter')).toBeNull();
  });

  it('renders a keyword as text, never as markup', () => {
    renderNoteList(el, { notes: [], query: '<img src=x>', totalCount: 1, onClearQuery: vi.fn() });
    expect(el.querySelector('.list-filter img')).toBeNull();
    expect(el.querySelector('.list-filter-keyword').textContent).toContain('<img src=x>');
  });
});

describe('toolbar setQuery', () => {
  it('sets the box without reporting a search of its own', () => {
    const onSearch = vi.fn();
    const el = document.createElement('div');
    const toolbar = renderToolbar(el, { query: 'pasta', onSearch, onExportMarkdown: vi.fn(), onExportKey: vi.fn(), onImport: vi.fn(), onImportKey: vi.fn() });
    toolbar.setQuery('');
    expect(el.querySelector('input.search').value).toBe('');
    expect(onSearch).not.toHaveBeenCalled();
  });
});

describe('editor revealKeyword', () => {
  const BODY = 'First paragraph.\n\nSecond has the Pasta in it, and pasta again.\n\nThird.';
  let el;
  let highlights;
  beforeEach(() => {
    document.body.innerHTML = '<main id="editor"></main>';
    el = document.getElementById('editor');
    highlights = new Map();
    vi.stubGlobal('CSS', { highlights });
    vi.stubGlobal('Highlight', class { constructor(range) { this.range = range; } });
  });
  afterEach(() => vi.unstubAllGlobals());

  const linked = () => el.querySelector('.note-body-highlights mark.note-linked-hit');
  const painted = () => highlights.get('owl-note-keyword')?.range.toString();

  it('marks the first occurrence in the source and in the preview', () => {
    const api = renderEditor(el, { body: BODY });
    api.revealKeyword('pasta');
    expect(linked().textContent).toBe('Pasta');
    expect(painted()).toBe('Pasta');
  });

  it('leaves keyboard focus where it was, and puts the caret on the keyword', () => {
    const api = renderEditor(el, { body: BODY });
    const ta = el.querySelector('textarea.note-body');
    api.revealKeyword('pasta');
    expect(document.activeElement).not.toBe(ta);
    expect(ta.selectionStart).toBe(BODY.indexOf('Pasta'));
    expect(ta.selectionEnd).toBe(BODY.indexOf('Pasta'));
  });

  it('does nothing when the keyword is not in the body (a title match)', () => {
    const api = renderEditor(el, { title: 'Pasta', body: 'nothing here' });
    api.revealKeyword('pasta');
    expect(linked()).toBeNull();
    expect(highlights.size).toBe(0);
  });

  it('shows the same occurrence in both panes when an earlier one reads only in the preview', () => {
    // "pas**ta**" reads as the keyword, but the source's first match is the plain one below.
    const api = renderEditor(el, { body: 'Split pas**ta** here.\n\nPlain pasta here.' });
    api.revealKeyword('pasta');
    expect(linked().textContent).toBe('pasta');
    expect(highlights.get('owl-note-keyword').range.startContainer.data).toContain('Plain pasta');
  });

  it('falls back to where the word reads when the source match is a link target', () => {
    const api = renderEditor(el, { body: 'A [link](http://pasta.example) here.\n\nThe pasta itself.' });
    api.revealKeyword('pasta');
    expect(linked().textContent).toBe('pasta');
    expect(painted()).toBe('pasta');
    expect(highlights.get('owl-note-keyword').range.startContainer.data).toContain('The pasta');
  });

  it('marks the source alone when the keyword is not visible in the preview', () => {
    const api = renderEditor(el, { body: 'Intro.\n\n[link](http://pasta.example)' });
    api.revealKeyword('pasta');
    expect(linked().textContent).toBe('pasta');
    expect(highlights.size).toBe(0);
  });

  it('works in a read-only note, which has only the preview to show it in', () => {
    const api = renderEditor(el, { body: BODY, readOnly: true });
    api.revealKeyword('pasta');
    expect(painted()).toBe('Pasta');
  });

  it('survives the preview being rebuilt', () => {
    const api = renderEditor(el, { body: BODY });
    api.revealKeyword('pasta');
    const before = highlights.get('owl-note-keyword').range;
    api.refresh();
    const after = highlights.get('owl-note-keyword').range;
    expect(after).not.toBe(before);
    expect(after.toString()).toBe('Pasta');
    expect(el.querySelector('.preview-body').contains(after.startContainer)).toBe(true);
  });

  it('ends when the text is edited, whose offsets it no longer matches', () => {
    const api = renderEditor(el, { body: BODY });
    api.revealKeyword('pasta');
    const ta = el.querySelector('textarea.note-body');
    ta.value = `x${ta.value}`;
    ta.dispatchEvent(new Event('input'));
    expect(linked()).toBeNull();
    expect(highlights.size).toBe(0);
  });

  it('ends on a click in the preview, as a mirrored selection does', () => {
    const api = renderEditor(el, { body: BODY });
    api.revealKeyword('pasta');
    el.querySelector('.preview-content').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(linked()).toBeNull();
    expect(highlights.size).toBe(0);
  });

  it('ends on a click in a read-only preview as well', () => {
    const api = renderEditor(el, { body: BODY, readOnly: true });
    api.revealKeyword('pasta');
    el.querySelector('.preview-content').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(highlights.size).toBe(0);
  });

  it('ends when asked, and when the editor goes away', () => {
    const api = renderEditor(el, { body: BODY });
    api.revealKeyword('pasta');
    api.clearRevealed();
    expect(linked()).toBeNull();
    expect(highlights.size).toBe(0);
    api.revealKeyword('pasta');
    api.destroy();
    expect(highlights.size).toBe(0);
  });

  it('leaves a mirrored preview selection alone when there is no keyword to clear', () => {
    const api = renderEditor(el, { body: BODY });
    const selection = window.getSelection();
    selection.selectAllChildren(el.querySelector('.preview-body p'));
    el.querySelector('.preview-content').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(linked().textContent).toBe('First paragraph.');
    api.clearRevealed(); // the reader typed in the search box while selecting
    expect(linked().textContent).toBe('First paragraph.');
    selection.removeAllRanges();
  });

  it('stands up to a browser without the Highlight API', () => {
    vi.unstubAllGlobals();
    const api = renderEditor(el, { body: BODY });
    expect(() => { api.revealKeyword('pasta'); api.refresh(); api.clearRevealed(); }).not.toThrow();
  });
});

describe('scrolling the preview to the keyword', () => {
  const BODY = 'First.\n\nSecond has the pasta in it.\n\nThird.';
  let el;
  beforeEach(() => {
    document.body.innerHTML = '<main id="editor"></main>';
    el = document.getElementById('editor');
    // jsdom has no layout. Give the range a place and the pane a height.
    Range.prototype.getBoundingClientRect = () => ({ top: 900, left: 0, width: 40, height: 20 });
  });
  afterEach(() => { delete Range.prototype.getBoundingClientRect; });

  const open = () => {
    const api = renderEditor(el, { body: BODY });
    const preview = el.querySelector('.preview');
    Object.defineProperty(preview, 'clientHeight', { value: 300, configurable: true });
    return { api, preview };
  };

  it('puts it a third of the way down the pane, as find in note does', () => {
    const { api, preview } = open();
    api.revealKeyword('pasta');
    expect(preview.scrollTop).toBe(800);
  });

  it('follows it through a rebuild until the reader touches the panes', () => {
    const { api, preview } = open();
    api.revealKeyword('pasta');
    preview.scrollTop = 0; // as if a rebuild had moved everything
    api.refresh();
    expect(preview.scrollTop).toBe(800);
    preview.dispatchEvent(new Event('wheel', { bubbles: true }));
    preview.scrollTop = 123;
    api.refresh();
    expect(preview.scrollTop).toBe(123); // the reader has moved on; leave them there
  });

  it('still repaints the highlight after the reader has scrolled away', () => {
    const highlights = new Map();
    vi.stubGlobal('CSS', { highlights });
    vi.stubGlobal('Highlight', class { constructor(range) { this.range = range; } });
    const { api, preview } = open();
    api.revealKeyword('pasta');
    preview.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    highlights.clear();
    api.refresh();
    expect(highlights.get('owl-note-keyword').range.toString()).toBe('pasta');
    vi.unstubAllGlobals();
  });

  it('brings the word into view inside a table that scrolls sideways', () => {
    const api = renderEditor(el, { body: '| a | b |\n| --- | --- |\n| 1 | pasta |' });
    const preview = el.querySelector('.preview');
    Object.defineProperty(preview, 'clientHeight', { value: 300, configurable: true });
    Range.prototype.getBoundingClientRect = () => ({ top: 50, left: 900, width: 40, height: 20 });
    const table = el.querySelector('.preview-body table');
    Object.defineProperty(table, 'scrollWidth', { value: 2000, configurable: true });
    Object.defineProperty(table, 'clientWidth', { value: 600, configurable: true });
    api.revealKeyword('pasta');
    expect(table.scrollLeft).toBe(700);
  });
});

describe('search in the app', () => {
  beforeEach(async () => {
    installFakeChrome();
    _resetCache();
    document.body.innerHTML = '<div id="toolbar"></div><aside id="sidebar"></aside><section id="note-list"></section><main id="editor"></main><div id="toast" hidden></div>';
    const app = await import('../src/app/app.js');
    app.resetUI();
    const bm = await import('../src/lib/bookmarks.js');
    await app.initUI(await bm.ensureRoot());
    for (const [title, body] of [['Dinner', 'Boil water.\n\nThen add the pasta.'], ['Plans', 'Nothing about food.'], ['Lunch', 'A pasta salad.']]) {
      document.querySelector('button.new').click();
      await tick();
      const titleInput = document.querySelector('#editor .note-title');
      titleInput.value = title;
      titleInput.dispatchEvent(new Event('input'));
      const ta = document.querySelector('#editor textarea.note-body');
      ta.value = body;
      ta.dispatchEvent(new Event('input'));
      document.querySelector('#editor button.save').click();
      await tick();
    }
  });
  afterEach(async () => {
    const app = await import('../src/app/app.js');
    app.resetUI();
    await tick(50);
  });

  const cards = () => [...document.querySelectorAll('#note-list .item.card .card-title-text')].map((t) => t.textContent);
  const search = async (q) => {
    const input = document.querySelector('input.search');
    input.value = q;
    input.dispatchEvent(new Event('input'));
    await tick();
  };
  const openCard = async (title) => {
    [...document.querySelectorAll('#note-list .item.card')]
      .find((c) => c.querySelector('.card-title-text').textContent === title).click();
    await tick(30);
  };
  const linked = () => document.querySelector('.note-body-highlights mark.note-linked-hit');

  it('shows no hint until a search narrows the list', async () => {
    expect(document.querySelector('.list-filter')).toBeNull();
    await search('pasta');
    expect(document.querySelector('.list-filter-count').textContent).toBe('2 of 3');
    expect(cards().sort()).toEqual(['Dinner', 'Lunch']);
  });

  it('brings every note back and empties the box when the hint is clicked', async () => {
    await search('pasta');
    document.querySelector('.list-filter').click();
    await tick();
    expect(document.querySelector('input.search').value).toBe('');
    expect(cards()).toHaveLength(3);
    expect(document.querySelector('.list-filter')).toBeNull();
  });

  it('opens a search result on the keyword', async () => {
    await search('pasta');
    await openCard('Dinner');
    expect(document.querySelector('#editor .note-title').value).toBe('Dinner');
    expect(linked().textContent).toBe('pasta');
  });

  it('keeps the hint up while a result is open', async () => {
    await search('pasta');
    await openCard('Dinner');
    expect(document.querySelector('.list-filter-count').textContent).toBe('2 of 3');
  });

  it('marks nothing when a note is opened with no search on', async () => {
    await openCard('Dinner');
    expect(linked()).toBeNull();
  });

  it('marks nothing for a result matched on its title alone', async () => {
    await search('plans');
    await openCard('Plans');
    expect(document.querySelector('#editor .note-title').value).toBe('Plans');
    expect(linked()).toBeNull();
  });

  it('drops the mark when the search is cancelled or changed', async () => {
    await search('pasta');
    await openCard('Dinner');
    document.querySelector('.list-filter').click();
    await tick();
    expect(linked()).toBeNull();

    await search('pasta');
    await openCard('Dinner');
    expect(linked()).not.toBeNull();
    await search('pas');
    expect(linked()).toBeNull();
  });
});
