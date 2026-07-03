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
import { createAskIndex } from '../lib/ask-index.js';
import { createFusion } from '../lib/fusion.js';
import { createAskController } from '../lib/ask-controller.js';
import { createRegistry } from '../lib/providers/registry.js';
import { suggestTitle } from '../lib/providers/title.js';
import { tidyMarkdown } from '../lib/tidy-markdown.js';
import { renderAskPanel } from './ask-panel.js';

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
        + "stored in an 'OWL-Note Sync' folder in your Google Drive so they sync "
        + 'across your devices. You will be asked to grant access, and can turn this off at any time.',
      );
      if (!ok) { toast('Drive sync not enabled.'); return false; } // user declined consent — leave sync off
      await enable();
      const promoted = await reconcileLocalToDrive(); // push notes stranded local-only while sync was off
      toast(promoted > 0
        ? `Google Drive sync on — synced ${promoted} local note${promoted === 1 ? '' : 's'} to Drive`
        : 'Google Drive sync on');
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

// When Drive sync is (re)enabled, push every note kept device-local while sync was off up to
// Drive so it becomes synced. Reuses saveNote's offload pipeline (no new permissions); a note
// whose upload fails stays local-only and is retried on the next re-enable. Returns count synced.
export async function reconcileLocalToDrive(save = saveNote) {
  let synced = 0;
  for (const note of await mirror.allLocalOnly()) {
    const { folderId, ...clean } = note;
    try {
      await save(clean, folderId ?? ui.rootId, undefined);
      synced += 1;
    } catch { /* leave it local-only; retried on the next re-enable */ }
  }
  return synced;
}

const recentIds = []; // ids of notes created this session — float to the top until reload (in-memory)

const ui = { rootId: null, trashId: null, activeFolder: null, activeBookmarkId: null, activeLocalId: null, activeLocalFolderId: null, current: null, editor: null, query: '', notes: [], notebooks: [], collapsed: new Set(), hashWired: false, isNew: false, selected: new Set(), anchor: null, focus: -1, indexReady: null };

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
  ui.indexReady = null;
  // Drop the Ask drawer/controller so the next initUI rebinds to the fresh DOM
  // (test harnesses replace document.body between runs).
  if (askPanel && askPanel.destroy) askPanel.destroy();
  askPanel = null;
  askController = null;
}

// Ask-Your-Notes lexical index — ONE module-level instance for the app's lifetime.
// T4's ask-controller and the lifecycle tests query the corpus through getAskIndex().
const askIndex = createAskIndex();
export function getAskIndex() { return askIndex; }

// Deferred, coalesced full (re)build of the whole live corpus. loadNotes(ui.rootId)
// already yields every note under root minus Trash, bodies materialized — exactly the
// shape build() wants. Exposed so boot/tests can await the rebuild deterministically.
export async function rebuildAskIndex() {
  if (!ui.rootId) return; // not booted (or reset between tests)
  askIndex.build(await loadNotes(ui.rootId));
}

// The real provider registry (M3): defaults to the built-in on-device provider.
// Constructed once for the app's lifetime — the built-in provider re-feature-detects
// globalThis.LanguageModel on every call, so where the model is absent (or in jsdom
// tests) availability()->'unavailable' and Ask degrades to retrieval-only snippets,
// exactly as the M2 stub did. Construction cannot throw, so it's boot-safe.
const askRegistry = createRegistry();

// Persisted "don't offer the on-device model download" flag. Read once when the
// drawer is built and passed to the panel so its opt-in card stays gated; the panel
// writes it back through onDeclineAi (below). chrome.storage key.
const AI_DECLINED_KEY = 'ask:aiDeclined';

// Ask controller + drawer are constructed once per app lifetime (reset between
// tests via resetUI). The controller is pure; the panel binds to the #ask-panel
// aside, which some test harnesses omit — then askPanel stays null and the toolbar
// simply renders no Ask button.
let askController = null;
let askPanel = null;

