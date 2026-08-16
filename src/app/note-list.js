// src/app/note-list.js
import { relativeTime } from '../lib/relative-time.js';

export function renderNoteList(container, { notes, activeHandle, onOpen = () => {}, onTogglePin = () => {}, onNew = () => {}, trashView = false, onRestore = () => {}, onDeleteForever = () => {}, onEmptyTrash = () => {}, selected = new Set(), focusIndex = -1, onCardClick = null, onMove = () => {}, onSelectAll = () => {}, onClearSelection = () => {}, onOpenFocused = () => {}, onBatchDelete = () => {}, driveEnabled = false, query = '', onAsk = null }) {
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
      const empty = document.createElement('div');
      empty.className = 'empty';
      const p = document.createElement('p');
      if (String(query).trim()) {
        p.textContent = 'No keyword matches. Try Ask Owl for semantic search.';
        empty.appendChild(p);
        if (onAsk) {
          const ask = document.createElement('button');
          ask.type = 'button';
          ask.className = 'empty-ask';
          ask.textContent = '🦉 Ask Owl';
          ask.addEventListener('click', () => onAsk());
          empty.appendChild(ask);
        }
      } else {
        p.textContent = 'Trash is empty.';
        empty.appendChild(p);
      }
      container.appendChild(empty);
      return;
    }
    for (const n of notes) {
      const handle = n.bookmarkId ?? n.id;
      const card = document.createElement('div');
      card.className = 'item card trashed';
      // Trashed cards used to render with no click handler at all, so a note in Trash
      // could only ever be judged by its title and a 100-character snippet — not enough
      // to choose between Restore and Delete forever. Opening is read-only (app.js).
      card.tabIndex = 0;
      card.setAttribute('role', 'button');
      card.addEventListener('click', () => onOpen(handle));
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(handle); }
      });
      const title = document.createElement('div');
      title.className = 'card-title';
      // Same structure as a live card: the text truncates in its own span so the age
      // chip beside it (flex:none) can never be clipped away by a long title.
      const titleText = document.createElement('span');
      titleText.className = 'card-title-text';
      titleText.textContent = n.title || 'Untitled';
      title.appendChild(titleText);
      // How stale the note is — the question behind "can I delete this forever?".
      // Runs to years, unlike the editor's stamp: here "8 months ago" is the answer,
      // where a date would have to be worked out against today.
      const stamp = n.updated ?? n.created ?? n.dateAdded;
      const age = relativeTime(stamp, Date.now(), { maxUnit: 'year' });
      if (age) {
        const badge = document.createElement('span');
        badge.className = 'badge-age';
        const ico = document.createElement('span');
        ico.className = 'owl-clock-ico';
        badge.append(ico, document.createTextNode(' ' + age));
        const exact = new Date(stamp);
        if (!Number.isNaN(exact.getTime())) badge.title = `Last edited ${exact.toLocaleString()}`;
        title.appendChild(badge);
      }
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
    const empty = document.createElement('div');
    empty.className = 'empty';
    const p = document.createElement('p');
    if (String(query).trim()) {
      p.textContent = 'No keyword matches. Try Ask Owl for semantic search.';
      empty.appendChild(p);
      if (onAsk) {
        const ask = document.createElement('button');
        ask.type = 'button';
        ask.className = 'empty-ask';
        ask.textContent = '🦉 Ask Owl';
        ask.addEventListener('click', () => onAsk());
        empty.appendChild(ask);
      }
    } else {
      p.textContent = 'No notes yet.';
      empty.appendChild(p);
    }
    container.appendChild(empty);
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
    // Lets the open path move the selection outline the instant a card is clicked,
    // without waiting for the note to load and the list to be rebuilt around it.
    card.dataset.handle = String(handle);

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
    // The title text lives in its OWN span that truncates; the sync badge below is a
    // sibling flex item (flex:none) so a long title can never clip the badge away
    // (UI audit: users couldn't tell a long-titled note's sync state).
    const titleText = document.createElement('span');
    titleText.className = 'card-title-text';
    titleText.textContent = n.title || 'Untitled';
    title.appendChild(titleText);
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

    // When the note was last touched, as its own quiet line under the snippet. A live
    // card has room for it and recency is how people scan their own notes; the trashed
    // card puts the same fact in a title chip instead, because there it sits beside
    // Restore / Delete forever and needs to read at a glance, not as prose.
    // Skipped for the unsaved draft, which has no timestamp to speak of yet.
    if (!n.draft) {
      const stamp = n.updated ?? n.created ?? n.dateAdded;
      const age = relativeTime(stamp, Date.now(), { maxUnit: 'year' });
      if (age) {
        const when = document.createElement('div');
        when.className = 'card-when';
        when.textContent = `Edited ${age}`;
        const exact = new Date(stamp);
        if (!Number.isNaN(exact.getTime())) when.title = `Last edited ${exact.toLocaleString()}`;
        card.appendChild(when);
      }
    }

    if (!n.draft && !n.locked) {
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
