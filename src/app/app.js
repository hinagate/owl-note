import * as bm from '../lib/bookmarks.js';
import * as mirror from '../lib/mirror.js';
import { encode, decode, selfTest } from '../lib/codec.js';
import { createNote, withUpdatedContent, contentHash, extractTitle, withPinned, orderNotes } from '../lib/note.js';
import { renderSidebar } from './sidebar.js';
import { renderNoteList } from './note-list.js';
import { renderEditor } from './editor.js';
import { initPanes } from './panes.js';
import { renderToolbar } from './toolbar.js';
import { searchNotes } from '../lib/search.js';
import { zipFiles } from '../lib/zip.js';
import { buildMarkdownExport } from '../lib/markdown-export.js';
import { unzip } from '../lib/unzip.js';
import { parseMarkdownNote } from '../lib/markdown-import.js';
import { parseEnexNotes } from '../lib/enex-import.js';
import { downscaleImagesInBody } from '../lib/image-downscale.js';
import { extractImages, inlineImages } from '../lib/note-images.js';
import { docxToMarkdown } from '../lib/docx-import.js';
import { saveNote, urlByteLength, MAX_URL_BYTES, WARN_URL_BYTES } from '../lib/save-note.js';
import { ensureTrash, trashNotes, restoreNotes, deleteForever } from '../lib/trash.js';
import { rangeHandles } from '../lib/list-selection.js';
import { isSelfOrDescendant } from '../lib/notebook-tree.js';
import { offloadShape } from '../lib/attachment-store.js';
import * as noteDrive from '../lib/note-drive.js';
import { isEnabled, enable, disable } from '../lib/drive-sync.js';

export { saveNote, MAX_URL_BYTES, WARN_URL_BYTES }; // moved to ../lib/save-note.js

// The bytes a note WOULD occupy in its bookmark, after Drive offload. With sync on,
// attachments become small references, so the meter reflects what actually syncs.
// Uses the PURE offloadShape (no upload) — this runs on every keystroke.
export async function measuredBytes(note) {
  const enabled = (await chrome.storage.local.get('drive:enabled'))['drive:enabled'];
  const toSave = enabled ? offloadShape(note) : note;
  return urlByteLength(await encode(toSave));
}

// Measure what this note will actually cost in its bookmark URL — the same
// compressed bytes the save path caps — so the editor can show it live.
async function measureNoteSize({ title, body, attachments = [] }) {
  const note = ui.current && ui.activeBookmarkId
    ? withUpdatedContent(ui.current, { title, body, attachments })
    : createNote({ title, body, attachments });
  return { bytes: await measuredBytes(note), warn: WARN_URL_BYTES, max: MAX_URL_BYTES };
}

export async function dropNote(handle, folderId) {
  if (await mirror.isLocalOnly(handle)) await mirror.setFolder(handle, folderId);
  else await bm.moveNote(handle, folderId);
}

export function toast(message, isWarn = false) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.className = isWarn ? 'warn' : '';
  el.hidden = false;
  setTimeout(() => { el.hidden = true; }, 3000);
}

// Turn Drive attachment sync on/off from the toolbar checkbox. Runs inside the
// checkbox's change handler (a user gesture) so enable() can call
// chrome.permissions.request. Returns the resulting enabled state so the toolbar
// can revert the box if consent is cancelled/denied. NOTE: the first-run consent
// copy uses confirm() — synchronous, so it does NOT spend the gesture before
// enable() reaches chrome.permissions.request.
export async function toggleDriveSync(checked) {
  try {
    if (checked) {
      const ok = confirm(
        'Sync large notes & attachments via Google Drive?\n\n'
        + 'Notes too large to sync as bookmarks, plus image and file attachments, will be '
        + "stored in an 'OWL-Note Attachments' folder in your Google Drive so they sync "
        + 'across your devices. You will be asked to grant access, and can turn this off at any time.',
      );
      if (!ok) { toast('Drive sync not enabled.'); return false; } // user declined consent — leave sync off
      await enable();
      toast('Google Drive sync on');
      return true;
    }
    // Disabling — warn that attachments will stop syncing.
    const offOk = confirm(
      'Turn off Google Drive sync?\n\n'
      + 'New large notes, photos, and files will no longer sync across your devices — '
      + 'they will stay only on this device. Files already in your Drive are kept.',
    );
    if (!offOk) return await isEnabled(); // changed mind — keep it on (toolbar re-checks the box)
    await disable();
    toast('⚠ Drive sync off — new large notes, photos & files won’t sync across devices', true);
    return false;
  } catch (err) {
    // permission denied, consent window cancelled, or auth failed — reflect reality
    console.warn('Google Drive sync not enabled:', err);
    const m = String((err && err.message) || '');
    const cancelled = /did not approve|access_denied|denied|cancel|closed|interaction_required/i.test(m);
    toast(cancelled ? '⚠ Google Drive sync cancelled — not enabled.' : `⚠ Couldn't enable Drive sync${m ? ': ' + m : ''}`, true);
    return await isEnabled();
  }
}

