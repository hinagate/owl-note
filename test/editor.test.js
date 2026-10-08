import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderEditor, shouldFitWidth } from '../src/app/editor.js';

beforeEach(() => { document.body.innerHTML = '<main id="editor"></main>'; });

describe('editor', () => {
  it('renders preview on input and saves', () => {
    const onSave = vi.fn();
    const el = document.getElementById('editor');
    const api = renderEditor(el, { body: '# Hi', onChange: vi.fn(), onSave });
    const ta = el.querySelector('textarea.note-body');
    expect(el.querySelector('.preview').innerHTML).toContain('Hi');
    ta.value = '# Changed';
    ta.dispatchEvent(new Event('input'));
    expect(el.querySelector('.preview').innerHTML).toContain('Changed');
    el.querySelector('button.save').click();
    expect(onSave).toHaveBeenCalledWith({ title: '', body: '# Changed', attachments: [] }, { auto: false });
    expect(api.getBody()).toBe('# Changed');
  });

  it('reports one change when a typed header cell auto-aligns a table', () => {
    const onChange = vi.fn();
    const el = document.getElementById('editor');
    renderEditor(el, { body: '| a | b |\n| --- | --- |\n| 1 | 2 |', onChange });
    const ta = el.querySelector('textarea.note-body');
    ta.value = '| a | b | c |\n| --- | --- |\n| 1 | 2 |';
    ta.setSelectionRange(ta.value.indexOf('c') + 1, ta.value.indexOf('c') + 1);

    ta.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'c' }));

    expect(ta.value).toBe('| a | b | c |\n| --- | --- | --- |\n| 1 | 2 |  |');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ body: ta.value }));
  });

  it('shows the title in its own field and in the preview, and includes it in onSave', () => {
    const onSave = vi.fn();
    const el = document.getElementById('editor');
    renderEditor(el, { title: 'My Title', body: 'x', onSave });
    expect(el.querySelector('.note-title').value).toBe('My Title');
    expect(el.querySelector('.preview-title').textContent).toBe('My Title');
    el.querySelector('button.save').click();
    expect(onSave).toHaveBeenCalledWith({ title: 'My Title', body: 'x', attachments: [] }, { auto: false });
  });

  it('adds a Copy button to code blocks that copies the code text', () => {
    const writeText = vi.fn().mockResolvedValue();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const el = document.getElementById('editor');
    renderEditor(el, { body: '```js\nconst x = 1;\n```' });
    const copyBtn = el.querySelector('.preview pre .copy-code');
    expect(copyBtn).not.toBeNull();
    copyBtn.click();
    expect(writeText).toHaveBeenCalled();
    expect(writeText.mock.calls[0][0]).toContain('const x = 1;');
  });

  it('shows "Copy failed" when the clipboard write rejects', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const el = document.getElementById('editor');
    renderEditor(el, { body: '```js\nconst x = 1;\n```' });
    const copyBtn = el.querySelector('.preview pre .copy-code');
    copyBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(writeText).toHaveBeenCalled();
    expect(copyBtn.textContent).toBe('Copy failed');
  });

  it('inserts a fenced code block at the cursor and positions the caret inside it', () => {
    const onChange = vi.fn();
    const el = document.getElementById('editor');
    renderEditor(el, { body: 'hello', onChange, onSave: vi.fn() });
    const ta = el.querySelector('textarea.note-body');
    ta.selectionStart = ta.selectionEnd = 0; // caret at the very start
    el.querySelector('button.code-block').click();
    expect(ta.value.startsWith('```js\n')).toBe(true);
    expect(ta.selectionStart).toBe(6); // on the empty line inside the fence
    expect(onChange).toHaveBeenCalled();
  });

  it('renders an Image button and a hidden image file input', () => {
    const el = document.getElementById('editor');
    renderEditor(el, { body: 'x' });
    expect(el.querySelector('button.insert-image')).not.toBeNull();
    const input = el.querySelector('input[type="file"]');
    expect(input).not.toBeNull();
    expect(input.accept).toBe('image/*');
    expect(input.style.display).toBe('none');
  });

  it('inserts a picked image as a short owl-img ref and stores it in attachments', async () => {
    const el = document.getElementById('editor');
    const api = renderEditor(el, { body: 'note', onChange: vi.fn(), onSave: vi.fn() });
    const ta = el.querySelector('textarea.note-body');
    ta.selectionStart = ta.selectionEnd = ta.value.length;
    const input = el.querySelector('input[type="file"]');
    const file = new File([new Uint8Array([1, 2, 3])], 'pic.png', { type: 'image/png' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));
    // jsdom has no createImageBitmap, so the downscaler is a no-op; the image is
    // still moved into attachments and the body carries only a short owl-img ref.
    await vi.waitFor(() => expect(ta.value).toMatch(/!\[pic\.png\]\(owl-img:[a-z0-9]+\)/i));
    expect(ta.value).not.toContain('base64'); // no data: wall in the body
    const atts = api.getAttachments();
    expect(atts).toHaveLength(1);
    expect(atts[0].dataUri).toContain('data:image/png;base64,');
    // the preview still shows a real <img> (refs inlined before rendering)
    expect(el.querySelector('.preview img')).not.toBeNull();
  });

  it('opens preview photos in an enlarged view and closes it with Escape', () => {
    const el = document.getElementById('editor');
    renderEditor(el, { body: '![A bird](https://example.test/bird.png)' });
    const previewImage = el.querySelector('.preview img');
    const lightbox = el.querySelector('.image-lightbox');
    expect(previewImage.title).toContain('enlarge');
    previewImage.click();
    expect(lightbox.hidden).toBe(false);
    expect(lightbox.querySelector('.image-lightbox-image').src).toContain('bird.png');
    expect(lightbox.querySelector('.image-lightbox-zoom').textContent).toBe('100%');
    lightbox.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, cancelable: true }));
    expect(lightbox.querySelector('.image-lightbox-zoom').textContent).toBe('115%');
    const enlargedImage = lightbox.querySelector('.image-lightbox-image');
    expect(enlargedImage.style.transform).toBe('scale(1.15)');
    expect(enlargedImage.classList.contains('pannable')).toBe(true);
    enlargedImage.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 100, clientY: 90 }));
    enlargedImage.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, buttons: 1, clientX: 145, clientY: 115 }));
    expect(enlargedImage.style.transform).toBe('translate3d(45px, 25px, 0) scale(1.15)');
    expect(enlargedImage.classList.contains('dragging')).toBe(true);
    enlargedImage.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0, clientX: 145, clientY: 115 }));
    expect(enlargedImage.classList.contains('dragging')).toBe(false);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(lightbox.hidden).toBe(true);
    expect(enlargedImage.style.transform).toBe('scale(1)');
  });

  it('keeps Find in note last so it wraps only when the first row runs out of room', () => {
    const el = document.getElementById('editor');
    renderEditor(el, { body: 'Owl one\nno match\nowl two' });
    const bar = el.querySelector('.format-bar');
    const search = bar.querySelector('.note-search');
    const input = search.querySelector('.note-search-input');
    expect(bar.lastElementChild).toBe(search);
    expect(bar.querySelector('.note-search-row')).toBeNull();
    input.value = 'owl';
    input.dispatchEvent(new Event('input'));
    expect(search.querySelector('.note-search-count').textContent).toBe('1/2');
    expect(el.querySelectorAll('.note-body-highlights .note-search-hit')).toHaveLength(2);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(search.querySelector('.note-search-count').textContent).toBe('2/2');
  });

  it('renders a Delete button only when onDelete is provided, and fires it', () => {
    const el = document.getElementById('editor');
    const onDelete = vi.fn();
    renderEditor(el, { body: 'x', onDelete });
    el.querySelector('button.delete').click();
    expect(onDelete).toHaveBeenCalled();
  });

  it('omits the Delete button when onDelete is not provided', () => {
    const el = document.getElementById('editor');
    renderEditor(el, { body: 'x' });
    expect(el.querySelector('button.delete')).toBeNull();
  });

  it('shows a live size meter when a measure callback is provided', async () => {
    const measure = vi.fn().mockResolvedValue({ bytes: 12800, warn: 16384, max: 65536 });
    const el = document.getElementById('editor');
    renderEditor(el, { body: 'hi', measure });
    await new Promise((r) => setTimeout(r));
    const badge = el.querySelector('.preview-size');
    expect(badge).not.toBeNull();
    expect(measure).toHaveBeenCalled();
    expect(badge.textContent).toBe('12.5 / 64 KB');
    expect(badge.classList.contains('warn')).toBe(false);
    expect(badge.classList.contains('over')).toBe(false);
  });

  it('flags the size meter amber over the warn cap and red over the hard cap', async () => {
    const el = document.getElementById('editor');
    renderEditor(el, { body: 'hi', measure: () => Promise.resolve({ bytes: 20000, warn: 16384, max: 65536 }) });
    await new Promise((r) => setTimeout(r));
    expect(el.querySelector('.preview-size').classList.contains('warn')).toBe(true);

    document.body.innerHTML = '<main id="editor"></main>';
    const el2 = document.getElementById('editor');
    renderEditor(el2, { body: 'hi', measure: () => Promise.resolve({ bytes: 70000, warn: 16384, max: 65536 }) });
    await new Promise((r) => setTimeout(r));
    const badge = el2.querySelector('.preview-size');
    expect(badge.classList.contains('over')).toBe(true);
    expect(badge.classList.contains('warn')).toBe(false);
  });

  it('omits the size meter when no measure callback is given', () => {
    const el = document.getElementById('editor');
    renderEditor(el, { body: 'hi' });
    expect(el.querySelector('.preview-size')).toBeNull();
  });

  it('renders a Suggest-title button only when onSuggestTitle is provided', () => {
    const el = document.getElementById('editor');
    renderEditor(el, { body: 'x' });
    expect(el.querySelector('.suggest-title')).toBeNull();

    document.body.innerHTML = '<main id="editor"></main>';
    const el2 = document.getElementById('editor');
    renderEditor(el2, { body: 'x', onSuggestTitle: vi.fn() });
    const btn = el2.querySelector('.suggest-title');
    expect(btn).not.toBeNull();
    expect(btn.getAttribute('aria-label')).toBe('Suggest a title');
  });

  it('passes the current body to onSuggestTitle and disables the button while pending', () => {
    let resolve;
    const onSuggestTitle = vi.fn(() => new Promise((r) => { resolve = r; }));
    const el = document.getElementById('editor');
    renderEditor(el, { body: 'Milk and eggs', onSuggestTitle });
    const btn = el.querySelector('.suggest-title');
    btn.click();
    expect(onSuggestTitle).toHaveBeenCalledWith('Milk and eggs');
    expect(btn.disabled).toBe(true); // busy affordance while the model runs
    resolve(null); // let the pending promise settle so the finally re-enables it
  });

  it('fills the title through the normal change path when onSuggestTitle resolves a title', async () => {
    const onChange = vi.fn();
    const onSuggestTitle = vi.fn().mockResolvedValue('Grocery list');
    const el = document.getElementById('editor');
    renderEditor(el, { body: 'Milk and eggs', onChange, onSuggestTitle });
    const btn = el.querySelector('.suggest-title');
    btn.click();

    await vi.waitFor(() => expect(el.querySelector('.note-title').value).toBe('Grocery list'));
    // Landing through the manual-edit path means onChange (autosave) saw it and the preview updated.
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ title: 'Grocery list' }));
    expect(el.querySelector('.preview-title').textContent).toBe('Grocery list');
    expect(btn.disabled).toBe(false); // re-enabled in finally
  });

  it('leaves the title unchanged when onSuggestTitle resolves null', async () => {
    const onChange = vi.fn();
    const onSuggestTitle = vi.fn().mockResolvedValue(null);
    const el = document.getElementById('editor');
    renderEditor(el, { title: 'Keep me', body: 'x', onChange, onSuggestTitle });
    const btn = el.querySelector('.suggest-title');
    btn.click();

    await vi.waitFor(() => expect(btn.disabled).toBe(false));
    expect(el.querySelector('.note-title').value).toBe('Keep me');
  });

  // [Task E10] replaceBody swaps the WHOLE body (the Format quick action's Apply
  // path). It must run through the SAME change path a keystroke does — onChange +
  // autosave + preview re-render — so the reformat is observed and persisted. In a
  // real browser it uses execCommand('insertText') to preserve native undo; under
  // jsdom (no execCommand) it falls back to a value assignment + the input event.
  it('replaceBody replaces the body through the change path (onChange + preview see the new body)', () => {
    const onChange = vi.fn();
    const onSave = vi.fn();
    const el = document.getElementById('editor');
    const api = renderEditor(el, { body: 'old messy body', onChange, onSave });
    const ta = el.querySelector('textarea.note-body');
    const status = el.querySelector('.save-status');

    api.replaceBody('# Clean\n\n- one\n- two');

    expect(ta.value).toBe('# Clean\n\n- one\n- two');
    // The change path ran: onChange saw the new body and the preview re-rendered.
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ body: '# Clean\n\n- one\n- two' }));
    expect(el.querySelector('.preview').innerHTML).toContain('Clean');
    expect(api.getBody()).toBe('# Clean\n\n- one\n- two');
    // Autosave was scheduled by the change path (subtle inline status flips to Unsaved…).
    expect(status.textContent).toBe('Unsaved…');
  });

  it('shows only Updated on the footer and exposes Created + Updated on hover', () => {
    const el = document.getElementById('editor');
    const created = Date.UTC(2026, 6, 26, 6, 30);
    const updated = Date.UTC(2026, 6, 26, 7, 45);
    const api = renderEditor(el, { body: 'Reference', created, updated, onSave: vi.fn() });
    const row = el.querySelector('.editor-status-row');
    const label = row.querySelector('.note-updated-time');
    const time = label.querySelector('time');
    const status = row.querySelector('.save-status');

    expect(row.hidden).toBe(false);
    expect(row.firstElementChild).toBe(label);
    expect(row.lastElementChild).toBe(status);
    expect(label.textContent).toContain('Updated');
    expect(label.textContent).not.toContain('Created');
    expect(time.dateTime).toBe(new Date(updated).toISOString());
    expect(label.title).toContain(`Created: ${new Date(created).toLocaleString()}`);
    expect(label.title).toContain(`Updated: ${new Date(updated).toLocaleString()}`);
    api.destroy();
  });

  it('uses the creation time as an honest visible fallback when legacy data has no updated timestamp', () => {
    const el = document.getElementById('editor');
    const created = Date.UTC(2025, 0, 2, 3, 4);
    const api = renderEditor(el, { body: 'Legacy', created });
    const label = el.querySelector('.note-updated-time');
    expect(label.querySelector('time').dateTime).toBe(new Date(created).toISOString());
    expect(label.title).toContain('Updated: Not recorded (showing created time)');
    api.destroy();
  });

  it('refreshes the visible Updated time from the successfully saved note', async () => {
    const el = document.getElementById('editor');
    const created = Date.UTC(2026, 6, 26, 6, 30);
    const updated = Date.UTC(2026, 6, 26, 8, 15);
    const api = renderEditor(el, {
      body: 'Reference',
      created,
      updated: created,
      onSave: vi.fn().mockResolvedValue({ created, updated }),
    });

    el.querySelector('button.save').click();
    await vi.waitFor(() => expect(el.querySelector('.save-status').textContent).toBe('Saved ✓'));
    const label = el.querySelector('.note-updated-time');
    expect(label.querySelector('time').dateTime).toBe(new Date(updated).toISOString());
    expect(label.title).toContain(`Created: ${new Date(created).toLocaleString()}`);
    expect(label.title).toContain(`Updated: ${new Date(updated).toLocaleString()}`);
    api.destroy();
  });
});

