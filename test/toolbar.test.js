import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderToolbar } from '../src/app/toolbar.js';

beforeEach(() => { document.body.innerHTML = '<div id="toolbar"></div>'; });

const opts = (over) => ({ query: '', onSearch: vi.fn(), onExportMarkdown: vi.fn(), onExportJson: vi.fn(), onImport: vi.fn(), ...over });

describe('toolbar', () => {
  it('fires the search callback', () => {
    const onSearch = vi.fn();
    const el = document.getElementById('toolbar');
    renderToolbar(el, opts({ onSearch }));
    expect(el.querySelector('button.new')).toBeNull(); // New-note button moved to the note list
    const input = el.querySelector('input.search');
    input.value = 'pasta';
    input.dispatchEvent(new Event('input'));
    expect(onSearch).toHaveBeenCalledWith('pasta');
  });

  // Export is now every way of writing notes to a file, this note first, each label
  // stating its scope. Previously the two all-notes items were indistinguishable and
  // the per-note one lived under Share, where nobody would look for it.
  it('Export dropdown offers this note and both all-notes files, and fires the chosen one', () => {
    const onExportNote = vi.fn(); const onExportMarkdown = vi.fn(); const onExportJson = vi.fn();
    const el = document.getElementById('toolbar');
    const api = renderToolbar(el, opts({ onExportNote, onExportMarkdown, onExportJson }));
    const exportBtn = [...el.querySelectorAll('button')].find((b) => b.textContent.includes('Export'));
    exportBtn.click();
    const item = (text) => [...el.querySelectorAll('.menu-item')].find((b) => b.textContent === text);
    expect([...el.querySelectorAll('.menu-item')].map((b) => b.textContent))
      .toEqual(['This note (.owl-note)', 'All notes as Markdown (.zip)', 'All notes + keys (JSON backup)']);

    api.setNoteExportEnabled(true);
    item('This note (.owl-note)').click();
    expect(onExportNote).toHaveBeenCalled();
    expect(el.querySelector('.menu').hidden).toBe(true);

    exportBtn.click();
    item('All notes as Markdown (.zip)').click();
    expect(onExportMarkdown).toHaveBeenCalled();

    exportBtn.click();
    item('All notes + keys (JSON backup)').click();
    expect(onExportJson).toHaveBeenCalled();
  });

  // The toolbar is not rebuilt when the open note changes, so the per-note item is
  // toggled through the returned api instead of by re-rendering.
  it('leaves the per-note export disabled until a note is open', () => {
    const onExportNote = vi.fn();
    const el = document.getElementById('toolbar');
    const api = renderToolbar(el, opts({ onExportNote }));
    const item = () => [...el.querySelectorAll('.menu-item')].find((b) => b.textContent === 'This note (.owl-note)');
    expect(item().disabled).toBe(true);
    api.setNoteExportEnabled(true);
    expect(item().disabled).toBe(false);
    api.setNoteExportEnabled(false);
    expect(item().disabled).toBe(true);
  });

  it('Import accepts supported formats (multiple) and passes selected files to onImport', () => {
    const onImport = vi.fn();
    const el = document.getElementById('toolbar');
    renderToolbar(el, opts({ onImport }));
    const input = el.querySelector('input[type="file"]');
    expect(input.accept).toBe('.owl-note,.json,.zip,.md,.enex,.docx');
    expect(input.multiple).toBe(true);
    const f = new File(['x'], 'a.md', { type: 'text/markdown' });
    Object.defineProperty(input, 'files', { value: [f], configurable: true });
    input.dispatchEvent(new Event('change'));
    expect(onImport).toHaveBeenCalledWith([f]);
    expect(input.value).toBe('');
  });

  it('renders the Drive sync toggle only when a handler is supplied', () => {
    const el = document.getElementById('toolbar');
    renderToolbar(el, opts());
    expect(el.querySelector('input.drive-sync')).toBeNull();
    renderToolbar(el, opts({ driveEnabled: true, onToggleDrive: vi.fn() }));
    const box = el.querySelector('input.drive-sync');
    expect(box).not.toBeNull();
    expect(box.checked).toBe(true); // reflects isEnabled() state on load
    expect(el.querySelector('.drive-toggle .owl-cloud-ico')).not.toBeNull(); // cloud glyph on the label
    expect(el.querySelector('.drive-toggle').textContent).toContain('compatible with Google Drive');
  });

  it('renders no typeahead dropdown — the filtered note list is the sole result surface', () => {
    // The search box live-filters the note list (via onSearch); it must NOT also float a
    // duplicate suggestion layer over that list (user-reported "duplicate result layer").
    const onSearch = vi.fn();
    const el = document.getElementById('toolbar');
    renderToolbar(el, opts({ onSearch }));
    const input = el.querySelector('input.search');
    input.value = 'pasta';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('focus'));
    expect(onSearch).toHaveBeenCalledWith('pasta'); // list filtering still happens
    expect(el.querySelector('.search-suggest')).toBeNull(); // …but no floating dropdown exists
  });

  it('fires onToggleDrive on change and reverts the box to the resolved state', async () => {
    const onToggleDrive = vi.fn(async () => false); // consent declined -> stays off
    const el = document.getElementById('toolbar');
    renderToolbar(el, opts({ driveEnabled: false, onToggleDrive }));
    const box = el.querySelector('input.drive-sync');
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    expect(onToggleDrive).toHaveBeenCalledWith(true);
    await new Promise((r) => setTimeout(r)); // let the async change handler settle
    expect(box.checked).toBe(false); // reverted because enable() resolved false
  });

  it('places Ask Owl at the far-right edge and fires its handler', () => {
    const onAsk = vi.fn();
    const el = document.getElementById('toolbar');
    renderToolbar(el, opts({ onAsk, onToggleDrive: vi.fn() }));
    const ask = el.querySelector('.ask-owl-button');
    expect(el.lastElementChild).toBe(ask);
    ask.click();
    expect(onAsk).toHaveBeenCalledTimes(1);
  });
});
