// src/app/toolbar.js

// Track the active outside-click closer so re-renders don't leak stale listeners.
let _activeCloser = null;

export function renderToolbar(container, { query = '', onSearch, onExportMarkdown, onExportJson, onImport, driveEnabled = false, onToggleDrive = null, onAsk = null }) {
  // Clean up any stale document listener from a previous render.
  if (_activeCloser) {
    document.removeEventListener('click', _activeCloser);
    _activeCloser = null;
  }

  container.innerHTML = '';

  // The search box LIVE-FILTERS the note list (via onSearch → refreshNoteList). There is
  // deliberately NO typeahead dropdown: an earlier one floated the same matches over the
  // already-filtered list, so users saw every hit twice ("duplicate result layer"). The
  // filtered list is the single result surface.
  const search = document.createElement('input');
  search.className = 'search';
  search.placeholder = 'Search notes…';
  search.value = query;
  search.addEventListener('input', () => onSearch(search.value));

  const searchWrap = document.createElement('div');
  searchWrap.className = 'search-wrap';
  searchWrap.append(search);

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

  // Import (smart: .owl-note / .json / .zip / .md / .enex / .docx)
  const importInput = document.createElement('input');
  importInput.type = 'file';
  importInput.accept = '.owl-note,.json,.zip,.md,.enex,.docx';
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

  // "Ask your notes" drawer opener. Build it here, but append it LAST below so it
  // owns the toolbar's right margin even when the optional Drive control is present.
  let askBtn = null;
  if (onAsk) {
    askBtn = document.createElement('button');
    askBtn.className = 'ask-owl-button';
    askBtn.textContent = '🦉 Ask Owl';
    askBtn.title = 'Ask Owl';
    askBtn.addEventListener('click', () => onAsk());
  }

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
    driveBox.setAttribute('aria-label', 'Sync Large Notes & Attachments compatible with Google Drive'); // a11y without label-click
    const driveText = document.createElement('span');
    const cloudIco = document.createElement('span');
    cloudIco.className = 'owl-cloud-ico'; // crisp cloud glyph (replaces the plain ☁ emoji)
    driveText.append(cloudIco, document.createTextNode(' Sync Large Notes & Attachments compatible with Google Drive'));
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

  if (askBtn) container.append(askBtn);
}
