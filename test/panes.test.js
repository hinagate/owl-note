import { describe, it, expect } from 'vitest';
import { clampWidth, clampLayoutToContainer, gridColumns, resizeWidth, DEFAULTS, LIMITS } from '../src/app/panes.js';

describe('clampWidth', () => {
  it('clamps to min and max', () => {
    expect(clampWidth(50, 120, 360)).toBe(120);
    expect(clampWidth(400, 120, 360)).toBe(360);
    expect(clampWidth(200, 120, 360)).toBe(200);
  });
});

describe('gridColumns', () => {
  it('builds the 5-track grid normally', () => {
    expect(gridColumns({ sidebarW: 220, noteListW: 300, noteListHidden: false }))
      .toBe('220px 6px 300px 6px 1fr');
  });
  it('collapses the note-list track and its splitter when hidden', () => {
    expect(gridColumns({ sidebarW: 240, noteListW: 300, noteListHidden: true }))
      .toBe('240px 1fr');
  });
});

describe('resizeWidth', () => {
  it('applies the delta within the panel limits', () => {
    const layout = { ...DEFAULTS };
    expect(resizeWidth('sidebar', layout, 50, 1200)).toBe(270);
    expect(resizeWidth('notelist', layout, 50, 1200)).toBe(350);
  });
  it('clamps to the panel max', () => {
    expect(resizeWidth('sidebar', { ...DEFAULTS }, 500, 1200)).toBe(LIMITS.sidebarMax);
  });
  it('backs off to keep the editor at least editorMin on a narrow container', () => {
    // container 700: sidebar grows to 320 would leave editor 700-320-300-12=68 < 320 -> backs off to min
    expect(resizeWidth('sidebar', { ...DEFAULTS }, 100, 700)).toBe(LIMITS.sidebarMin);
  });
  it('uses otherFixed=0 and splitters=6 when the note list is hidden', () => {
    // sidebar grows by 100 -> 320; editor room = 700 - 320 - 0 - 6 = 374 >= 320 -> stays 320
    const layout = { sidebarW: 220, noteListW: 300, noteListHidden: true };
    expect(resizeWidth('sidebar', layout, 100, 700)).toBe(320);
  });
});

describe('clampLayoutToContainer', () => {
  const base = { sidebarW: 220, noteListW: 300, noteListHidden: false, editCollapsed: false };
  it('passes through when containerW is 0 (e.g. jsdom) but still per-panel clamps', () => {
    expect(clampLayoutToContainer({ ...base, sidebarW: 1000, noteListW: 800 }, 0))
      .toMatchObject({ sidebarW: 360, noteListW: 520 });
  });
  it('leaves a comfortable layout unchanged on a wide container', () => {
    expect(clampLayoutToContainer(base, 1600)).toMatchObject({ sidebarW: 220, noteListW: 300 });
  });
  it('shrinks the note-list first to preserve editorMin on a narrow container', () => {
    // 800 - 220 - 300 - 12 = 268 < 320 -> shrink note-list by 52
    expect(clampLayoutToContainer(base, 800)).toMatchObject({ sidebarW: 220, noteListW: 248 });
  });
  it('bottoms out at panel mins on a very narrow container', () => {
    expect(clampLayoutToContainer(base, 600)).toMatchObject({ sidebarW: 120, noteListW: 180 });
  });
});