const recentIds = []; // ids of notes created this session — float to the top until reload (in-memory)

const ui = { rootId: null, trashId: null, activeFolder: null, activeBookmarkId: null, activeLocalId: null, activeLocalFolderId: null, current: null, editor: null, query: '', notes: [], notebooks: [], collapsed: new Set(), hashWired: false, isNew: false, selected: new Set(), anchor: null, focus: -1 };

export function resetUI() {
  ui.rootId = null;
  ui.trashId = null;
  ui.activeFolder = null;
  ui.activeBookmarkId = null;
  ui.activeLocalId = null;
  ui.activeLocalFolderId = null;
  ui.current = null;
  if (ui.editor && ui.editor.destroy) ui.editor.destroy();
  ui.editor = null;
  ui.query = '';
  ui.notes = [];
  ui.notebooks = [];
  ui.collapsed = new Set();
  ui.hashWired = false;
  ui.isNew = false;
  ui.selected = new Set(); ui.anchor = null; ui.focus = -1;
}

export async function initUI(rootId) {
  ui.rootId = rootId;
  ui.activeFolder = rootId;
  ui.trashId = await ensureTrash(rootId);
  // Per-device sidebar collapse state (bookmark ids differ per device, so don't sync it).
  const storedCollapsed = (await chrome.storage.local.get('owl:collapsed'))['owl:collapsed'];
  ui.collapsed = new Set(Array.isArray(storedCollapsed) ? storedCollapsed : []);
  // Repair notes whose bookmark URL embeds an old/foreign extension id (e.g. created
  // by an unpacked dev build) so clicking them opens this extension instead of being
  // blocked by Chrome. No-op once every note already uses the current id.
  try { await bm.healNoteUrls(rootId); } catch { /* best-effort; never block boot */ }
  await initPanes();
  await refreshPanes();
  renderCurrentEditor();
  await openByHash();
  if (!ui.hashWired) {
    window.addEventListener('hashchange', openByHash);
    // Flush a pending auto-save when the tab is hidden/closed — focus can stay in the
    // textarea on a tab switch, so the blur flush alone won't always catch it.
    document.addEventListener('visibilitychange', () => { if (document.hidden) ui.editor?.flush?.(); });
    ui.hashWired = true;
  }
  wireLiveRefresh();
}

export async function loadNotes(folderId) {
  const raw = folderId === ui.rootId ? await bm.allNotes(ui.rootId) : await bm.listNotes(folderId);
  const visible = folderId === ui.trashId ? raw : raw.filter((r) => r.folderId !== ui.trashId);
  const decoded = [];
  const seen = new Set();
  for (const r of visible) {
    try {
      const note = await decode(r.payload);
      // A Drive-backed (over-cap) note keeps only a short preview in the bookmark. On the
      // device that wrote it the local mirror still holds the full body — use that so the
      // note is fully searchable here; other devices fall back to the synced preview.
      let body = note.body;
      if (note._driveBody) {
        const backup = await mirror.getBackup(note.id);
        body = (backup && backup.current && backup.current.body !== undefined && backup.current.hash === note.hash)
          ? backup.current.body
          : (note.preview || '');
      }
      decoded.push({ ...note, body, bookmarkId: r.bookmarkId, folderId: r.folderId || folderId, dateAdded: r.dateAdded });
      if (note.id) seen.add(note.id);
    } catch { /* skip malformed */ }
  }
  for (const ln of await mirror.localOnlyBackups(folderId)) {
    if (!seen.has(ln.id)) { decoded.push(ln); seen.add(ln.id); }
  }
  return decoded;
}

const DRAFT_ID = '__draft__';

