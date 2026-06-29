import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderSidebar } from '../src/app/sidebar.js';

beforeEach(() => { document.body.innerHTML = '<aside id="sidebar"></aside>'; });

describe('sidebar', () => {
  it('renders notebooks and fires onSelect', () => {
    const onSelect = vi.fn();
    const el = document.getElementById('sidebar');
    renderSidebar(el, {
      rootId: 'r', activeId: 'nb1',
      notebooks: [{ id: 'nb1', title: 'Code Base', parentId: 'r' }, { id: 'nb2', title: 'Recipes', parentId: 'r' }],
      onSelect, onNewNotebook: vi.fn(),
    });
    const rows = el.querySelectorAll('.item');
    // "All notes" + 2 notebooks + trash row
    expect(rows).toHaveLength(4);
    expect(el.querySelector('.item.active').textContent).toContain('Code Base');
    rows[2].click();
    expect(onSelect).toHaveBeenCalledWith('nb2');
  });

  it('renders a delete control per notebook and fires onDeleteNotebook without selecting', () => {
    const onSelect = vi.fn();
    const onDeleteNotebook = vi.fn();
    const el = document.getElementById('sidebar');
    renderSidebar(el, {
      rootId: 'r', activeId: 'r',
      notebooks: [{ id: 'nb1', title: 'Code Base', parentId: 'r' }],
      onSelect, onNewNotebook: vi.fn(), onDeleteNotebook,
    });
    const del = el.querySelector('.nb-delete');
    expect(del).not.toBeNull();
    del.click();
    expect(onDeleteNotebook).toHaveBeenCalledWith('nb1');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('omits delete controls when onDeleteNotebook is not provided', () => {
    const el = document.getElementById('sidebar');
    renderSidebar(el, {
      rootId: 'r', activeId: 'r',
      notebooks: [{ id: 'nb1', title: 'Code Base', parentId: 'r' }],
      onSelect: vi.fn(), onNewNotebook: vi.fn(),
    });
    expect(el.querySelector('.nb-delete')).toBeNull();
  });

  it('renders a rename control per notebook and fires onRenameNotebook(id, title) without selecting', () => {
    const onSelect = vi.fn();
    const onRenameNotebook = vi.fn();
    const el = document.getElementById('sidebar');
    renderSidebar(el, {
      rootId: 'r', activeId: 'r',
      notebooks: [{ id: 'nb1', title: 'Code Base', parentId: 'r' }],
      onSelect, onNewNotebook: vi.fn(), onRenameNotebook,
    });
    const rename = el.querySelector('.nb-rename');
    expect(rename).not.toBeNull();
    rename.click();
    expect(onRenameNotebook).toHaveBeenCalledWith('nb1', 'Code Base');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('double-clicking a notebook label fires onRenameNotebook', () => {
    const onRenameNotebook = vi.fn();
    const el = document.getElementById('sidebar');
    renderSidebar(el, {
      rootId: 'r', activeId: 'r',
      notebooks: [{ id: 'nb1', title: 'Recipes', parentId: 'r' }],
      onSelect: vi.fn(), onNewNotebook: vi.fn(), onRenameNotebook,
    });
    el.querySelector('.nb-label').dispatchEvent(new Event('dblclick', { bubbles: true }));
    expect(onRenameNotebook).toHaveBeenCalledWith('nb1', 'Recipes');
  });

  it('omits rename controls when onRenameNotebook is not provided', () => {
    const el = document.getElementById('sidebar');
    renderSidebar(el, {
      rootId: 'r', activeId: 'r',
      notebooks: [{ id: 'nb1', title: 'Code Base', parentId: 'r' }],
      onSelect: vi.fn(), onNewNotebook: vi.fn(),
    });
    expect(el.querySelector('.nb-rename')).toBeNull();
  });

  it('accepts a note dropped onto a notebook and calls onDropNote(folderId, bookmarkId)', () => {
    const onDropNote = vi.fn();
    const el = document.getElementById('sidebar');
    renderSidebar(el, {
      rootId: 'r', activeId: 'r',
      notebooks: [{ id: 'nb1', title: 'Code Base', parentId: 'r' }],
      onSelect: vi.fn(), onNewNotebook: vi.fn(), onDropNote,
    });
    const row = el.querySelector('.item.folder');
    const ev = new Event('drop', { bubbles: true });
    ev.dataTransfer = { getData: (k) => (k === 'text/plain' ? 'b1' : '') };
    let prevented = false;
    ev.preventDefault = () => { prevented = true; };
    row.dispatchEvent(ev);
    expect(prevented).toBe(true);
    expect(onDropNote).toHaveBeenCalledWith('nb1', 'b1');
  });

  it('the All notes row is a drop target back to the root folder', () => {
    const onDropNote = vi.fn();
    const el = document.getElementById('sidebar');
    renderSidebar(el, {
      rootId: 'r', activeId: 'nb1',
      notebooks: [{ id: 'nb1', title: 'X', parentId: 'r' }],
      onSelect: vi.fn(), onNewNotebook: vi.fn(), onDropNote,
    });
    const allRow = el.querySelector('.item'); // first .item is "All notes"
    const ev = new Event('drop', { bubbles: true });
    ev.dataTransfer = { getData: (k) => (k === 'text/plain' ? 'b2' : '') };
    ev.preventDefault = () => {};
    allRow.dispatchEvent(ev);
    expect(onDropNote).toHaveBeenCalledWith('r', 'b2');
  });

  it('ignores a dropped draft placeholder', () => {
    const onDropNote = vi.fn();
    const el = document.getElementById('sidebar');
    renderSidebar(el, {
      rootId: 'r', activeId: 'r',
      notebooks: [{ id: 'nb1', title: 'X', parentId: 'r' }],
      onSelect: vi.fn(), onNewNotebook: vi.fn(), onDropNote,
    });
    const row = el.querySelector('.item.folder');
    const ev = new Event('drop', { bubbles: true });
    ev.dataTransfer = { getData: (k) => (k === 'text/plain' ? '__draft__' : '') };
    ev.preventDefault = () => {};
    row.dispatchEvent(ev);
    expect(onDropNote).not.toHaveBeenCalled();
  });
});

describe('nested notebooks', () => {
  const make = (extra) => {
    const el = document.getElementById('sidebar');
    renderSidebar(el, {
      rootId: 'r', activeId: 'r',
      notebooks: [
        { id: 'a', title: 'A', parentId: 'r' },
        { id: 'a1', title: 'A1', parentId: 'a' },
        { id: 'b', title: 'B', parentId: 'r' },
      ],
      onSelect: vi.fn(), onNewNotebook: vi.fn(), ...extra,
    });
    return el;
  };

  const guideOf = (folder) => folder.querySelector('.nb-guide').textContent;

  it('draws ASCII connectors: a chevron on parents, none on leaves, children deeper', () => {
    const el = make({ collapsed: new Set() });
    const folders = [...el.querySelectorAll('.item.folder')];
    expect(folders.map((f) => f.querySelector('.nb-label').textContent)).toEqual(['A', 'A1', 'B']);
    expect(guideOf(folders[0])).toContain('▾');                 // A is an expanded parent
    expect(/[▸▾]/.test(guideOf(folders[2]))).toBe(false);       // B is a leaf — no chevron
    expect(guideOf(folders[1]).length).toBeGreaterThan(guideOf(folders[0]).length); // child guide is longer (deeper)
    expect(guideOf(folders[1])).toContain('│'); // A still has a sibling (B), so the child shows a continuation bar
  });

  it('clicking a parent connector toggles collapse, not select', () => {
    const onToggleCollapse = vi.fn();
    const onSelect = vi.fn();
    const el = make({ collapsed: new Set(), onToggleCollapse, onSelect });
    el.querySelector('.item.folder .nb-guide').click(); // first folder = A (a parent)
    expect(onToggleCollapse).toHaveBeenCalledWith('a');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('hides children of a collapsed notebook and shows a ▸ marker', () => {
    const el = make({ collapsed: new Set(['a']) });
    expect([...el.querySelectorAll('.item.folder .nb-label')].map((l) => l.textContent)).toEqual(['A', 'B']);
    expect(el.querySelector('.item.folder .nb-guide').textContent).toContain('▸');
  });

  it('dropping a notebook onto another calls onMoveNotebook(child, target)', () => {
    const onMoveNotebook = vi.fn();
    const el = make({ collapsed: new Set(), onMoveNotebook });
    const b = [...el.querySelectorAll('.item.folder')].find((f) => f.querySelector('.nb-label').textContent === 'B');
    const ev = new Event('drop', { bubbles: true });
    ev.dataTransfer = { getData: (k) => (k === 'application/x-owl-notebook' ? 'a' : '') };
    ev.preventDefault = () => {};
    b.dispatchEvent(ev);
    expect(onMoveNotebook).toHaveBeenCalledWith('a', 'b');
  });
});
