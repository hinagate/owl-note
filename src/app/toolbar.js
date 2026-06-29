// src/app/toolbar.js

// Track the active outside-click closer so re-renders don't leak stale listeners.
let _activeCloser = null;

export function renderToolbar(container, { query = '', onSearch, onExportMarkdown, onExportJson, onImport }) {
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
}