async function refreshNoteList() {
  const inTrash = ui.activeFolder === ui.trashId;
  let notes = await loadNotes(ui.activeFolder);
  ui.allNotes = notes; // full unfiltered set for the active folder — search-bar suggestions use this
  if (ui.query) notes = searchNotes(notes, ui.query);
  const list = orderNotes(notes, recentIds);
  const isDraft = ui.isNew && ui.current && !ui.activeBookmarkId && !ui.query;
  if (isDraft) {
    list.unshift({ bookmarkId: DRAFT_ID, title: ui.current.title || 'New note', body: ui.current.body, draft: true });
  }
  ui.notes = list;
  const H = list.filter((n) => !n.draft).map((n) => n.bookmarkId ?? n.id);
  // drop selections whose notes are gone (e.g. after an external refresh)
  const Hset = new Set(H);
  ui.selected = new Set([...ui.selected].filter((h) => Hset.has(h)));
  renderNoteList(document.getElementById('note-list'), {
    notes: list,
    activeHandle: ui.activeBookmarkId ?? ui.activeLocalId ?? (isDraft ? DRAFT_ID : null),
    onOpen: (handle) => {
      if (handle === DRAFT_ID) return;
      const note = (ui.notes || []).find((n) => (n.bookmarkId ?? n.id) === handle);
      if (note && note.localOnly) openLocalNote(note.id);
      else openBookmark(handle);
    },
    onTogglePin: (handle) => togglePin(handle),
    onNew: () => newNote(),
    trashView: inTrash,
    onRestore: (handle) => trashAction('restore', handle),
    onDeleteForever: (handle) => trashAction('deleteForever', handle),
    onEmptyTrash: () => trashAction('empty'),
    selected: ui.selected,
    focusIndex: ui.focus,
    onCardClick: (index, handle, mod) => onCardClick(H, index, handle, mod),
    onMove: (dir, shift) => onMove(H, dir, shift),
    onSelectAll: () => { ui.selected = new Set(H); refreshNoteList(); },
    onClearSelection: () => { ui.selected = new Set(); refreshNoteList(); },
    onOpenFocused: () => { if (H[ui.focus]) openHandle(H[ui.focus]); },
    onBatchDelete: () => batchTrash(),
  });
}

function openHandle(handle) {
  const note = (ui.notes || []).find((n) => (n.bookmarkId ?? n.id) === handle);
  if (note && note.localOnly) openLocalNote(note.id);
  else openBookmark(handle);
}

function onCardClick(H, index, handle, mod) {
  if (mod.ctrl) {
    if (ui.selected.has(handle)) ui.selected.delete(handle); else ui.selected.add(handle);
    ui.anchor = index; ui.focus = index; refreshNoteList();
  } else if (mod.shift) {
    ui.selected = new Set(rangeHandles(H, ui.anchor ?? index, index));
    ui.focus = index; refreshNoteList();
  } else {
    ui.selected = new Set(); ui.anchor = index; ui.focus = index;
    refreshNoteList();
    openHandle(handle);
  }
}

function onMove(H, dir, shift) {
  if (!H.length) return;
  const start = ui.focus < 0 ? 0 : ui.focus;
  const next = Math.max(0, Math.min(H.length - 1, start + dir));
  if (shift) {
    ui.selected = new Set([...ui.selected, ...rangeHandles(H, ui.anchor ?? start, next)]);
  } else {
    ui.selected = new Set(); ui.anchor = next;
  }
  ui.focus = next;
  refreshNoteList();
  const el = document.querySelector('#note-list .item.focused');
  if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
}

async function batchTrash() {
  if (!ui.selected.size) return;
  const targets = (ui.notes || []).filter((n) => !n.draft && ui.selected.has(n.bookmarkId ?? n.id));
  if (!targets.length) return;
  if (!confirm(`Move ${targets.length} note(s) to Trash?`)) return;
  await trashNotes(targets, ui.trashId);
  if (ui.current && targets.some((t) => t.id === ui.current.id)) {
    ui.current = null; ui.activeBookmarkId = null; ui.activeLocalId = null; renderCurrentEditor();
  }
  ui.selected = new Set(); ui.anchor = null; ui.focus = -1;
  await refreshPanes();
  toast(`${targets.length} note(s) moved to Trash`);
}

async function trashAction(kind, handle) {
  const items = (ui.notes || []).filter((n) => !n.draft);
  const targets = kind === 'empty' ? items : items.filter((n) => (n.bookmarkId ?? n.id) === handle);
  if (!targets.length) return;
  if (kind === 'restore') { await restoreNotes(targets, ui.rootId); toast('Restored'); }
  else {
    if (kind === 'empty' && !confirm(`Permanently delete ${targets.length} note(s)? This cannot be undone.`)) return;
    if (kind === 'deleteForever' && !confirm('Permanently delete this note? This cannot be undone.')) return;
    await deleteForever(targets);
    toast(kind === 'empty' ? 'Trash emptied' : 'Deleted');
  }
  if (ui.current && targets.some((t) => t.id === ui.current.id)) {
    ui.current = null; ui.activeBookmarkId = null; ui.activeLocalId = null; renderCurrentEditor();
  }
  await refreshPanes();
}

// Keep the note list live: re-render when bookmarks change outside the app's own
// actions — the "Save selection" context menu, another tab, or sync from another
// device. Coalesces bursts without a timer (if a refresh is running, run one more).
let liveRefreshing = false;
let liveRefreshQueued = false;
async function liveRefreshNoteList() {
  if (!ui.rootId) return; // not booted (or reset between tests)
  if (liveRefreshing) { liveRefreshQueued = true; return; }
  liveRefreshing = true;
  try {
    do {
      liveRefreshQueued = false;
      await refreshNoteList();
    } while (liveRefreshQueued);
  } finally {
    liveRefreshing = false;
  }
}