async function ensureAskUI() {
  if (!askController) {
    askController = createAskController({
      index: getAskIndex(),
      fusion: createFusion(getAskIndex()),
      registry: askRegistry,
      onState: (s) => askPanel?.update(s),
    });
  }
  if (!askPanel) {
    const el = document.getElementById('ask-panel');
    if (!el) return; // no drawer mount in this environment — controller still exists
    // Read the persisted opt-out so the download card never re-appears after a past
    // dismiss (best-effort; a read failure just leaves the card eligible to show).
    let aiDeclined = false;
    try { aiDeclined = !!(await chrome.storage.local.get(AI_DECLINED_KEY))[AI_DECLINED_KEY]; } catch { /* best-effort */ }
    askPanel = renderAskPanel(el, {
      // [Task E7] Forward the panel's ask opts (e.g. { pinnedNoteId }) to the controller.
      onAsk: (q, opts) => askController.ask(q, opts),
      onCitation: (noteId) => openCitation(noteId),
      getStats: () => getAskIndex().stats(),
      // [Task E7] The currently-open note for the context chip; null when none is open.
      getCurrentNote: () => (ui.current ? { id: ui.current.id, title: ui.current.title || 'Untitled' } : null),
      aiDeclined,
      // USER-GESTURE (critical): the panel's [Enable] handler calls this synchronously
      // from the click, and this MUST reach askController.enableModel() before any
      // await. enableModel()->provider.ensureReady()->LanguageModel.create() needs the
      // click's user activation to permit the model download; an intervening await
      // would consume the gesture and Chrome would refuse it. So enableModel() is the
      // first statement here — the re-ask is deferred to its .then().
      onEnableModel: (question, opts) => {
        const done = askController.enableModel(); // fires the download NOW (still in the gesture)
        if (question) {
          // On success re-run the ask (downloading -> generating -> answered). Skip the
          // re-ask if the download errored — the controller already emitted `error`
          // (with the preserved chunks), and re-asking would clobber that message.
          // [Task E9] Thread the original opts through so the re-ask preserves the pin
          // and pinAll — a summarize that triggered the download re-runs AS a summarize,
          // not a plain keyword search.
          done.then(() => { if (askController.getState().kind !== 'error') askController.ask(question, opts); })
            .catch(() => { /* enableModel never rejects, but stay unhandled-rejection-free */ });
        }
      },
      // Persist the opt-out so the card is gone for good (this session AND future ones).
      onDeclineAi: () => { chrome.storage.local.set({ [AI_DECLINED_KEY]: true }).catch(() => {}); },
      // [Task E11] Tidy quick action: run the deterministic, rule-based markdown tidy
      // (src/lib/tidy-markdown.js) on the CHIP'S note and apply it directly. Fully
      // SYNCHRONOUS — no model, no proposal, no pending state — so there is no
      // stale-edit window: read → tidy → replaceBody in one go. tidyMarkdown is
      // content-preserving by construction (it only fixes structural whitespace and
      // markers), so it applies without review. replaceBody keeps the editor's native
      // undo stack, so a single Ctrl+Z reverts it; when nothing changes we skip the
      // write entirely and just say so.
      onTidyNote: (noteId) => {
        if (!ui.current || ui.current.id !== noteId || !ui.editor) { toast('Open the note first', true); return; }
        const body = ui.current.body || '';
        const tidied = tidyMarkdown(body);
        if (tidied === body) { toast('Already tidy'); return; }
        ui.editor.replaceBody(tidied); // undo-preserving apply (single Ctrl+Z reverts)
        toast('Tidied — Ctrl+Z to undo');
      },
    });
  }
}

