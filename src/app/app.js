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

export { saveNote, MAX_URL_BYTES, WARN_URL_BYTES }; // moved to ../lib/save-note.js

// Measure what this note will actually cost in its bookmark URL — the same
// compressed bytes the save path caps — so the editor can show it live.
async function measureNoteSize({ title, body, attachments = [] }) {
  const note = ui.current && ui.activeBookmarkId
    ? withUpdatedContent(ui.current, { title, body, attachments })
    : createNote({ title, body, attachments });
  const payload = await encode(note);
  return { bytes: urlByteLength(payload), warn: WARN_URL_BYTES, max: MAX_URL_BYTES };
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

const recentIds = []; // ids of notes created this session — float to the top until reload (in-memory)

const ui = { rootId: null, trashId: null, activeFolder: null, activeBookmarkId: null, activeLocalId: null, activeLocalFolderId: null, current: null, query: '', notes: [], hashWired: false, isNew: false, selected: new Set(), anchor: null, focus: -1 };

export function resetUI() {
  ui.rootId = null;
  ui.trashId = null;
  ui.activeFolder = null;
  ui.activeBookmarkId = null;
  ui.activeLocalId = null;
  ui.activeLocalFolderId = null;
  ui.current = null;
  ui.query = '';
  ui.notes = [];
  ui.hashWired = false;
  ui.isNew = false;
  ui.selected = new Set(); ui.anchor = null; ui.focus = -1;
}

export async function initUI(rootId) {
  ui.rootId = rootId;
  ui.activeFolder = rootId;
  ui.trashId = await ensureTrash(rootId);
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
      decoded.push({ ...note, bookmarkId: r.bookmarkId, folderId: r.folderId || folderId });
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

async function refreshPanes() {
  const notebooks = (await bm.listNotebooks(ui.rootId)).filter((nb) => nb.id !== ui.trashId);
  const trashCount = (await loadNotes(ui.trashId)).length;
  renderSidebar(document.getElementById('sidebar'), {
    rootId: ui.rootId,
    notebooks,
    activeId: ui.activeFolder,
    onSelect: async (id) => { ui.selected = new Set(); ui.anchor = null; ui.focus = -1; ui.activeFolder = id; await refreshPanes(); },
    onNewNotebook: async () => {
      const title = prompt('Notebook name?');
      if (!title) return;
      const id = await bm.createNotebook(ui.rootId, title);
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
    trashId: ui.trashId,
    trashCount,
    trashActive: ui.activeFolder === ui.trashId,
    onOpenTrash: async () => { ui.selected = new Set(); ui.anchor = null; ui.focus = -1; ui.activeFolder = ui.trashId; await refreshPanes(); },
  });
  renderToolbar(document.getElementById('toolbar'), {
    query: ui.query,
    onSearch: async (q) => { ui.selected = new Set(); ui.anchor = null; ui.focus = -1; ui.query = q; await refreshNoteList(); },
    onExportMarkdown: () => doExportMarkdown(),
    onExportJson: doExport,
    onImport: (files) => doImportFiles(files),
  });
  await refreshNoteList();
  // Editor is intentionally NOT re-rendered here. It is rendered only by
  // initUI, newNote, openBookmark, and openByHash, so sidebar/search
  // interactions never clobber in-progress edits or steal search focus.
}

function renderCurrentEditor(opts = {}) {
  renderEditor(document.getElementById('editor'), {
    title: ui.current ? ui.current.title : '',
    body: ui.current ? ui.current.body : '',
    attachments: ui.current ? (ui.current.attachments || []) : [],
    focusTitle: !!opts.focusTitle,
    measure: measureNoteSize,
    onChange: ({ title, body, attachments }) => {
      if (ui.current) { ui.current.title = title; ui.current.body = body; ui.current.attachments = attachments; }
    },
    onSave: async ({ title, body, attachments }) => {
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
      if (res.status === 'capped') toast('Too large to sync — saved locally only', true);
      else if (res.status === 'warn') toast('Large note — may not sync across devices', true);
      else toast('Saved');
      await refreshPanes();
    },
    onDelete: ui.current ? () => deleteCurrentNote() : null,
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
  toast('Notebook renamed');
}

async function deleteNotebook(id) {
  if (!confirm('Delete this notebook and all its notes? This cannot be undone.')) return;
  const notes = await bm.allNotes(id);
  const deleted = new Set(notes.map((n) => n.bookmarkId));
  for (const n of notes) {
    try { const note = await decode(n.payload); await mirror.removeBackup(note.id); } catch { /* skip malformed */ }
  }
  await bm.deleteFolder(id);
  if (ui.activeFolder === id) ui.activeFolder = ui.rootId;
  if (ui.activeBookmarkId && deleted.has(ui.activeBookmarkId)) {
    ui.current = null;
    ui.activeBookmarkId = null;
    ui.activeLocalId = null;
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

async function openBookmark(bookmarkId) {
  const found = (ui.notes || []).find((n) => n.bookmarkId === bookmarkId);
  if (!found) return;
  ui.current = found;
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
    ui.current = await decode(payload);
    ui.activeBookmarkId = null;
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
