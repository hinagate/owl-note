// src/app/sidebar.js
export function renderSidebar(
  container,
  { rootId, notebooks, activeId, onSelect, onNewNotebook, onRenameNotebook, onDeleteNotebook, onDropNote, trashId, trashCount = 0, trashActive = false, onOpenTrash = () => {} },
) {
  container.innerHTML = '';

  const makeDropTarget = (el, folderId) => {
    if (!onDropNote) return;
    el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drop-target'); });
    el.addEventListener('dragleave', (e) => {
      if (!el.contains(e.relatedTarget)) el.classList.remove('drop-target'); // ignore moves onto child nodes
    });
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drop-target');
      const bookmarkId = e.dataTransfer && e.dataTransfer.getData('text/plain');
      if (bookmarkId && bookmarkId !== '__draft__') onDropNote(folderId, bookmarkId);
    });
  };

  const allRow = document.createElement('div');
  allRow.className = 'item' + (rootId === activeId ? ' active' : '');
  allRow.textContent = 'All notes';
  allRow.addEventListener('click', () => onSelect(rootId));
  makeDropTarget(allRow, rootId);
  container.appendChild(allRow);

  for (const nb of notebooks) {
    const row = document.createElement('div');
    row.className = 'item folder' + (nb.id === activeId ? ' active' : '');
    row.addEventListener('click', () => onSelect(nb.id));

    const label = document.createElement('span');
    label.className = 'nb-label';
    label.textContent = nb.title;
    row.appendChild(label);

    if (onRenameNotebook) {
      const rename = document.createElement('button');
      rename.className = 'nb-rename';
      rename.title = 'Rename notebook';
      rename.textContent = '✏️';
      rename.addEventListener('click', (e) => { e.stopPropagation(); onRenameNotebook(nb.id, nb.title); });
      row.appendChild(rename);
      // Double-click the name itself — the familiar rename gesture.
      label.addEventListener('dblclick', (e) => { e.stopPropagation(); onRenameNotebook(nb.id, nb.title); });
    }

    if (onDeleteNotebook) {
      const del = document.createElement('button');
      del.className = 'nb-delete';
      del.title = 'Delete notebook';
      del.textContent = '🗑';
      del.addEventListener('click', (e) => { e.stopPropagation(); onDeleteNotebook(nb.id); });
      row.appendChild(del);
    }

    makeDropTarget(row, nb.id);
    container.appendChild(row);
  }

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
