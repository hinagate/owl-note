// src/app/panes.js — collapsible/resizable pane layout (device-local).
export const DEFAULTS = { sidebarW: 220, noteListW: 300, noteListHidden: false, editCollapsed: false };
export const LIMITS = { sidebarMin: 120, sidebarMax: 360, noteListMin: 180, noteListMax: 520, editorMin: 320 };

export function clampWidth(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// grid-template-columns for the 5-track grid: sidebar | s1 | note-list | s2 | editor.
// When the note list is hidden, its track and the second splitter collapse to 0.
export function gridColumns(layout) {
  const s = `${layout.sidebarW}px`;
  if (layout.noteListHidden) return `${s} 1fr`; // hidden: note-list + both splitters are display:none'd → sidebar butts the editor (no gap)
  return `${s} 6px ${layout.noteListW}px 6px 1fr`;
}

// Clamp persisted widths to the current container so the editor keeps at least editorMin.
// Per-panel clamp first, then (if the editor would starve) shrink the note-list down to its
// min, then the sidebar down to its min. Display-only — callers do NOT auto-save the result.
export function clampLayoutToContainer(layout, containerW, limits = LIMITS) {
  let sidebarW = clampWidth(layout.sidebarW, limits.sidebarMin, limits.sidebarMax);
  let noteListW = layout.noteListHidden
    ? layout.noteListW
    : clampWidth(layout.noteListW, limits.noteListMin, limits.noteListMax);
  if (containerW) {
    const splitters = layout.noteListHidden ? 0 : 12;
    const usedNote = layout.noteListHidden ? 0 : noteListW;
    let deficit = limits.editorMin - (containerW - sidebarW - usedNote - splitters);
    if (deficit > 0 && !layout.noteListHidden) {
      const shrink = Math.min(deficit, noteListW - limits.noteListMin);
      noteListW -= shrink; deficit -= shrink;
    }
    if (deficit > 0) {
      const shrink = Math.min(deficit, sidebarW - limits.sidebarMin);
      sidebarW -= shrink; deficit -= shrink;
    }
  }
  return { ...layout, sidebarW, noteListW };
}

// New width for a dragged splitter. `which` is 'sidebar' | 'notelist'. Clamps to the
// panel's own min/max, then backs off so the editor keeps at least editorMin.
export function resizeWidth(which, layout, dx, containerW, limits = LIMITS) {
  const cur = which === 'sidebar' ? layout.sidebarW : layout.noteListW;
  const min = which === 'sidebar' ? limits.sidebarMin : limits.noteListMin;
  const max = which === 'sidebar' ? limits.sidebarMax : limits.noteListMax;
  let next = clampWidth(cur + dx, min, max);
  const otherFixed = which === 'sidebar'
    ? (layout.noteListHidden ? 0 : layout.noteListW)
    : layout.sidebarW;
  const splitters = layout.noteListHidden ? 0 : 12;
  const editorRoom = containerW - next - otherFixed - splitters;
  if (editorRoom < limits.editorMin) next -= (limits.editorMin - editorRoom);
  return Math.max(min, next);
}

const LAYOUT_KEY = 'owl:layout';
let layout = { ...DEFAULTS };
let saveTimer = null;

export async function loadLayout() {
  try {
    const got = await chrome.storage.local.get(LAYOUT_KEY);
    layout = { ...DEFAULTS, ...(got && got[LAYOUT_KEY]) };
  } catch { layout = { ...DEFAULTS }; }
  return layout;
}

function saveLayout() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { chrome.storage.local.set({ [LAYOUT_KEY]: layout }); } catch { /* best-effort */ } }, 200);
}

export function isNoteListHidden() { return layout.noteListHidden; }
export function isEditCollapsed() { return layout.editCollapsed; }

export function applyEditCollapse() {
  const split = document.querySelector('.editor-split');
  if (split) split.classList.toggle('edit-collapsed', layout.editCollapsed);
}

function applyLayout() {
  const panes = document.getElementById('panes');
  if (!panes) return;
  panes.style.gridTemplateColumns = gridColumns(layout);
  panes.style.setProperty('--col-sidebar', `${layout.sidebarW}px`); // boundary for the flush hidden-list handle
  panes.classList.toggle('note-list-hidden', layout.noteListHidden);
  applyEditCollapse();
}

export function toggleNoteList() { layout.noteListHidden = !layout.noteListHidden; applyLayout(); saveLayout(); }
export function toggleEditPane() { layout.editCollapsed = !layout.editCollapsed; applyEditCollapse(); saveLayout(); }

function startDrag(e, which, el) {
  e.preventDefault();
  const panes = document.getElementById('panes');
  const startX = e.clientX;
  const startW = which === 'sidebar' ? layout.sidebarW : layout.noteListW;
  el.setPointerCapture?.(e.pointerId);
  document.body.classList.add('resizing');
  const move = (ev) => {
    const dx = ev.clientX - startX;
    const containerW = panes.clientWidth || 1200; // jsdom has no layout -> fallback
    const base = { ...layout, [which === 'sidebar' ? 'sidebarW' : 'noteListW']: startW };
    const next = resizeWidth(which, base, dx, containerW, LIMITS);
    if (which === 'sidebar') layout.sidebarW = next; else layout.noteListW = next;
    applyLayout();
  };
  const up = (ev) => {
    el.releasePointerCapture?.(ev.pointerId);
    document.body.classList.remove('resizing');
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    saveLayout();
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
}

function makeSplitter(which, cls) {
  const el = document.createElement('div');
  el.className = `splitter ${cls}`;
  el.addEventListener('pointerdown', (e) => startDrag(e, which, el));
  return el;
}

export async function initPanes() {
  const panes = document.getElementById('panes');
  if (!panes) return; // e.g. unit-test DOM without #panes — no-op
  await loadLayout();
  const cw = panes.clientWidth;
  if (cw) layout = clampLayoutToContainer(layout, cw);
  if (!panes.querySelector('.splitter')) {
    const sidebar = document.getElementById('sidebar');
    const noteList = document.getElementById('note-list');
    sidebar.after(makeSplitter('sidebar', 'splitter-1'));
    noteList.after(makeSplitter('notelist', 'splitter-2'));
  }
  applyLayout();
}