function wireLiveRefresh() {
  const c = typeof chrome !== 'undefined' ? chrome : undefined;
  if (!c || !c.bookmarks) return;
  c.bookmarks.onCreated?.addListener(liveRefreshNoteList);
  c.bookmarks.onChanged?.addListener(liveRefreshNoteList);
  c.bookmarks.onRemoved?.addListener(liveRefreshNoteList);
}

async function persistCollapsed() {
  try { await chrome.storage.local.set({ 'owl:collapsed': [...ui.collapsed] }); } catch { /* best-effort */ }
}

async function refreshPanes() {
  ui.notebooks = await bm.listNotebooks(ui.rootId); // cached for the editor breadcrumb (sync path lookup)
  const notebooks = ui.notebooks.filter((nb) => nb.id !== ui.trashId);
  const trashCount = (await loadNotes(ui.trashId)).length;
  renderSidebar(document.getElementById('sidebar'), {
    rootId: ui.rootId,
    notebooks,
    activeId: ui.activeFolder,
    collapsed: ui.collapsed,
    onSelect: async (id) => { ui.selected = new Set(); ui.anchor = null; ui.focus = -1; ui.activeFolder = id; await refreshPanes(); },
    onNewNotebook: async () => {
      const title = prompt('Notebook name?');
      if (!title) return;
      // Create under the selected notebook (a sub-notebook), or at the top level
      // when "All notes (root)" or Trash is selected.
      const parent = (ui.activeFolder && ui.activeFolder !== ui.trashId) ? ui.activeFolder : ui.rootId;
      const id = await bm.createNotebook(parent, title);
      if (parent !== ui.rootId) { expandToReveal(parent); await persistCollapsed(); } // reveal the new child + its ancestors
      ui.activeFolder = id; // select + focus the new notebook immediately
      await refreshPanes();
    },
    onRenameNotebook: (id, current) => renameNotebook(id, current),
    onDeleteNotebook: (id) => deleteNotebook(id),
    onDropNote: async (folderId, bookmarkId) => {
      await dropNote(bookmarkId, folderId);
      await refreshPanes();
      toast('Note moved');
    },
    onMoveNotebook: async (childId, newParentId) => {
      if (childId === newParentId) return;
      if (isSelfOrDescendant(ui.notebooks, childId, newParentId)) { toast("Can't move a notebook into itself", true); return; }
      await bm.moveNotebook(childId, newParentId);
      if (newParentId !== ui.rootId) { expandToReveal(newParentId); await persistCollapsed(); } // reveal the moved notebook + ancestors
      await refreshPanes();
      refreshEditorIfFolderAffected(childId); // the open note's breadcrumb path may have changed
      toast('Notebook moved');
    },
    onToggleCollapse: async (id) => {
      if (ui.collapsed.has(id)) ui.collapsed.delete(id); else ui.collapsed.add(id);
      await persistCollapsed();
      await refreshPanes();
    },
    trashId: ui.trashId,
    trashCount,
    trashActive: ui.activeFolder === ui.trashId,
    onOpenTrash: async () => { ui.selected = new Set(); ui.anchor = null; ui.focus = -1; ui.activeFolder = ui.trashId; await refreshPanes(); },
  });
  renderToolbar(document.getElementById('toolbar'), {
    query: ui.query,
    onSearch: async (q) => { ui.selected = new Set(); ui.anchor = null; ui.focus = -1; ui.query = q; await refreshNoteList(); },
    onSuggest: (q) => searchNotes(ui.allNotes || [], q).slice(0, 6).map((n) => ({
      handle: n.bookmarkId ?? n.id,
      title: n.title || 'Untitled',
      snippet: (n.body || '').replace(/\s+/g, ' ').trim().slice(0, 80),
    })),
    onPickSuggestion: (handle) => openHandle(handle),
    onExportMarkdown: () => doExportMarkdown(),
    onExportJson: doExport,
    onImport: (files) => doImportFiles(files),
    driveEnabled: await isEnabled(),
    onToggleDrive: (checked) => toggleDriveSync(checked),
  });
  await refreshNoteList();
  // Editor is intentionally NOT re-rendered here. It is rendered only by
  // initUI, newNote, openBookmark, and openByHash, so sidebar/search
  // interactions never clobber in-progress edits or steal search focus.
}

// Build the clickable notebook path (root → the note's folder) for the editor breadcrumb.
function folderPath(folderId) {
  if (folderId === ui.trashId) return [{ id: ui.trashId, title: '🗑 Trash' }];
  const byId = new Map((ui.notebooks || []).map((n) => [n.id, n]));
  const chain = [];
  let cur = folderId;
  while (cur && cur !== ui.rootId && byId.has(cur)) {
    chain.unshift({ id: cur, title: byId.get(cur).title });
    cur = byId.get(cur).parentId;
  }
  chain.unshift({ id: ui.rootId, title: bm.ROOT_TITLE });
  return chain;
}

