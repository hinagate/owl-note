import { describe, it, expect, beforeEach } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import { initPanes, toggleNoteList, isNoteListHidden, loadLayout, initEditSplitter } from '../src/app/panes.js';

beforeEach(() => {
  installFakeChrome();
  document.body.innerHTML =
    '<div id="panes"><aside id="sidebar"></aside><section id="note-list"></section><main id="editor"></main></div>';
});

describe('panes controller', () => {
  it('injects two splitter handles and applies default columns', async () => {
    await initPanes();
    const panes = document.getElementById('panes');
    expect(panes.querySelectorAll('.splitter')).toHaveLength(2);
    expect(panes.style.gridTemplateColumns).toBe('220px 6px 300px 6px 1fr');
  });

  it('toggleNoteList hides the middle column and flips the flag', async () => {
    await initPanes();
    expect(isNoteListHidden()).toBe(false);
    toggleNoteList();
    expect(isNoteListHidden()).toBe(true);
    const panes = document.getElementById('panes');
    expect(panes.classList.contains('note-list-hidden')).toBe(true);
    expect(panes.style.gridTemplateColumns).toBe('220px 1fr');
  });

  it('a pointer drag on the first splitter resizes the sidebar', async () => {
    await initPanes();
    const s1 = document.querySelector('.splitter-1');
    s1.dispatchEvent(new MouseEvent('pointerdown', { clientX: 100, bubbles: true }));
    s1.dispatchEvent(new MouseEvent('pointermove', { clientX: 150, bubbles: true }));
    s1.dispatchEvent(new MouseEvent('pointerup', { clientX: 150, bubbles: true }));
    // sidebar grew by 50 (220 -> 270); container falls back to 1200 in jsdom (no layout)
    expect(document.getElementById('panes').style.gridTemplateColumns).toBe('270px 6px 300px 6px 1fr');
  });

  it('restores a saved layout from storage', async () => {
    await chrome.storage.local.set({ 'owl:layout': { sidebarW: 200, noteListW: 260, noteListHidden: true, editCollapsed: false } });
    await initPanes();
    expect(isNoteListHidden()).toBe(true);
    expect(document.getElementById('panes').style.gridTemplateColumns).toBe('200px 1fr');
  });

  it('initEditSplitter injects a handle between edit pane and preview with 50/50 default', async () => {
    document.body.innerHTML += '<div class="editor-split"><div class="edit-pane"></div><div class="preview"></div></div>';
    await loadLayout();
    const split = document.querySelector('.editor-split');
    initEditSplitter(split);
    expect(split.children[1].classList.contains('splitter-edit')).toBe(true); // sits between the panes
    expect(split.style.gridTemplateColumns).toBe('0.5fr 6px 0.5fr');
  });

  it('a pointer drag on the edit splitter changes the ratio and persists it', async () => {
    document.body.innerHTML += '<div class="editor-split"><div class="edit-pane"></div><div class="preview"></div></div>';
    await loadLayout();
    const split = document.querySelector('.editor-split');
    initEditSplitter(split);
    const s = split.querySelector('.splitter-edit');
    // container falls back to 1200 in jsdom (no layout): +120px = +0.1 of the width
    s.dispatchEvent(new MouseEvent('pointerdown', { clientX: 600, bubbles: true }));
    s.dispatchEvent(new MouseEvent('pointermove', { clientX: 720, bubbles: true }));
    s.dispatchEvent(new MouseEvent('pointerup', { clientX: 720, bubbles: true }));
    expect(split.style.gridTemplateColumns).toBe('0.6fr 6px 0.4fr');
    await new Promise((r) => setTimeout(r, 300)); // debounced save
    const saved = (await chrome.storage.local.get('owl:layout'))['owl:layout'];
    expect(saved.editSplit).toBeCloseTo(0.6, 5);
  });

  it('restores a saved edit split on the next editor render', async () => {
    await chrome.storage.local.set({ 'owl:layout': { editSplit: 0.7 } });
    document.body.innerHTML += '<div class="editor-split"><div class="edit-pane"></div><div class="preview"></div></div>';
    await loadLayout();
    const split = document.querySelector('.editor-split');
    initEditSplitter(split);
    expect(split.style.gridTemplateColumns).toBe('0.7fr 6px 0.3fr');
  });

  it('clamps the edit split drag so neither pane can collapse', async () => {
    document.body.innerHTML += '<div class="editor-split"><div class="edit-pane"></div><div class="preview"></div></div>';
    await loadLayout();
    const split = document.querySelector('.editor-split');
    initEditSplitter(split);
    const s = split.querySelector('.splitter-edit');
    s.dispatchEvent(new MouseEvent('pointerdown', { clientX: 600, bubbles: true }));
    s.dispatchEvent(new MouseEvent('pointermove', { clientX: -2000, bubbles: true }));
    s.dispatchEvent(new MouseEvent('pointerup', { clientX: -2000, bubbles: true }));
    expect(split.style.gridTemplateColumns).toBe('0.15fr 6px 0.85fr');
  });

  it('exposes the sidebar boundary as --col-sidebar (for the flush hidden-list handle)', async () => {
    await initPanes();
    const panes = document.getElementById('panes');
    expect(panes.style.getPropertyValue('--col-sidebar')).toBe('220px');
    toggleNoteList();
    expect(panes.style.getPropertyValue('--col-sidebar')).toBe('220px'); // still tracks sidebarW when hidden
  });
});
