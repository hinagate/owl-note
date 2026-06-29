// src/app/sidebar.js
import { buildNotebookTree } from '../lib/notebook-tree.js';

export function renderSidebar(
  container,
  {
    rootId, notebooks, activeId, collapsed = new Set(),
    onSelect, onNewNotebook, onRenameNotebook, onDeleteNotebook,
    onDropNote, onMoveNotebook, onToggleCollapse,
    trashId, trashCount = 0, trashActive = false, onOpenTrash = () => {},
  },
) {
  container.innerHTML = '';

  // A drop target accepts both a note (text/plain = bookmarkId) and a dragged
  // notebook (application/x-owl-notebook = folder id, for re-nesting).
  const makeDropTarget = (el, folderId) => {
    el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drop-target'); });
    el.addEventListener('dragleave', (e) => {
      if (!el.contains(e.relatedTarget)) el.classList.remove('drop-target'); // ignore moves onto child nodes
    });
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drop-target');
      const nbId = e.dataTransfer && e.dataTransfer.getData('application/x-owl-notebook');
      if (nbId) { if (onMoveNotebook) onMoveNotebook(nbId, folderId); return; }
      const bookmarkId = e.dataTransfer && e.dataTransfer.getData('text/plain');
      if (bookmarkId && bookmarkId !== '__draft__' && onDropNote) onDropNote(folderId, bookmarkId);
    });
  };

  const allRow = document.createElement('div');
  allRow.className = 'item' + (rootId === activeId ? ' active' : '');
  allRow.textContent = 'All notes (root)';
  allRow.addEventListener('click', () => onSelect(rootId));
  makeDropTarget(allRow, rootId); // drop a note or a notebook here → moves it to the top level
  container.appendChild(allRow);

  // ASCII-tree connector: each ancestor contributes "│  " (its subtree continues)
  // or "   " (it was the last child), then "├─"/"└─" for this node. Rendered in a
  // monospace span so the connectors line up. The expand/collapse toggle is a
  // SEPARATE, larger control (see below) rather than a tiny char in this string.
  const connectorText = (ancestorLasts, isLast) => {
    let s = '';
    for (const last of ancestorLasts) s += last ? '   ' : '│  ';
    s += isLast ? '└─' : '├─';
    return s;
  };

  const renderNode = (node, ancestorLasts, isLast) => {
    const hasKids = node.children.length > 0;
    const isCollapsed = collapsed.has(node.id);
    const row = document.createElement('div');
    row.className = 'item folder' + (node.id === activeId ? ' active' : '');
    row.draggable = true;
    row.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-owl-notebook', node.id);
      e.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('click', () => onSelect(node.id));

    // Light monospace connectors for structure + a separate, prominent toggle.
    const guideWrap = document.createElement('span');
    guideWrap.className = 'nb-guidewrap';
    const guide = document.createElement('span');
    guide.className = 'nb-guide';
    guide.textContent = connectorText(ancestorLasts, isLast);
    guideWrap.appendChild(guide);
    const toggle = document.createElement('span');
    toggle.className = 'nb-toggle' + (hasKids ? '' : ' leaf');
    if (hasKids) {
      toggle.textContent = isCollapsed ? '▶' : '▼';
      toggle.title = isCollapsed ? 'Expand' : 'Collapse';
      toggle.addEventListener('click', (e) => { e.stopPropagation(); if (onToggleCollapse) onToggleCollapse(node.id); });
    }
    guideWrap.appendChild(toggle);
    row.appendChild(guideWrap);

    const label = document.createElement('span');
    label.className = 'nb-label';
    label.textContent = node.title;
    row.appendChild(label);

    if (onRenameNotebook) {
      const rename = document.createElement('button');
      rename.className = 'nb-rename';
      rename.title = 'Rename notebook';
      rename.textContent = '✏️';
      rename.addEventListener('click', (e) => { e.stopPropagation(); onRenameNotebook(node.id, node.title); });
      row.appendChild(rename);
      label.addEventListener('dblclick', (e) => { e.stopPropagation(); onRenameNotebook(node.id, node.title); });
    }

    if (onDeleteNotebook) {
      const del = document.createElement('button');
      del.className = 'nb-delete';
      del.title = 'Delete notebook';
      del.textContent = '🗑';
      del.addEventListener('click', (e) => { e.stopPropagation(); onDeleteNotebook(node.id); });
      row.appendChild(del);
    }

    makeDropTarget(row, node.id);
    container.appendChild(row);

    if (hasKids && !isCollapsed) {
      node.children.forEach((c, i) => renderNode(c, [...ancestorLasts, isLast], i === node.children.length - 1));
    }
  };
  const tops = buildNotebookTree(notebooks, rootId);
  tops.forEach((t, i) => renderNode(t, [], i === tops.length - 1));

  const btn = document.createElement('button');
  btn.className = 'new-notebook';
  btn.textContent = '+ Notebook';
  btn.addEventListener('click', onNewNotebook);
  container.appendChild(btn);

  const trash = document.createElement('div');
  trash.className = 'item trash-row' + (trashActive ? ' active' : '');
  trash.innerHTML = `<span class="nb-label">🗑 Trash</span><span class="trash-count">${trashCount || ''}</span>`;
  trash.addEventListener('click', () => onOpenTrash());
  container.appendChild(trash);
}