// A full-page capture is many times taller than it is wide. `object-fit: contain`
// scales by whichever axis binds first — always the height for these — so a
// 2736x17541 capture was shown as a ~126px-wide sliver of unreadable text, and no
// amount of zooming reached it because zoom is centred, not a scroll.
describe('shouldFitWidth (which images are scrolled instead of contained)', () => {
  const desktop = [1203, 810]; // a 1280x900 window's 94vw x 90vh

  it('fits a full-page capture to the width', () => {
    expect(shouldFitWidth(2736, 17541, ...desktop)).toBe(true);
  });

  it('still contains ordinary photos, portrait ones included', () => {
    expect(shouldFitWidth(4000, 3000, ...desktop)).toBe(false); // landscape
    expect(shouldFitWidth(3000, 3000, ...desktop)).toBe(false); // square
    expect(shouldFitWidth(960, 1280, ...desktop)).toBe(false); // portrait 3:4
    expect(shouldFitWidth(1170, 2532, ...desktop)).toBe(false); // phone screenshot
  });

  it('decides from the viewport, not a fixed aspect ratio', () => {
    // The same image on a short, wide window has less height to contain into.
    expect(shouldFitWidth(1000, 2600, 1800, 400)).toBe(true);
    expect(shouldFitWidth(1000, 2600, 600, 1400)).toBe(false);
  });

  it('reports "unknown" rather than guessing before the image has decoded', () => {
    expect(shouldFitWidth(0, 0, ...desktop)).toBeNull();
    expect(shouldFitWidth(2736, 17541, 0, 0)).toBeNull();
  });
});