// Open a cited note from the Ask drawer. Uses the index's citation snapshot rather
// than openHandle: openHandle resolves against the ACTIVE folder's ui.notes only,
// so a citation into another notebook would miss. noteMeta().folderId (kept correct
// across moves by T3.5) lets us switch to the note's folder first, then open it.
async function openCitation(noteId) {
  const meta = getAskIndex().noteMeta(noteId);
  if (!meta) return; // note vanished (e.g. trashed after retrieval) — ignore
  if (meta.folderId && meta.folderId !== ui.activeFolder) {
    ui.activeFolder = meta.folderId;
    await refreshPanes(); // load the target folder's list first so openBookmark can find it
  }
  if (meta.localOnly) openLocalNote(noteId);
  else openBookmark(meta.bookmarkId);
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
  await ensureAskUI(); // construct the Ask controller + drawer before the toolbar renders (needs askPanel)
  await initPanes();
  await refreshPanes();
  renderCurrentEditor();
  await openByHash();
  if (!ui.current) await openLatestNote(); // no specific note in the URL hash — default to the latest
  if (!ui.hashWired) {
    window.addEventListener('hashchange', openByHash);
    // Flush a pending auto-save when the tab is hidden/closed — focus can stay in the
    // textarea on a tab switch, so the blur flush alone won't always catch it.
    document.addEventListener('visibilitychange', () => { if (document.hidden) ui.editor?.flush?.(); });
    ui.hashWired = true;
  }
  wireLiveRefresh();
  // Build the ask index in the background — a FLOATING promise so indexing never
  // delays first paint. .catch keeps a build failure from surfacing as an unhandled
  // rejection (best-effort, like healNoteUrls above); ui.indexReady lets tests await it.
  ui.indexReady = rebuildAskIndex().catch((e) => { console.warn('Ask index build failed:', e); });
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
  const driveEnabled = await isEnabled();
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
    driveEnabled,
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
  for (const t of targets) askIndex.removeNote(t.id); // trashed notes leave the live corpus
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
    for (const t of targets) askIndex.removeNote(t.id); // purged notes are gone for good (no-op if never indexed, e.g. already in Trash)
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
      // Rebuild the ask index on the SAME coalesced cycle as the note-list refresh:
      // a burst of external chrome.bookmarks events (Drive sync, another tab) collapses
      // into ONE rebuild per cycle via the do/while queue below — never one per event.
      // .catch: a rebuild failure here (e.g. a bad note) must not become a NEW
      // unhandled rejection or abort this refresh cycle — best-effort, like
      // bm.healNoteUrls above.
      await rebuildAskIndex().catch((e) => console.warn('ask index rebuild failed', e));
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
  // Restore-from-Trash and cross-notebook moves (in-app drag AND remote sync)
  // fire ONLY onMoved, not onCreated/onChanged/onRemoved. Routing it through the
  // same coalesced liveRefreshNoteList refreshes the note list AND rebuilds the
  // index in one collapsed cycle — for an external move the list refresh is
  // correct (the note really moved); for an in-app move the app already
  // refreshed, so this is an idempotent extra pass (cheap: moves are infrequent
  // and the cycle is coalesced). Safe even for a trash-move: rebuildAskIndex ->
  // loadNotes already filters out Trash, so it can't resurrect a trashed note.
  c.bookmarks.onMoved?.addListener(liveRefreshNoteList);
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
    onToggleDrive: async (checked) => {
      const result = await toggleDriveSync(checked);
      await refreshNoteList(); // refresh note-card sync badges right after toggling
      return result;
    },
    // Ask button only when the drawer is mounted. Pass the focused element (the just-
    // clicked toolbar Ask button) as the opener so the panel returns focus to it on
    // close (a11y — T10/M4.5). The panel falls back to document.activeElement anyway.
    onAsk: askPanel ? () => askPanel.open(document.activeElement) : null,
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
      // Keep the ask index in sync with this save. Synchronous in-memory op — do NOT
      // await it. upsertNote replaces the note's stale chunks when its content hash
      // changed (edit), or just refreshes citation meta when only the folder moved.
      askIndex.upsertNote({
        ...note, // id, title, body, hash
        bookmarkId: ui.activeBookmarkId || null,
        folderId: ui.activeLocalId ? (ui.activeLocalFolderId ?? folder) : folder,
        localOnly: !!ui.activeLocalId,
      });
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
    // ✨ Suggest title: the on-device model PROPOSES a title into the field. It
    // returns null for both an empty note and an unavailable/failed model — one
    // shared toast per case is fine in v1; the editor leaves the field untouched.
    onSuggestTitle: async (body) => {
      if (!body || !body.trim()) { toast('Nothing to title yet', true); return null; }
      const title = await suggestTitle(body).catch(() => null);
      if (title === null) toast("On-device AI isn't available — enable it in the Ask panel", true);
      return title;
    },
  });
  // Every note open/close/switch funnels through this function, so this one call
  // keeps the Ask drawer's context chip following the open note live (not just at
  // drawer-open/ask time). Safe when the panel doesn't exist (test harnesses).
  askPanel?.refreshChip?.();
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
    askIndex.removeNote(ui.current.id); // note left the live corpus
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