async function navigateToFolder(id) {
  // Guard against a stale breadcrumb crumb pointing at a deleted folder — fall back
  // to root instead of letting chrome.bookmarks throw "Can't find bookmark for id".
  if (id !== ui.rootId && id !== ui.trashId) {
    try { const [n] = await chrome.bookmarks.get(id); if (!n || n.url) id = ui.rootId; } catch { id = ui.rootId; }
  }
  ui.selected = new Set(); ui.anchor = null; ui.focus = -1;
  ui.activeFolder = id;
  await refreshPanes();
}

// Un-collapse a folder and all its ancestors so a child placed there is visible.
function expandToReveal(folderId) {
  const byId = new Map((ui.notebooks || []).map((n) => [n.id, n]));
  let cur = folderId;
  while (cur && cur !== ui.rootId) { ui.collapsed.delete(cur); cur = byId.get(cur)?.parentId; }
}

// Re-render the editor (refreshing its breadcrumb) only when the open note's folder
// chain includes `folderId` — e.g. after that notebook is renamed or re-nested.
function refreshEditorIfFolderAffected(folderId) {
  if (!ui.current) return;
  const openFolder = ui.activeLocalId ? ui.activeLocalFolderId : ui.current.folderId;
  if (openFolder && isSelfOrDescendant(ui.notebooks, folderId, openFolder)) renderCurrentEditor();
}

function renderCurrentEditor(opts = {}) {
  const noteFolderId = ui.activeLocalId
    ? (ui.activeLocalFolderId ?? ui.activeFolder)
    : (ui.current?.folderId ?? ui.activeFolder);
  if (ui.editor && ui.editor.destroy) ui.editor.destroy(); // cancel the prior editor's pending auto-save
  ui.editor = renderEditor(document.getElementById('editor'), {
    title: ui.current ? ui.current.title : '',
    body: ui.current ? ui.current.body : '',
    attachments: ui.current ? (ui.current.attachments || []) : [],
    focusTitle: !!opts.focusTitle,
    measure: measureNoteSize,
    onChange: ({ title, body, attachments }) => {
      if (ui.current) { ui.current.title = title; ui.current.body = body; ui.current.attachments = attachments; }
    },
    onSave: async ({ title, body, attachments }, { auto = false } = {}) => {
      const existing = ui.current && (ui.activeBookmarkId || ui.activeLocalId);
      const note = existing
        ? withUpdatedContent(ui.current, { title, body, attachments })
        : createNote({ title, body, attachments });
      if (!existing) recentIds.unshift(note.id);
      const folder = ui.activeLocalId
        ? (ui.activeLocalFolderId ?? ui.activeFolder)
        : (ui.activeFolder === ui.rootId ? ui.rootId : ui.activeFolder);
      const res = await saveNote(note, folder, ui.activeBookmarkId);
      ui.current = note;
      ui.activeBookmarkId = res.bookmarkId;
      ui.activeLocalId = res.bookmarkId ? null : note.id;
      ui.activeLocalFolderId = res.bookmarkId ? null : folder;
      ui.isNew = false;
      // Auto-saves stay quiet — the editor's inline status confirms them and the size
      // meter already flags oversized notes. Only manual saves pop a toast.
      if (!auto) {
        if (res.status === 'capped') toast('Too large to sync — saved locally only', true);
        else if (res.status === 'synced') toast('Saved — large note synced via Drive');
        else if (res.status === 'warn') toast('Large note — may not sync across devices', true);
        else toast('Saved');
      }
      // Auto-save only needs the list (snippet/title) refreshed, not the whole shell.
      if (auto) await refreshNoteList();
      else await refreshPanes();
    },
    onDelete: ui.current ? () => deleteCurrentNote() : null,
    breadcrumb: ui.current ? folderPath(noteFolderId) : [],
    onNavigate: (id) => navigateToFolder(id),
  });
}

async function deleteCurrentNote() {
  if (!ui.current) return;
  const saved = ui.activeBookmarkId || ui.activeLocalId;
  if (saved) {
    if (!confirm('Move this note to Trash?')) return;
    await trashNotes([{
      id: ui.current.id,
      bookmarkId: ui.activeBookmarkId || null,
      folderId: ui.activeLocalId ? (ui.activeLocalFolderId ?? ui.activeFolder) : ui.activeFolder,
      localOnly: !!ui.activeLocalId,
    }], ui.trashId);
  } else if (!confirm('Discard this unsaved note?')) {
    return;
  }
  ui.current = null;
  ui.activeBookmarkId = null;
  ui.activeLocalId = null;
  renderCurrentEditor();
  await refreshPanes();
  toast(saved ? 'Moved to Trash' : 'Discarded');
}

