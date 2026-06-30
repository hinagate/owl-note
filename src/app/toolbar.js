// src/app/toolbar.js

// Track the active outside-click closer so re-renders don't leak stale listeners.
let _activeCloser = null;

export function renderToolbar(container, { query = '', onSearch, onSuggest = null, onPickSuggestion = null, onExportMarkdown, onExportJson, onImport, driveEnabled = false, onToggleDrive = null }) {
  // Clean up any stale document listener from a previous render.
  if (_activeCloser) {
    document.removeEventListener('click', _activeCloser);
    _activeCloser = null;
  }

  container.innerHTML = '';

  const search = document.createElement('input');
  search.className = 'search';
  search.placeholder = 'Search notes…';
  search.value = query;

  // Auto-suggest (typeahead): a dropdown of the top matching notes under the search box.
  const searchWrap = document.createElement('div');
  searchWrap.className = 'search-wrap';
  const suggestBox = document.createElement('div');
  suggestBox.className = 'search-suggest';
  suggestBox.hidden = true;
  searchWrap.append(search, suggestBox);

  let sItems = [];
  let sActive = -1;
  function renderSuggest() {
    suggestBox.innerHTML = '';
    if (!sItems.length) { suggestBox.hidden = true; return; }
    sItems.forEach((it, i) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'suggest-item' + (i === sActive ? ' active' : '');
      const t = document.createElement('div'); t.className = 'suggest-title'; t.textContent = it.title;
      row.appendChild(t);
      if (it.snippet) { const s = document.createElement('div'); s.className = 'suggest-snippet'; s.textContent = it.snippet; row.appendChild(s); }
      row.addEventListener('mousedown', (e) => { e.preventDefault(); pickSuggest(it); }); // mousedown fires before blur
      suggestBox.appendChild(row);
    });
    suggestBox.hidden = false;
  }
  function updateSuggest() {
    sItems = (onSuggest && search.value.trim()) ? onSuggest(search.value) : [];
    sActive = -1;
    renderSuggest();
  }
  function closeSuggest() { sItems = []; sActive = -1; renderSuggest(); }
  function pickSuggest(it) { closeSuggest(); if (onPickSuggestion) onPickSuggestion(it.handle); }

  search.addEventListener('input', () => { onSearch(search.value); updateSuggest(); });
  search.addEventListener('keydown', (e) => {
    if (!sItems.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); sActive = Math.min(sActive + 1, sItems.length - 1); renderSuggest(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sActive = Math.max(sActive - 1, 0); renderSuggest(); }
    else if (e.key === 'Enter' && sActive >= 0) { e.preventDefault(); pickSuggest(sItems[sActive]); }
    else if (e.key === 'Escape') { e.preventDefault(); closeSuggest(); }
  });
  search.addEventListener('blur', () => setTimeout(closeSuggest, 120)); // let a suggestion click land first
  search.addEventListener('focus', () => { if (search.value.trim()) updateSuggest(); });

  // Export ▾ dropdown
  const exportWrap = document.createElement('div');
  exportWrap.className = 'menu-wrap';
  const exportBtn = document.createElement('button');
  exportBtn.textContent = 'Export ▾';
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.hidden = true;
  const mdItem = document.createElement('button');
  mdItem.className = 'menu-item';
  mdItem.textContent = 'Markdown (.zip)';
  mdItem.addEventListener('click', () => { menu.hidden = true; onExportMarkdown(); });
  const jsonItem = document.createElement('button');
  jsonItem.className = 'menu-item';
  jsonItem.textContent = 'JSON backup';
  jsonItem.addEventListener('click', () => { menu.hidden = true; onExportJson(); });
  menu.append(mdItem, jsonItem);
  exportBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = menu.hidden;
    menu.hidden = !willOpen;
    if (willOpen) {
      const closer = () => {
        menu.hidden = true;
        document.removeEventListener('click', closer);
        if (_activeCloser === closer) _activeCloser = null;
      };
      _activeCloser = closer;
      setTimeout(() => document.addEventListener('click', closer), 0); // close on the next outside click
    }
  });
  exportWrap.append(exportBtn, menu);

  // Import (smart: .json / .zip / .md / .enex / .docx)
  const importInput = document.createElement('input');
  importInput.type = 'file';
  importInput.accept = '.json,.zip,.md,.enex,.docx';
  importInput.multiple = true;
  importInput.style.display = 'none';
  importInput.addEventListener('change', () => {
    if (importInput.files.length) onImport([...importInput.files]);
    importInput.value = ''; // allow re-importing the same file
  });
  const importBtn = document.createElement('button');
  importBtn.textContent = 'Import';
  importBtn.addEventListener('click', () => importInput.click());

  container.append(searchWrap, exportWrap, importBtn, importInput);

  // Drive sync opt-in toggle. Rendered only when the app supplies a handler.
  // The checkbox change is a user gesture, which chrome.permissions.request needs:
  // onToggleDrive must reach chrome.permissions.request synchronously (no awaits before it).
  if (onToggleDrive) {
    const driveWrap = document.createElement('div'); // NOT a <label> — clicking the text must not toggle it
    driveWrap.className = 'drive-toggle';
    const driveBox = document.createElement('input');
    driveBox.type = 'checkbox';
    driveBox.className = 'drive-sync';
    driveBox.checked = !!driveEnabled;
    driveBox.setAttribute('aria-label', 'Sync large notes & attachments via Google Drive'); // a11y without label-click
    const driveText = document.createElement('span');
    driveText.textContent = 'Sync large notes & attachments via Google Drive';
    driveBox.addEventListener('change', async () => {
      driveBox.disabled = true;
      try {
        const next = await onToggleDrive(driveBox.checked); // resolves to the real enabled state
        driveBox.checked = !!next; // revert if the user cancelled consent / denied the permission
      } finally {
        driveBox.disabled = false;
      }
    });
    driveWrap.append(driveBox, driveText);
    container.append(driveWrap);
  }
}
