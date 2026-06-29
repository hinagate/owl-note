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

  it('Export dropdown offers Markdown and JSON and fires the chosen one', () => {
    const onExportMarkdown = vi.fn(); const onExportJson = vi.fn();
    const el = document.getElementById('toolbar');
    renderToolbar(el, opts({ onExportMarkdown, onExportJson }));
    const exportBtn = [...el.querySelectorAll('button')].find((b) => b.textContent.includes('Export'));
    exportBtn.click();
    const items = [...el.querySelectorAll('.menu-item')].map((b) => b.textContent);
    expect(items).toEqual(['Markdown (.zip)', 'JSON backup']);
    [...el.querySelectorAll('.menu-item')].find((b) => b.textContent === 'Markdown (.zip)').click();
    expect(onExportMarkdown).toHaveBeenCalled();
    expect(el.querySelector('.menu').hidden).toBe(true);
    exportBtn.click();
    [...el.querySelectorAll('.menu-item')].find((b) => b.textContent === 'JSON backup').click();
    expect(onExportJson).toHaveBeenCalled();
  });

  it('Import accepts .json,.zip,.md (multiple) and passes selected files to onImport', () => {
    const onImport = vi.fn();
    const el = document.getElementById('toolbar');
    renderToolbar(el, opts({ onImport }));
    const input = el.querySelector('input[type="file"]');
    expect(input.accept).toBe('.json,.zip,.md,.enex,.docx');
    expect(input.multiple).toBe(true);
    const f = new File(['x'], 'a.md', { type: 'text/markdown' });
    Object.defineProperty(input, 'files', { value: [f], configurable: true });
    input.dispatchEvent(new Event('change'));
    expect(onImport).toHaveBeenCalledWith([f]);
    expect(input.value).toBe('');
  });
});