async function renameNotebook(id, current) {
  const title = prompt('Rename notebook', current ?? '');
  if (title == null) return; // cancelled
  const trimmed = title.trim();
  if (!trimmed || trimmed === current) return; // empty or unchanged — nothing to do
  await bm.renameFolder(id, trimmed);
  await refreshPanes();
  refreshEditorIfFolderAffected(id); // update the open note's breadcrumb if it shows this notebook
  toast('Notebook renamed');
}

async function deleteNotebook(id) {
  const hasSubs = (ui.notebooks || []).some((nb) => nb.id !== id && isSelfOrDescendant(ui.notebooks, id, nb.id));
  const msg = hasSubs
    ? 'Delete this notebook, its sub-notebooks, and all their notes? This cannot be undone.'
    : 'Delete this notebook and all its notes? This cannot be undone.';
  if (!confirm(msg)) return;
  const notes = await bm.allNotes(id);
  const deleted = new Set(notes.map((n) => n.bookmarkId));
  for (const n of notes) {
    try {
      const note = await decode(n.payload);
      if (note._driveBody) { try { await noteDrive.deleteNoteBody(note._driveBody); } catch { /* best-effort */ } }
      await mirror.removeBackup(note.id);
    } catch { /* skip malformed */ }
  }
  // Does the open note live in the deleted subtree? Covers bookmark notes (by id) and
  // local-only notes (by folder), so a deleted folder can't linger in the breadcrumb.
  // Computed before deleteFolder, while ui.notebooks still reflects the old tree.
  const openFolder = ui.activeLocalId ? ui.activeLocalFolderId : (ui.current && ui.current.folderId);
  const openNoteDeleted = (ui.activeBookmarkId && deleted.has(ui.activeBookmarkId))
    || (openFolder && (openFolder === id || isSelfOrDescendant(ui.notebooks, id, openFolder)));
  const activeInSubtree = ui.activeFolder === id || (ui.activeFolder && isSelfOrDescendant(ui.notebooks, id, ui.activeFolder));
  await bm.deleteFolder(id);
  if (activeInSubtree) ui.activeFolder = ui.rootId;
  if (openNoteDeleted) {
    ui.current = null;
    ui.activeBookmarkId = null;
    ui.activeLocalId = null;
    ui.activeLocalFolderId = null;
    renderCurrentEditor();
  }
  await refreshPanes();
  toast('Notebook deleted');
}

function newNote() {
  ui.current = createNote({ title: 'New note', body: '' });
  ui.activeBookmarkId = null;
  ui.activeLocalId = null;
  ui.isNew = true;
  renderCurrentEditor({ focusTitle: true });
  refreshNoteList();
}

async function openLocalNote(id) {
  const backup = await mirror.getBackup(id);
  if (!backup || !backup.current) return;
  ui.current = backup.current;
  ui.activeBookmarkId = null;
  ui.activeLocalId = id;
  ui.activeLocalFolderId = backup.folderId ?? null;
  ui.isNew = false;
  renderCurrentEditor();
  await refreshNoteList();
}

// Resolve a (possibly Drive-backed) note to its full body. For a stub, prefer the local
// mirror when it holds the same content (origin device — no fetch), else pull the full
// payload from Drive. Falls back to the preview if Drive is unreachable, so it still opens.
async function resolveNote(n) {
  if (!n || !n._driveBody) return n;
  const backup = await mirror.getBackup(n.id);
  if (backup && backup.current && backup.current.body !== undefined && backup.current.hash === n.hash) {
    return { ...backup.current, _driveBody: n._driveBody, bookmarkId: n.bookmarkId, folderId: n.folderId };
  }
  try {
    const full = await decode(await noteDrive.loadNoteBody(n._driveBody));
    return { ...full, _driveBody: n._driveBody, bookmarkId: n.bookmarkId, folderId: n.folderId, dateAdded: n.dateAdded };
  } catch {
    return { ...n, body: n.preview || '' }; // Drive unavailable — open with the preview
  }
}

async function openBookmark(bookmarkId) {
  const found = (ui.notes || []).find((n) => n.bookmarkId === bookmarkId);
  if (!found) return;
  ui.current = await resolveNote(found);
  ui.activeBookmarkId = bookmarkId;
  ui.activeLocalId = null;
  ui.isNew = false;
  renderCurrentEditor();
  await refreshNoteList();
}

