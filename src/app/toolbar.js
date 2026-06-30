// src/app/toolbar.js

// Track the active outside-click closer so re-renders don't leak stale listeners.
let _activeCloser = null;

export function renderToolbar(container, { query = '', onSearch, onExportMarkdown, onExportJson, onImport, driveEnabled = false, onToggleDrive = null }) {
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
  search.addEventListener('input', () => onSearch(search.value));

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

  container.append(search, exportWrap, importBtn, importInput);

  // Drive sync opt-in toggle. Rendered only when the app supplies a handler.
  // The checkbox change is a user gesture, which chrome.permissions.request needs:
  // onToggleDrive must reach chrome.permissions.request synchronously (no awaits before it).
  if (onToggleDrive) {
    const driveWrap = document.createElement('label');
    driveWrap.className = 'drive-toggle';
    const driveBox = document.createElement('input');
    driveBox.type = 'checkbox';
    driveBox.className = 'drive-sync';
    driveBox.checked = !!driveEnabled;
    const driveText = document.createElement('span');
    driveText.textContent = 'Sync images & files via Google Drive';
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