describe('a long insertion is one edit', () => {
  // Chrome's execCommand('insertText') with multi-line text fires one nested `input`
  // event per inserted line. Handling each one rebuilt the whole preview, so pasting a
  // large Excel range or tidying a long note froze the page.
  function chromeLikeExecCommand(ta) {
    return vi.fn((command, showUi, text) => {
      const start = ta.selectionStart;
      let value = ta.value.slice(0, start) + ta.value.slice(ta.selectionEnd);
      let pos = start;
      text.split('\n').forEach((line, i) => {
        const piece = i ? `\n${line}` : line;
        value = value.slice(0, pos) + piece + value.slice(pos);
        pos += piece.length;
        ta.value = value;
        ta.selectionStart = ta.selectionEnd = pos;
        ta.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      });
      return true;
    });
  }

  it('rebuilds the preview and reports the change once, with the whole text', () => {
    const onChange = vi.fn();
    const el = document.getElementById('editor');
    const api = renderEditor(el, { body: 'old', onChange, onSave: vi.fn() });
    const ta = el.querySelector('textarea.note-body');
    Object.defineProperty(document, 'execCommand', { value: chromeLikeExecCommand(ta), configurable: true });
    try {
      const rows = Array.from({ length: 300 }, (_, i) => `| row ${i} | ${i * 2} |`).join('\n');
      api.replaceBody(rows);
      expect(document.execCommand).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ body: rows }));
      expect(el.querySelector('.preview').textContent).toContain('row 299');
    } finally {
      delete document.execCommand;
    }
  });

  it('still handles a single typed character as before', () => {
    const onChange = vi.fn();
    const el = document.getElementById('editor');
    renderEditor(el, { body: 'a', onChange, onSave: vi.fn() });
    const ta = el.querySelector('textarea.note-body');
    ta.value = 'ab';
    ta.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    ta.value = 'abc';
    ta.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});

