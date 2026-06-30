// src/app/note-list.js
export function renderNoteList(container, { notes, activeHandle, onOpen = () => {}, onTogglePin = () => {}, onNew = () => {}, trashView = false, onRestore = () => {}, onDeleteForever = () => {}, onEmptyTrash = () => {}, selected = new Set(), focusIndex = -1, onCardClick = null, onMove = () => {}, onSelectAll = () => {}, onClearSelection = () => {}, onOpenFocused = () => {}, onBatchDelete = () => {}, driveEnabled = false }) {
  // Fall back to onOpen for plain clicks when no modifier-aware handler is provided
  // (maintains backward compat with unit tests that pass onOpen directly).
  const _cardClick = onCardClick ?? ((idx, handle, mod) => { if (!mod.ctrl && !mod.shift) onOpen(handle); });
  container.innerHTML = '';

  if (trashView) {
    const bar = document.createElement('div');
    bar.className = 'trash-bar';
    const empty = document.createElement('button');
    empty.className = 'empty-trash';
    empty.textContent = 'Empty Trash';
    empty.disabled = notes.length === 0;
    empty.addEventListener('click', () => onEmptyTrash());
    bar.appendChild(empty);
    container.appendChild(bar);
    if (!notes.length) {
      const p = document.createElement('p');
      p.className = 'empty';
      p.textContent = 'Trash is empty.';
      container.appendChild(p);
      return;
    }
    for (const n of notes) {
      const handle = n.bookmarkId ?? n.id;
      const card = document.createElement('div');
      card.className = 'item card trashed';
      const title = document.createElement('div');
      title.className = 'card-title';
      title.textContent = n.title || 'Untitled';
      card.appendChild(title);
      if (n.body) {
        const snip = document.createElement('div');
        snip.className = 'card-snippet';
        snip.textContent = snippetOf(n.body);
        card.appendChild(snip);
      }
      const actions = document.createElement('div');
      actions.className = 'trash-actions';
      const restore = document.createElement('button');
      restore.className = 'restore';
      restore.textContent = 'Restore';
      restore.addEventListener('click', (e) => { e.stopPropagation(); onRestore(handle); });
      const del = document.createElement('button');
      del.className = 'delete-forever';
      del.textContent = 'Delete forever';
      del.addEventListener('click', (e) => { e.stopPropagation(); onDeleteForever(handle); });
      actions.append(restore, del);
      card.appendChild(actions);
      container.appendChild(card);
    }
    return;
  }

  const newBtn = document.createElement('button');
  newBtn.className = 'new';
  newBtn.textContent = '+ New note';
  newBtn.addEventListener('click', () => onNew());
  container.appendChild(newBtn);

  container.tabIndex = 0;
  container.onkeydown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); onMove(1, e.shiftKey); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); onMove(-1, e.shiftKey); }
    else if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) { e.preventDefault(); onSelectAll(); }
    else if (e.key === 'Escape') { onClearSelection(); }
    else if (e.key === 'Enter') { e.preventDefault(); onOpenFocused(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); onBatchDelete(); }
  };

  if (selected.size) {
    const status = document.createElement('div');
    status.className = 'select-status';
    status.textContent = `${selected.size} selected · Delete to remove · Esc to clear`;
    container.appendChild(status);
  }

  if (!notes.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'No notes yet.';
    container.appendChild(p);
    return;
  }
  let ndIndex = -1;
  for (const n of notes) {
    const handle = n.bookmarkId ?? n.id;
    if (!n.draft) ndIndex++;
    const index = ndIndex;
    const card = document.createElement('div');
    card.className = 'item card'
      + (handle === activeHandle ? ' active' : '')
      + (n.draft ? ' draft' : '')
      + (n.localOnly ? ' local-only' : '');

    if (!n.draft) {
      card.className += (selected.has(handle) ? ' selected' : '') + (!n.draft && index === focusIndex ? ' focused' : '');
      card.draggable = true;
      card.addEventListener('dragstart', (e) => {
        if (e.dataTransfer) {
          e.dataTransfer.setData('text/plain', String(handle));
          e.dataTransfer.effectAllowed = 'move';
        }
      });
    }

    const title = document.createElement('div');
    title.className = 'card-title';
    title.textContent = n.title || 'Untitled';
    card.appendChild(title);

    if (n.localOnly) {
      const badge = document.createElement('span');
      badge.className = 'badge-local';
      badge.textContent = 'local · not synced';
      title.appendChild(badge);
    } else if (n._driveBody || (n.attachments || []).some((a) => a.driveFileId)) {
      // Uses Google Drive: an over-cap note body and/or image/file attachments stored in Drive.
      const badge = document.createElement('span');
      badge.className = driveEnabled ? 'badge-drive' : 'badge-drive-off';
      if (driveEnabled) {
        const ico = document.createElement('span');
        ico.className = 'owl-cloud-ico'; // crisp cloud glyph (replaces the plain ☁ emoji)
        badge.append(ico, document.createTextNode(' Drive'));
      } else {
        badge.textContent = '⚠ Drive sync off';
      }
      title.appendChild(badge);
    }

    if (n.body) {
      const snippet = document.createElement('div');
      snippet.className = 'card-snippet';
      snippet.textContent = snippetOf(n.body);
      card.appendChild(snippet);
    }

    if (!n.draft) {
      const pin = document.createElement('button');
      pin.type = 'button';
      pin.className = 'pin' + (n.pinned ? ' pinned' : '');
      pin.textContent = '📌';
      pin.title = n.pinned ? 'Unpin' : 'Pin to top';
      pin.addEventListener('click', (e) => { e.stopPropagation(); onTogglePin(handle); });
      card.appendChild(pin);
      card.addEventListener('click', (e) => _cardClick(index, handle, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey }));
    }

    container.appendChild(card);
  }
}

function snippetOf(body) {
  return String(body)
    .replace(/```[\s\S]*?```/g, ' ') // drop fenced code blocks
    .replace(/^#{1,6}\s+/gm, '') // strip heading markers
    .replace(/[*_`~>#-]+/g, ' ') // strip remaining md markers
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}
