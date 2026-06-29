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

  const renderNode = (node, depth) => {
    const row = document.createElement('div');
    row.className = 'item folder' + (node.id === activeId ? ' active' : '');
    row.style.paddingLeft = `${10 + depth * 14}px`; // indent by depth
    row.draggable = true;
    row.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-owl-notebook', node.id);
      e.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('click', () => onSelect(node.id));

    const hasKids = node.children.length > 0;
    const twisty = document.createElement('span');
    twisty.className = 'nb-twisty' + (hasKids ? '' : ' leaf');
    if (hasKids) {
      twisty.textContent = collapsed.has(node.id) ? '▸' : '▾';
      twisty.addEventListener('click', (e) => { e.stopPropagation(); if (onToggleCollapse) onToggleCollapse(node.id); });
    }
    row.appendChild(twisty);

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

    if (hasKids && !collapsed.has(node.id)) {
      for (const child of node.children) renderNode(child, depth + 1);
    }
  };
  for (const top of buildNotebookTree(notebooks, rootId)) renderNode(top, 0);

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