export async function deleteNotebook(id) {
  const hasSubs = (ui.notebooks || []).some((nb) => nb.id !== id && isSelfOrDescendant(ui.notebooks, id, nb.id));
  const msg = hasSubs
    ? 'Delete this notebook and its sub-notebooks? Their notes are moved to Trash (restorable).'
    : 'Delete this notebook? Its notes are moved to Trash (restorable).';
  if (!confirm(msg)) return;

  // Move the subtree's notes to Trash (recoverable) rather than hard-deleting — same as deleting
  // a note directly. Their Drive files are cleaned later, at Delete forever (ref-counted).
  const subtree = new Set((ui.notebooks || []).filter((nb) => isSelfOrDescendant(ui.notebooks, id, nb.id)).map((nb) => nb.id));
  subtree.add(id);
  const targets = [];
  for (const n of await bm.allNotes(id)) {
    try { targets.push({ id: (await decode(n.payload)).id, bookmarkId: n.bookmarkId, folderId: n.folderId }); } catch { /* skip malformed */ }
  }
  for (const ln of await mirror.allLocalOnly()) {
    if (subtree.has(ln.folderId)) targets.push({ id: ln.id, bookmarkId: null, folderId: ln.folderId, localOnly: true });
  }
  const movedBookmarks = new Set(targets.filter((t) => t.bookmarkId).map((t) => t.bookmarkId));
  await trashNotes(targets, ui.trashId);
  for (const t of targets) askIndex.removeNote(t.id); // the whole subtree's notes left the live corpus

  // The subtree now holds only empty folders — remove them. (Computed while ui.notebooks
  // still reflects the old tree.)
  const openFolder = ui.activeLocalId ? ui.activeLocalFolderId : (ui.current && ui.current.folderId);
  const openNoteMoved = (ui.activeBookmarkId && movedBookmarks.has(ui.activeBookmarkId))
    || (openFolder && (openFolder === id || isSelfOrDescendant(ui.notebooks, id, openFolder)));
  const activeInSubtree = ui.activeFolder === id || (ui.activeFolder && isSelfOrDescendant(ui.notebooks, id, ui.activeFolder));
  await bm.deleteFolder(id);
  if (activeInSubtree) ui.activeFolder = ui.rootId;
  if (openNoteMoved) {
    ui.current = null;
    ui.activeBookmarkId = null;
    ui.activeLocalId = null;
    ui.activeLocalFolderId = null;
    renderCurrentEditor();
  }
  await refreshPanes();
  toast('Notebook deleted — notes moved to Trash');
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

// On a plain launch (no note id in the URL hash) open the latest note so the editor
// isn't blank. ui.notes is already loaded and ordered (pinned/newest-first) by refreshPanes.
async function openLatestNote() {
  const top = (ui.notes || []).find((n) => !n.draft);
  if (!top) return; // empty folder — leave the blank new-note editor
  if (top.localOnly) await openLocalNote(top.id);
  else await openBookmark(top.bookmarkId);
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

async function importOne({ id, title, body, attachments }, targetFolderId, ctx) {
  const { idMap, tally } = ctx;
  // Imported ids are untrusted. Strip angle brackets so a crafted id can never forge
  // the <<<NOTE c:...>>> sentinel the Ask prompt wraps chunks in — the chunk id
  // round-trips as a citation key, so it must be sanitized here at ingestion (a fixed
  // choke point for every import format), not in the prompt where it can't be altered.
  const safeId = typeof id === 'string' ? id.replace(/[<>]/g, '') : id;
  const existing = safeId ? idMap.get(safeId) : undefined;
  const note = { id: safeId || crypto.randomUUID(), title, body, attachments: attachments || [], version: 1, hash: contentHash(body) };
  const res = await saveNote(note, targetFolderId, existing ? existing.bookmarkId : undefined);
  ctx.touched.add(targetFolderId); // remember where notes landed, to reveal it after import
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
  await importOne({ id: meta.id, title, body: prepared.body, attachments: prepared.attachments }, folder, ctx);
}

// Import .zip / .md / .json files. Pure of DOM/toast concerns so it is testable.
export async function importFiles(files) {
  const root = ui.rootId ?? (await bm.ensureRoot());
  const ctx = { root, idMap: await buildIdMap(root), nbCache: new Map(), tally: { created: 0, updated: 0, skipped: 0, tooLarge: 0 }, touched: new Set() };
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
          await importOne({ id: n.meta.id, title: n.title, body: prepared.body, attachments: prepared.attachments }, folder, ctx);
        }
      } else if (name.endsWith('.docx')) {
        const md = await docxToMarkdown(await file.arrayBuffer());
        if (!md.trim()) { ctx.tally.skipped += 1; }
        else {
          const prepared = await prepareImport(md);
          await importOne(
            { title: docxStem(file.name), body: prepared.body, attachments: prepared.attachments },
            ctx.root, ctx);
        }
      } else if (name.endsWith('.json')) {
        const data = JSON.parse(await file.text());
        for (const n of Array.isArray(data.notes) ? data.notes : []) {
          if (!n || typeof n.id !== 'string') continue;
          const prepared = await prepareImport(n.body || '', n.attachments || []);
          await importOne({ id: n.id, title: n.title || extractTitle(prepared.body), body: prepared.body, attachments: prepared.attachments }, root, ctx);
        }
      } else {
        ctx.tally.skipped += 1;
      }
    } catch { ctx.tally.skipped += 1; } // couldn't read this file — continue the batch
  }
  return { ...ctx.tally, touched: [...ctx.touched] };
}

async function doImportFiles(files) {
  const t = await importFiles(files);
  const parts = [`${t.created} new`, `${t.updated} updated`];
  if (t.tooLarge) parts.push(`${t.tooLarge} local-only (not synced — use Export → Import to copy to other devices)`);
  if (t.skipped) parts.push(`${t.skipped} skipped`);
  toast(`Imported: ${parts.join(', ')}`, t.tooLarge > 0 || t.skipped > 0);
  await refreshPanes(); // updates ui.notebooks with the newly created folders
  // Reveal what was imported: expand the folders it landed in (and their ancestors) and show
  // them, so the user doesn't have to hunt for or expand the tree. Select the single imported
  // folder if there's exactly one, otherwise fall back to root ("All notes").
  const touched = (t.touched || []).filter((f) => f && f !== ui.rootId);
  for (const f of touched) expandToReveal(f);
  ui.activeFolder = touched.length === 1 ? touched[0] : ui.rootId;
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
