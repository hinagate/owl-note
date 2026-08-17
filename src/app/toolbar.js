// src/app/toolbar.js

// Track the active outside-click closer so re-renders don't leak stale listeners.
let _activeCloser = null;

export function renderToolbar(container, { query = '', onSearch, onExportNote, onExportMarkdown, onExportKey, onImport, onImportKey, driveEnabled = false, onToggleDrive = null, onAsk = null }) {
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
  menu.className = 'menu export-menu';
  menu.hidden = true;
  // Every way of turning notes into a file lives here, this note first, so
  // "Export" always means "write a file" and Share is only ever "send this to
  // someone". Each label states its scope: the two were previously indistinguishable
  // and the per-note one was filed under Share, where nobody would look for it.
  const noteItem = document.createElement('button');
  noteItem.className = 'menu-item';
  noteItem.textContent = 'This note (.owl-note)';
  noteItem.disabled = true; // no note open yet; app.js enables it per note
  noteItem.addEventListener('click', () => { menu.hidden = true; onExportNote?.(); });
  const mdItem = document.createElement('button');
  mdItem.className = 'menu-item';
  mdItem.textContent = 'All notes as Markdown (.zip)';
  mdItem.addEventListener('click', () => { menu.hidden = true; onExportMarkdown(); });
  // The keys, and only the keys. They used to ride inside a whole-notes JSON backup,
  // which bundled the one genuinely secret file together with the notes and made it
  // look like the authoritative restore — while actually holding a SUBSET of them.
  // Separated so the note exports above are safe to hand around and this one is
  // obviously the file to guard.
  const keyItem = document.createElement('button');
  keyItem.className = 'menu-item';
  keyItem.textContent = 'Recovery key (.json)';
  keyItem.title = 'The keys that unlock your notes. Keep this private.';
  keyItem.addEventListener('click', () => { menu.hidden = true; onExportKey(); });
  menu.append(noteItem, mdItem, keyItem);
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

  // Import mirrors Export: notes, and the key, as separate deliberate actions.
  // Installing a decryption key from another install is not the same kind of act as
  // loading notes, and hiding it inside a general "Import" that happened to notice a
  // keyring in the file made it both undiscoverable and silent.
  const importWrap = document.createElement('div');
  importWrap.className = 'menu-wrap';
  const importBtn = document.createElement('button');
  importBtn.textContent = 'Import ▾';
  const importMenu = document.createElement('div');
  importMenu.className = 'menu import-menu';
  importMenu.hidden = true;

  const importInput = document.createElement('input');
  importInput.type = 'file';
  importInput.accept = '.owl-note,.json,.zip,.md,.enex,.docx';
  importInput.multiple = true;
  importInput.style.display = 'none';
  importInput.addEventListener('change', () => {
    if (importInput.files.length) onImport([...importInput.files]);
    importInput.value = ''; // allow re-importing the same file
  });

  const keyInput = document.createElement('input');
  keyInput.type = 'file';
  keyInput.accept = '.json';
  keyInput.style.display = 'none';
  keyInput.addEventListener('change', () => {
    if (keyInput.files.length) onImportKey?.(keyInput.files[0]);
    keyInput.value = '';
  });

  const notesItem = document.createElement('button');
  notesItem.className = 'menu-item';
  notesItem.textContent = 'Notes (.zip, .md, .owl-note, .json…)';
  notesItem.addEventListener('click', () => { importMenu.hidden = true; importInput.click(); });
  const keyItemIn = document.createElement('button');
  keyItemIn.className = 'menu-item';
  keyItemIn.textContent = 'Recovery key (.json)';
  keyItemIn.title = 'Unlock notes written by another OWL-Note installation.';
  keyItemIn.addEventListener('click', () => { importMenu.hidden = true; keyInput.click(); });
  importMenu.append(notesItem, keyItemIn);

  importBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = importMenu.hidden;
    importMenu.hidden = !willOpen;
    if (willOpen) {
      const closer = (ev) => {
        if (importWrap.contains(ev.target)) return;
        importMenu.hidden = true;
        document.removeEventListener('click', closer);
        if (_activeCloser === closer) _activeCloser = null;
      };
      _activeCloser = closer;
      setTimeout(() => document.addEventListener('click', closer), 0);
    }
  });
  importWrap.append(importBtn, importMenu, importInput, keyInput);

  container.append(searchWrap, exportWrap, importWrap);
  // The toolbar is not rebuilt when the open note changes, so the per-note item is
  // toggled through this rather than re-rendered — same shape as the editor's
  // setShareActionVisible.
  const api = { setNoteExportEnabled: (on) => { noteItem.disabled = !on; } };

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

  return api;
}
