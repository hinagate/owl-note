import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderEditor } from '../src/app/editor.js';

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
    expect(lightbox.querySelector('.image-lightbox-image').style.transform).toBe('scale(1.15)');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(lightbox.hidden).toBe(true);
  });

  it('finds text within the current note from the right side of the format bar', () => {
    const el = document.getElementById('editor');
    renderEditor(el, { body: 'Owl one\nno match\nowl two' });
    const bar = el.querySelector('.format-bar');
    const search = bar.querySelector('.note-search');
    const input = search.querySelector('.note-search-input');
    expect(bar.lastElementChild).toBe(search);
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
});