describe('the save status', () => {
  it('does not say Saved while edits made during the save are still waiting', async () => {
    let finish;
    const onSave = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const el = document.getElementById('editor');
    renderEditor(el, { body: 'a', onChange: vi.fn(), onSave });
    const ta = el.querySelector('textarea.note-body');
    const status = el.querySelector('.save-status');
    ta.value = 'a b';
    ta.dispatchEvent(new Event('input'));
    el.querySelector('button.save').click();
    expect(status.textContent).toBe('Saving…');
    ta.value = 'a b c'; // typed while the save runs
    ta.dispatchEvent(new Event('input'));
    finish({});
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(status.textContent).toBe('Unsaved…');
  });

  it('a replaced editor saves edits typed during its last save at once, not after the autosave delay', async () => {
    let finish;
    const onSave = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const el = document.getElementById('editor');
    const api = renderEditor(el, { body: 'a', onChange: vi.fn(), onSave });
    const ta = el.querySelector('textarea.note-body');
    ta.value = 'a b';
    ta.dispatchEvent(new Event('input'));
    ta.dispatchEvent(new Event('blur')); // first save starts
    ta.value = 'a b c';
    ta.dispatchEvent(new Event('input'));
    ta.dispatchEvent(new Event('blur')); // queued behind it
    api.destroy(); // another note opened
    finish({});
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(2), { timeout: 500 });
    expect(onSave.mock.calls[1][0].body).toBe('a b c');
  });

  it('an insertion that finishes after the editor was replaced lands in its own note, not in what has focus now', async () => {
    // An image still being read when the reader clicked "New note": by the time it is
    // inserted, the new note's title has focus, and execCommand edits whatever has focus.
    const onSave = vi.fn(async () => ({}));
    const el = document.getElementById('editor');
    const api = renderEditor(el, { body: 'A body', onChange: vi.fn(), onSave });
    const nextTitle = document.createElement('input');
    document.body.append(nextTitle);
    api.destroy();
    nextTitle.focus();
    const exec = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
    try {
      api.replaceBody('A body\n![shot](owl-img:1)');
    } finally {
      delete document.execCommand;
    }
    expect(exec).not.toHaveBeenCalled();
    expect(nextTitle.value).toBe('');
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1), { timeout: 500 }); // at once, not after the autosave delay
    expect(onSave.mock.calls[0][0].body).toBe('A body\n![shot](owl-img:1)');
  });

  it('never saves text the reader threw away, whatever arrives after', async () => {
    // Delete, or Reload to take another device's version: the old editor is discarded.
    // Removing a focused textarea fires blur in Chrome, and a late insertion can land too.
    const onSave = vi.fn(async () => ({}));
    const el = document.getElementById('editor');
    const api = renderEditor(el, { body: 'mine', onChange: vi.fn(), onSave });
    const ta = el.querySelector('textarea.note-body');
    ta.value = 'mine, unsaved';
    ta.dispatchEvent(new Event('input'));
    api.destroy({ discard: true });
    ta.dispatchEvent(new Event('blur'));
    api.replaceBody('mine, unsaved\n![late](owl-img:1)');
    await new Promise((r) => setTimeout(r, 50));
    expect(onSave).not.toHaveBeenCalled();
  });

  it('counts as busy while a title is being suggested or a file picker is open', async () => {
    let answer;
    const el = document.getElementById('editor');
    const api = renderEditor(el, { body: 'milk', onSave: vi.fn(), onSuggestTitle: () => new Promise((r) => { answer = r; }) });
    expect(api.isBusy()).toBe(false);
    el.querySelector('.suggest-title').click();
    expect(api.isBusy()).toBe(true); // its answer would land in this note
    answer('Shopping');
    await vi.waitFor(() => expect(api.isBusy()).toBe(false));
    const picker = el.querySelector('input[type=file][accept="image/*"]');
    picker.click = () => {}; // the OS dialog
    el.querySelector('.insert-image').click();
    expect(api.isBusy()).toBe(true);
    picker.dispatchEvent(new Event('cancel'));
    expect(api.isBusy()).toBe(false);
    api.destroy();
  });

  it('says so when the note was deleted elsewhere', async () => {
    const el = document.getElementById('editor');
    renderEditor(el, { body: 'a', onSave: vi.fn(async () => { throw new Error('This note was deleted'); }) });
    const ta = el.querySelector('textarea.note-body');
    ta.value = 'a b';
    ta.dispatchEvent(new Event('input'));
    el.querySelector('button.save').click();
    await vi.waitFor(() => expect(el.querySelector('.save-status').textContent).toBe('Deleted elsewhere — not saved'));
  });

  it('says Saved once everything typed is saved', async () => {
    const onSave = vi.fn(async () => ({}));
    const el = document.getElementById('editor');
    renderEditor(el, { body: 'a', onChange: vi.fn(), onSave });
    const ta = el.querySelector('textarea.note-body');
    ta.value = 'a b';
    ta.dispatchEvent(new Event('input'));
    el.querySelector('button.save').click();
    await new Promise((r) => setTimeout(r, 0));
    expect(el.querySelector('.save-status').textContent).toBe('Saved ✓');
  });
});
