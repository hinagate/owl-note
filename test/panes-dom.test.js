import { describe, it, expect, beforeEach } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import { initPanes, toggleNoteList, isNoteListHidden, loadLayout } from '../src/app/panes.js';

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

  it('exposes the sidebar boundary as --col-sidebar (for the flush hidden-list handle)', async () => {
    await initPanes();
    const panes = document.getElementById('panes');
    expect(panes.style.getPropertyValue('--col-sidebar')).toBe('220px');
    toggleNoteList();
    expect(panes.style.getPropertyValue('--col-sidebar')).toBe('220px'); // still tracks sidebarW when hidden
  });
});