export async function togglePin(handle) {
  const note = (ui.notes || []).find((n) => (n.bookmarkId ?? n.id) === handle);
  if (!note) return;
  // Strip device-local UI fields so they are not baked into the synced note payload;
  // loadNotes re-attaches bookmarkId/folderId on read.
  const { bookmarkId, folderId, localOnly, draft, ...clean } = note;
  const updated = withPinned(clean, !note.pinned);
  const folder = folderId ?? ui.activeFolder;
  const res = await saveNote(updated, folder, bookmarkId ?? undefined);
  if (res.status === 'capped') toast('Too large to sync — saved locally only', true);
  if (ui.current && ui.current.id === note.id) ui.current.pinned = updated.pinned;
  await refreshNoteList();
}

export async function openByHash() {
  const payload = location.hash.replace(/^#/, '');
  if (!payload) return;
  try {
    const note = await decode(payload);
    // The decoded payload carries no folderId/bookmarkId. Resolve them from the real
    // bookmark so the breadcrumb shows the right path and edits update it (not duplicate it).
    let match = null;
    try { match = (await bm.allNotes(ui.rootId)).find((r) => r.payload === payload); } catch { /* tree read failed */ }
    ui.current = await resolveNote(match ? { ...note, folderId: match.folderId, bookmarkId: match.bookmarkId } : note);
    ui.activeBookmarkId = match ? match.bookmarkId : null;
    ui.activeLocalId = null;
    ui.isNew = false; // an opened note is not a new-note draft
    renderCurrentEditor();
    await refreshNoteList();
  } catch { /* not a valid note payload */ }
}

async function doExport() {
  const json = await mirror.exportAll();
  const blob = new Blob([json], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'owl-note-backup.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

// Gather every saved note from the bookmark tree, decode it, and build the
// per-note markdown file list. Pure of DOM/download concerns so it is testable.
export async function collectExportEntries(root) {
  const trashId = await ensureTrash(root);
  const folders = (await bm.listNotebooks(root)).filter((f) => f.id !== trashId);
  const raw = (await bm.allNotes(root)).filter((r) => r.folderId !== trashId);
  const notes = [];
  let skipped = 0;
  const seen = new Set();
  for (const r of raw) {
    try {
      const n = await decode(r.payload);
      notes.push({ id: n.id, title: n.title, body: inlineImages(n.body, n.attachments), folderId: r.folderId });
      if (n.id) seen.add(n.id);
    } catch {
      skipped += 1; // unreadable payload — leave it out rather than abort the export
    }
  }
  // Device-local notes (e.g. image notes too large to be bookmarks) have no
  // bookmark, so include them from the mirror — images inlined so each exported
  // .md stays self-contained.
  for (const ln of await mirror.allLocalOnly()) {
    if (ln && ln.id && !seen.has(ln.id) && ln.folderId !== trashId) {
      notes.push({ id: ln.id, title: ln.title, body: inlineImages(ln.body, ln.attachments), folderId: ln.folderId });
      seen.add(ln.id);
    }
  }
  return { entries: buildMarkdownExport(notes, folders, root), skipped, count: notes.length };
}

async function doExportMarkdown() {
  const root = ui.rootId ?? (await bm.ensureRoot());
  const { entries, skipped, count } = await collectExportEntries(root);
  if (!count) { toast('No notes to export'); return; }
  const files = entries.map((e) => ({ path: e.path, data: new TextEncoder().encode(e.text) }));
  const blob = await zipFiles(files);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'owl-note-export.zip';
  a.click();
  URL.revokeObjectURL(a.href);
  toast(skipped ? `Exported ${count} notes (${skipped} skipped)` : `Exported ${count} notes`);
}

// --- Markdown / JSON import ----------------------------------------------

async function buildIdMap(root) {
  const map = new Map();
  for (const r of await bm.allNotes(root)) {
    try {
      const n = await decode(r.payload);
      if (n && n.id) map.set(n.id, { bookmarkId: r.bookmarkId, folderId: r.folderId });
    } catch { /* undecodable note — can't dedup against it */ }
  }
  return map;
}

async function findOrCreateNotebook(parentId, name, cache) {
  const key = `${parentId} ${name}`;
  if (cache.has(key)) return cache.get(key);
  const children = await chrome.bookmarks.getChildren(parentId);
  const existing = children.find((c) => !c.url && c.title === name);
  const id = existing ? existing.id : await bm.createNotebook(parentId, name);
  cache.set(key, id);
  return id;
}

async function folderForZipDir(dir, root, cache) {
  const segments = dir.split('/').filter(Boolean);
  if (segments.length === 0 || segments[0] === 'Inbox') return root;
  let parent = root;
  for (const seg of segments) parent = await findOrCreateNotebook(parent, seg, cache);
  return parent;
}

async function importOne({ id, title, body, attachments }, targetFolderId, idMap, tally) {
  const existing = id ? idMap.get(id) : undefined;
  const note = { id: id || crypto.randomUUID(), title, body, attachments: attachments || [], version: 1, hash: contentHash(body) };
  const res = await saveNote(note, targetFolderId, existing ? existing.bookmarkId : undefined);
  if (existing) tally.updated += 1;
  // Only record a real bookmark for dedup; a capped note has no bookmark (bookmarkId null).
  else { tally.created += 1; if (res.bookmarkId) idMap.set(note.id, { bookmarkId: res.bookmarkId, folderId: targetFolderId }); }
  if (res.status === 'capped') tally.tooLarge += 1;
}

const basename = (p) => p.replace(/^.*[\\/]/, '');
const dirname = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };
const enexStem = (p) => basename(p).replace(/\.enex$/i, '');
const docxStem = (p) => basename(p).replace(/\.docx$/i, '');

// Downscale large inline images, then move them into attachments leaving short
// owl-img refs in the body, so the editable body never carries a wall of base64.
async function prepareImport(body, attachments = []) {
  return extractImages(await downscaleImagesInBody(body), attachments);
}

async function importMarkdown(text, path, fromZip, ctx) {
  const { meta, title, body } = parseMarkdownNote(text, basename(path));
  if (!body.trim()) { ctx.tally.skipped += 1; return; }
  const folder = fromZip
    ? await folderForZipDir(dirname(path), ctx.root, ctx.nbCache)
    : (meta.notebook ? await findOrCreateNotebook(ctx.root, String(meta.notebook), ctx.nbCache) : ctx.root);
  const prepared = await prepareImport(body);
  await importOne({ id: meta.id, title, body: prepared.body, attachments: prepared.attachments }, folder, ctx.idMap, ctx.tally);
}

// Import .zip / .md / .json files. Pure of DOM/toast concerns so it is testable.
export async function importFiles(files) {
  const root = ui.rootId ?? (await bm.ensureRoot());
  const ctx = { root, idMap: await buildIdMap(root), nbCache: new Map(), tally: { created: 0, updated: 0, skipped: 0, tooLarge: 0 } };
  for (const file of files) {
    const name = (file.name || '').toLowerCase();
    try {
      if (name.endsWith('.zip')) {
        for (const entry of await unzip(new Uint8Array(await file.arrayBuffer()))) {
          if (entry.path.toLowerCase().endsWith('.md')) {
            await importMarkdown(new TextDecoder().decode(entry.bytes), entry.path, true, ctx);
          }
        }
      } else if (name.endsWith('.md')) {
        await importMarkdown(await file.text(), file.name, false, ctx);
      } else if (name.endsWith('.enex')) {
        const notes = parseEnexNotes(await file.text());
        const folder = await findOrCreateNotebook(ctx.root, enexStem(file.name) || 'Imported', ctx.nbCache);
        for (const n of notes) {
          if (!n.body.trim()) { ctx.tally.skipped += 1; continue; }
          const prepared = await prepareImport(n.body);
          await importOne({ id: n.meta.id, title: n.title, body: prepared.body, attachments: prepared.attachments }, folder, ctx.idMap, ctx.tally);
        }
      } else if (name.endsWith('.docx')) {
        const md = await docxToMarkdown(await file.arrayBuffer());
        if (!md.trim()) { ctx.tally.skipped += 1; }
        else {
          const prepared = await prepareImport(md);
          await importOne(
            { title: docxStem(file.name), body: prepared.body, attachments: prepared.attachments },
            ctx.root, ctx.idMap, ctx.tally);
        }
      } else if (name.endsWith('.json')) {
        const data = JSON.parse(await file.text());
        for (const n of Array.isArray(data.notes) ? data.notes : []) {
          if (!n || typeof n.id !== 'string') continue;
          const prepared = await prepareImport(n.body || '', n.attachments || []);
          await importOne({ id: n.id, title: n.title || extractTitle(prepared.body), body: prepared.body, attachments: prepared.attachments }, root, ctx.idMap, ctx.tally);
        }
      } else {
        ctx.tally.skipped += 1;
      }
    } catch { ctx.tally.skipped += 1; } // couldn't read this file — continue the batch
  }
  return ctx.tally;
}

async function doImportFiles(files) {
  const t = await importFiles(files);
  const parts = [`${t.created} new`, `${t.updated} updated`];
  if (t.tooLarge) parts.push(`${t.tooLarge} local-only (not synced — use Export → Import to copy to other devices)`);
  if (t.skipped) parts.push(`${t.skipped} skipped`);
  toast(`Imported: ${parts.join(', ')}`, t.tooLarge > 0 || t.skipped > 0);
  await refreshPanes();
}

// Boot is implemented incrementally; guarded so tests importing saveNote don't run UI.
export async function boot() {
  if (!(await selfTest(createNote({ body: 'self-test' })))) {
    toast('Encoding self-test failed — saving disabled', true);
    return;
  }
  const root = await bm.ensureRoot();
  await initUI(root);
}

if (typeof document !== 'undefined' && document.getElementById('panes')) {
  boot();
}
