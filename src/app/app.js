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
import { extractImages, inlineImagesAsync } from '../lib/note-images.js';
import { resolveReferencedAttachments } from '../lib/attachment-resolver.js';
import { docxToMarkdown } from '../lib/docx-import.js';
import { saveNote, urlByteLength, MAX_URL_BYTES, WARN_URL_BYTES } from '../lib/save-note.js';
import { ensureTrash, trashNotes, restoreNotes, deleteForever } from '../lib/trash.js';
import { rangeHandles } from '../lib/list-selection.js';
import { isSelfOrDescendant } from '../lib/notebook-tree.js';
import { offloadShape, getBytes } from '../lib/attachment-store.js';
import * as noteDrive from '../lib/note-drive.js';
import { isEnabled, enable, disable } from '../lib/drive-sync.js';
import { createAskIndex } from '../lib/ask-index.js';
import { createFusion } from '../lib/fusion.js';
import { createVectorIndex } from '../lib/vector-index.js';
import { createEmbedClient } from '../lib/embed-client.js';
import { chunkNote } from '../lib/chunker.js';
import { createAskController } from '../lib/ask-controller.js';
import { createRegistry } from '../lib/providers/registry.js';
import { suggestTitle } from '../lib/providers/title.js';
import { tidyMarkdown } from '../lib/tidy-markdown.js';
import { renderAskPanel } from './ask-panel.js';
import { builtinAskActions } from './ask-actions.js';
import { buildOwlNotePackage, parseOwlNotePackage, owlNoteFilename } from '../lib/owl-note-package.js';
import { buildNotePdf, notePdfFilename, verifiedPdfBytes, verifiedPdfFile } from '../lib/note-pdf.js';
import * as driveClient from '../lib/drive/client.js';
import { retryPendingDriveCleanup } from '../lib/drive-gc.js';
import SparkMD5 from 'spark-md5';
import { showShareLinkDialog } from './share-link-dialog.js';
import { showPdfShareDialog } from './pdf-share-dialog.js';
import { updatePdfProgress, hidePdfProgress } from './pdf-progress.js';
// [Task E18] The first-run Welcome note content + its fixed id. Single source: this
// module both creates the note (below) and gates the E17 sample offer's "only-welcome"
// case on WELCOME_NOTE_ID, so no id string is duplicated across the two features.
import { WELCOME_NOTE_ID, WELCOME_NOTE_TITLE, WELCOME_NOTE_BODY } from './welcome-note.js';

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

let toastTimer = null;
export function toast(message, isWarn = false) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.className = isWarn ? 'warn' : '';
  el.hidden = false;
  // Clear a prior hide timer so a rapid second toast gets its OWN full 3s, instead of
  // being cut short when the first toast's timer fires (UI audit).
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; toastTimer = null; }, 3000);
}

// Import progress bar — lives where the toast does, but persists for the whole
// batch instead of auto-hiding. Lazily created so it needs no app.html slot.
// Pass {done, total} ticks to show/update, null to hide when the batch ends.
export function renderImportProgress(p) {
  let el = document.getElementById('import-progress');
  if (!p) { if (el) el.hidden = true; return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'import-progress';
    const label = document.createElement('span');
    label.className = 'import-progress-label';
    const track = document.createElement('div');
    track.className = 'import-progress-track';
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-valuemin', '0');
    const bar = document.createElement('div');
    bar.className = 'import-progress-bar';
    track.append(bar);
    el.append(label, track);
    document.body.append(el);
  }
  el.querySelector('.import-progress-label').textContent = `Importing… ${p.done} / ${p.total}`;
  const track = el.querySelector('.import-progress-track');
  track.setAttribute('aria-valuemax', String(p.total));
  track.setAttribute('aria-valuenow', String(p.done));
  el.querySelector('.import-progress-bar').style.width = `${p.total ? Math.round((p.done / p.total) * 100) : 0}%`;
  el.hidden = false;
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
      // The mirror image of that catch-up: a permanent delete performed while sync was off
      // checkpointed its Drive file ids but could not reach Drive to remove them. Flush that
      // backlog now instead of leaving it until the next app launch. Floating and guarded —
      // the ids stay checkpointed, so a failure here must not report the toggle as failed.
      void retryPendingDriveCleanup().catch((e) => { console.warn('Drive cleanup retry failed:', e); });
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

const QUICK_CAPTURE_KEY = 'owl:quickCapture';
let lastQuickCaptureToken = null;
let quickCaptureQueue = Promise.resolve();

const ui = { rootId: null, trashId: null, activeFolder: null, activeBookmarkId: null, activeLocalId: null, activeLocalFolderId: null, current: null, editor: null, query: '', notes: [], notebooks: [], collapsed: new Set(), hashWired: false, isNew: false, selected: new Set(), anchor: null, focus: -1, indexReady: null, driveEnabled: false };

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
  lastQuickCaptureToken = null;
  quickCaptureQueue = Promise.resolve();
  ui.indexReady = null;
  ui.driveEnabled = false;
  // Drop the Ask drawer/controller so the next initUI rebinds to the fresh DOM
  // (test harnesses replace document.body between runs).
  if (askPanel && askPanel.destroy) askPanel.destroy();
  askPanel = null;
  askController = null;
  // Drop the semantic singletons + gate so the next boot starts un-opted-in — keeps
  // test runs isolated (each begins with no worker/vector and the flag unread).
  vectorIndex = null;
  embedClient = null;
  semanticEnabled = false;
  semanticStatus = { state: 'off' };
  // [Task E16] Drop the in-memory review-ask latch (re-read from storage on the next
  // initUI) and clear any lingering banner so each test boot starts clean.
  reviewAsked = false;
  if (typeof document !== 'undefined') document.getElementById('review-banner')?.remove();
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

// --- Semantic (vector) index orchestration [Task V4] ----------------------------
// The hybrid Ask feature's expensive half. Everything here is gated behind ONE
// explicit user opt-in (the footer's Build button), persisted as a flag, because
// enabling it fetches a ~130MB on-device model. NOTHING semantic — no worker spawn,
// no download, no embedding — may happen before that click.
//
// The persisted opt-in. Once true, later boots silently catch the vector index up to
// the live corpus (rule 2). Read at boot and after a Build; never assumed.
const SEMANTIC_BUILT_KEY = 'ask:semanticBuilt';

// Lazy singletons — NULL until opt-in. Constructing either spawns a Worker / opens
// IndexedDB (and can trigger the model download), so they are built ONLY inside
// ensureSemantic(), called from the Build click or a flag-gated boot catch-up —
// NEVER implicitly. jsdom has no Worker, so this lazy construction is ALSO what keeps
// every existing (Worker-free) test green.
let vectorIndex = null;
let embedClient = null;
// In-memory mirror of SEMANTIC_BUILT_KEY for cheap synchronous gating on the hot
// save/delete paths. Flipped true only after a successful Build or a flag-set boot.
let semanticEnabled = false;
// Footer status surfaced to the panel via getSemanticStatus(); pushed with
// refreshFooter(). 'off' before opt-in, 'building' during a Build, 'ready' after.
let semanticStatus = { state: 'off' };

// Factory seam (documented test choice): production callers never pass factories;
// tests swap in fakes via __setSemanticFactoriesForTests so no real Worker/IndexedDB
// is touched. The consent test asserts these are NEVER called before the Build click.
let semanticFactories = { createVectorIndex, createEmbedClient };
export function __setSemanticFactoriesForTests(f) {
  semanticFactories = f
    ? { createVectorIndex, createEmbedClient, ...f }
    : { createVectorIndex, createEmbedClient };
}

// Construct the semantic singletons ONCE (idempotent). The ONLY place either factory
// runs. Callers must already have decided the user opted in — this does not check the
// flag, it just materializes the machinery.
function ensureSemantic() {
  if (!vectorIndex) vectorIndex = semanticFactories.createVectorIndex();
  if (!embedClient) embedClient = semanticFactories.createEmbedClient();
}

// Passage embedder handed to vector-index.upsertMissing — resolves the LIVE singleton
// at call time (non-null because upsertMissing only runs after ensureSemantic).
const embedPassages = (texts) => embedClient.embedPassages(texts);

async function isSemanticBuilt() {
  try { return !!(await chrome.storage.local.get(SEMANTIC_BUILT_KEY))[SEMANTIC_BUILT_KEY]; }
  catch { return false; } // storage read failed — treat as not-built (stay lexical)
}

// Normalize a worker load-progress event to a 0..1 fraction (or null). The worker
// forwards Transformers.js progress, whose `progress` is 0..100; loaded/total is the
// authoritative pair when present.
function progressFraction(e) {
  if (!e) return null;
  if (typeof e.loaded === 'number' && typeof e.total === 'number' && e.total > 0) return e.loaded / e.total;
  if (typeof e.progress === 'number') return e.progress > 1 ? e.progress / 100 : e.progress;
  return null;
}

// Push the footer status to the panel (safe no-op when no drawer is mounted).
function setSemanticStatus(s) { semanticStatus = s; askPanel?.refreshFooter?.(); }

// The live corpus shaped to vector-index's contract: { id, hash, chunks:[{id,text}] }.
// Reuses loadNotes(ui.rootId) — the SAME source the lexical rebuild uses (every note
// under root minus Trash, bodies materialized) — then chunks each note. The chunk
// TEXT field is what gets embedded (matches the eval's indexing).
async function corpusNotes() {
  const notes = ui.rootId ? await loadNotes(ui.rootId) : [];
  return notes.map(noteToCorpusShape);
}
function noteToCorpusShape(note) {
  return { id: note.id, hash: note.hash, chunks: chunkNote(note) };
}

// The Build click path: the one-time semantic index build. Ordered so nothing
// downloads or embeds until this explicit opt-in.
//   1. construct + open the vector store,
//   2. ensureReady() — where the ~130MB model downloads (progress PHASE 1),
//   3. upsertMissing() — embed every note's chunks (progress PHASE 2; hash-diff so a
//      re-run is cheap),
//   4. persist the flag (ONLY on success) + refresh the footer.
// Exported so the panel's Build handler and the app tests can drive it.
export async function buildSemanticIndex({ onProgress } = {}) {
  ensureSemantic();
  await vectorIndex.open();
  // PHASE 1 — model download/load. ensureReady emits the worker's load-progress.
  onProgress?.({ phase: 'download' });
  await embedClient.ensureReady({
    onProgress: (e) => onProgress?.({ phase: 'download', progress: progressFraction(e) }),
  });
  // PHASE 2 — embed the corpus. upsertMissing skips notes whose hash is unchanged.
  const notes = await corpusNotes();
  onProgress?.({ phase: 'embed', done: 0, total: notes.length });
  await vectorIndex.upsertMissing(notes, embedPassages, {
    onProgress: (done, total) => onProgress?.({ phase: 'embed', done, total }),
  });
  // Success ONLY: flip the gate and persist. A failed/aborted build leaves the user
  // un-opted-in (retrieval stays lexical) rather than claiming a half-built index.
  semanticEnabled = true;
  try { await chrome.storage.local.set({ [SEMANTIC_BUILT_KEY]: true }); } catch { /* best-effort */ }
  setSemanticStatus({ state: 'ready' });
}

// Bring the vector index up to date with `notes` (defaults to the whole live corpus).
// ensureReady FIRST so the embedder is loaded before upsertMissing embeds any changed
// note; hash-diff means unchanged notes cost nothing (no embed call). Only ever called
// when semantic is enabled — the caller's job to gate on semanticEnabled.
async function syncSemantic(notes) {
  ensureSemantic();
  await vectorIndex.open();
  await embedClient.ensureReady();
  await vectorIndex.upsertMissing(notes || await corpusNotes(), embedPassages);
}

// Boot catch-up: if the user opted into semantic search on a PRIOR run, silently
// re-sync the vector index to the current corpus. Gated on the persisted flag so a
// never-opted-in user spawns NO worker and downloads NOTHING at boot. ensureSemantic
// runs BEFORE flipping semanticEnabled so removeSemantic never sees a null singleton.
async function maybeCatchUpSemantic() {
  if (!(await isSemanticBuilt())) return; // never opted in — do nothing semantic
  ensureSemantic();
  semanticEnabled = true;
  setSemanticStatus({ state: 'ready' });
  await syncSemantic(); // hash-diff makes this cheap when nothing changed
}

// Test/boot accessor for the floating boot catch-up (mirrors how tests await
// ui.indexReady via rebuildAskIndex): resolves once the catch-up settles.
export function whenSemanticReady() { return ui.semanticReady || Promise.resolve(); }

// Mirror a lexical save into the vector index when semantic is on. Fire-and-forget +
// .catch (the ui.indexReady discipline): a semantic hiccup must never break saving or
// leak an unhandled rejection. hash-diff: a folder-only move (body unchanged) embeds
// nothing.
function upsertSemantic(note) {
  if (!semanticEnabled) return;
  syncSemantic([noteToCorpusShape(note)]).catch((e) => console.warn('semantic upsert failed', e));
}

// Mirror a lexical removeNote into the vector index. Fire-and-forget + .catch
// (removeNote is async — it hits IndexedDB). No-op before opt-in, or if the singleton
// isn't up yet (the note isn't tracked, so there's nothing to remove).
function removeSemantic(id) {
  if (!semanticEnabled || !vectorIndex) return;
  Promise.resolve()
    .then(() => vectorIndex.removeNote(id))
    .catch((e) => console.warn('semantic removeNote failed', e));
}

// --- [Task E16] Gentle one-time review ask [growth flywheel] ---------------------
// One respectful, policy-safe prompt shown at a VALUE moment, at most ONCE per install
// EVER: the 100th successful save. Any dismissal (Rate it / No thanks / ✕) — or the
// mere act of showing it — persists owl:reviewAsked, so it can never reappear. It is a
// SEPARATE persistent card, never the transient #toast.
const REVIEW_ASKED_KEY = 'owl:reviewAsked';    // once-ever latch (persisted)
const REVIEW_SAVE_COUNT_KEY = 'owl:saveCount';  // successful-save tally toward the threshold
const REVIEW_SAVE_THRESHOLD = 100;              // the 100th save is the value moment
// The Chrome Web Store review page for OWL-Note. (A future Edge Add-ons store would
// need its own URL + a store-detect — deliberately out of scope here.)
const REVIEW_STORE_URL = 'https://chromewebstore.google.com/detail/hjkbpgkmiaeojfhkpnhmokgjipenhcfl/reviews';

// In-memory mirror of REVIEW_ASKED_KEY for a cheap synchronous guard on the hot save
// and ask paths. Loaded at boot (initUI), reset in resetUI. Once true we stop counting
// saves entirely — the guard means no unbounded storage churn.
let reviewAsked = false;

// Ask controller + drawer are constructed once per app lifetime (reset between
// tests via resetUI). The controller is pure; the panel binds to the #ask-panel
// aside, which some test harnesses omit — then askPanel stays null and the toolbar
// simply renders no Ask button.
let askController = null;
let askPanel = null;

async function ensureAskUI() {
  if (!askController) {
    // Null-safe proxy handed to fusion as its `vector`: consults the LIVE singleton
    // (null until opt-in) and reports not-ready whenever semantic is off, so fusion's
    // short-circuit (`if (!stats.ready || stats.chunks<=0) return lex`) keeps the
    // hybrid path — and embedQuery below — UNREACHABLE before the Build click. WHY
    // this matters: an implicit ensure here would be a 130MB download without consent.
    const vectorProxy = {
      stats: () => (vectorIndex ? vectorIndex.stats() : { notes: 0, chunks: 0, ready: false }),
      query: (vec, k) => (vectorIndex ? vectorIndex.query(vec, k) : []),
    };
    // Query embedder wrapper. Fusion only reaches this AFTER vectorProxy.stats()
    // reports ready+populated — which only happens post-Build — so it is provably
    // unreachable before the flag. It must NEVER trigger the download itself:
    // ensureReady is the Build path's job, not the query path's.
    const embedQuery = (q) => embedClient.embedQuery(q);
    askController = createAskController({
      index: getAskIndex(),
      fusion: createFusion(getAskIndex(), { vector: vectorProxy, embedQuery }),
      registry: askRegistry,
      onState: (s) => { askPanel?.update(s); },
    });
  }
  if (!askPanel) {
    const el = document.getElementById('ask-panel');
    if (!el) return; // no drawer mount in this environment — controller still exists
    // Read the persisted opt-out so the download card never re-appears after a past
    // dismiss (best-effort; a read failure just leaves the card eligible to show).
    let aiDeclined = false;
    try { aiDeclined = !!(await chrome.storage.local.get(AI_DECLINED_KEY))[AI_DECLINED_KEY]; } catch { /* best-effort */ }
    // [Task E12] The chip's quick actions, as data. builtinAskActions composes the
    // Summarize + Tidy descriptors; the panel renders one button per descriptor and
    // stays agnostic to what each does. Adding a skill later = append one descriptor
    // (here or by concatenating extras onto this list). Each action's non-panel deps
    // are injected here at composition time; the panel supplies ctx.ask at click time.
    const askActions = builtinAskActions({
      // [Task E11] Tidy quick action: run the deterministic, rule-based markdown tidy
      // (src/lib/tidy-markdown.js) on the CHIP'S note and apply it directly. Fully
      // SYNCHRONOUS — no model, no proposal, no pending state — so there is no
      // stale-edit window: read → tidy → replaceBody in one go. tidyMarkdown is
      // content-preserving by construction (it only fixes structural whitespace and
      // markers), so it applies without review. replaceBody keeps the editor's native
      // undo stack, so a single Ctrl+Z reverts it; when nothing changes we skip the
      // write entirely and just say so.
      // Returns a status string so the action can also post an IN-PANEL notice —
      // the editor sits BEHIND the drawer, so a body change alone is invisible from
      // the Ask panel (user-reported: "clicked Tidy, nothing happened").
      tidyNote: (noteId) => {
        if (!ui.current || ui.current.id !== noteId || !ui.editor) { toast('Open the note first', true); return 'no-note'; }
        const body = ui.current.body || '';
        const tidied = tidyMarkdown(body);
        if (tidied === body) { toast('Already tidy'); return 'unchanged'; }
        ui.editor.replaceBody(tidied); // undo-preserving apply (single Ctrl+Z reverts)
        toast('Tidied — Ctrl+Z to undo');
        return 'tidied';
      },
    });
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
      // [Task E12] Chip quick actions as data (Summarize + Tidy, composed above).
      actions: askActions,
      // [Task V4] Footer semantic segment: the host owns the status; the panel reads
      // it back on open()/refreshFooter(). onBuildSemantic drives the one-time build.
      getSemanticStatus: () => semanticStatus,
      onBuildSemantic: () => startSemanticBuild(),
    });
  }
}

// The Build click driver. Flip the footer to 'building', run buildSemanticIndex with
// progress surfaced to the footer, then 'ready'. .catch so a failed build resets the
// footer to 'off' (retryable) and never leaks an unhandled rejection — retrieval keeps
// working lexically throughout.
function startSemanticBuild() {
  if (semanticStatus.state === 'building') return; // ignore double-clicks
  setSemanticStatus({ state: 'building', progress: null });
  buildSemanticIndex({ onProgress: (progress) => setSemanticStatus({ state: 'building', progress }) })
    .catch((e) => {
      console.warn('semantic build failed', e);
      setSemanticStatus({ state: 'off' }); // nothing persisted on failure — let the user retry
    });
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

// --- [Task E16] Review-ask wiring ------------------------------------------------

// Persist the once-ever latch. Fire-and-forget + .catch — a write failure must never
// break a click handler, block a save, or leak an unhandled rejection.
function persistReviewAsked() {
  try { chrome.storage.local.set({ [REVIEW_ASKED_KEY]: true }).catch(() => {}); } catch { /* best-effort */ }
}

// Open the Chrome Web Store review page in a new tab. Called only from the [Rate it]
// click — a user gesture — so window.open is not popup-blocked. Wrapped so a blocked
// or failed open never throws into the handler (the banner still dismisses).
function openReviewPage() {
  try { window.open(REVIEW_STORE_URL, '_blank', 'noopener'); } catch { /* best-effort */ }
}

// Remove the banner. Re-affirms the latch (idempotent — the flag was already set when
// the banner showed) so any dismissal path provably persists owl:reviewAsked.
function dismissReviewBanner() {
  persistReviewAsked();
  document.getElementById('review-banner')?.remove();
}

// Show the one-time review ask: a slim persistent card in the bottom-right corner,
// ABOVE the transient #toast (NOT the toast — the toast auto-fades; this must wait for
// a deliberate choice). Showing it latches owl:reviewAsked immediately so it can never
// reappear, even if the user navigates away without touching a button. textContent
// only; it never steals focus and never blocks a save or an ask.
function showReviewBanner() {
  if (reviewAsked) return; // once EVER
  if (typeof document === 'undefined' || !document.body) return; // no DOM (non-UI import)
  if (document.getElementById('review-banner')) return; // already up — don't stack
  reviewAsked = true;   // in-memory latch: stop counting + block re-entry this session
  persistReviewAsked(); // and persist across future boots

  const card = document.createElement('div');
  card.id = 'review-banner';
  card.setAttribute('role', 'complementary');
  card.setAttribute('aria-label', 'Rate OWL-Note');

  const msg = document.createElement('span');
  msg.className = 'review-msg';
  msg.textContent = 'Enjoying OWL-Note? A rating helps a lot 🦉';

  const rate = document.createElement('button');
  rate.type = 'button';
  rate.className = 'review-rate';
  rate.textContent = 'Rate it';
  rate.addEventListener('click', () => { openReviewPage(); dismissReviewBanner(); });

  const no = document.createElement('button');
  no.type = 'button';
  no.className = 'review-dismiss';
  no.textContent = 'No thanks';
  no.addEventListener('click', dismissReviewBanner);

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'review-close';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '✕';
  close.addEventListener('click', dismissReviewBanner);

  const actions = document.createElement('div');
  actions.className = 'review-actions';
  actions.append(rate, no);

  card.append(close, msg, actions);
  document.body.append(card);
}

// Count a successful save toward the review ask. Cheap guard first — once the ask has
// been shown/dismissed we stop counting, so there's no unbounded storage growth. The
// whole body is try/caught so, called fire-and-forget, it can never break a save or leak
// an unhandled rejection. Both manual and auto saves count — either is a real value moment.
async function countSaveTowardReview() {
  if (reviewAsked) return; // already asked once, ever
  try {
    const n = (((await chrome.storage.local.get(REVIEW_SAVE_COUNT_KEY))[REVIEW_SAVE_COUNT_KEY]) || 0) + 1;
    await chrome.storage.local.set({ [REVIEW_SAVE_COUNT_KEY]: n });
    if (n >= REVIEW_SAVE_THRESHOLD) showReviewBanner();
  } catch { /* best-effort — never block a save */ }
}

// --- [Task E18] First-run Welcome note [onboarding] ------------------------------
// A brand-new install lands on a blank editor because the open-latest-note boot flow has
// no note to open. Fix: on the FIRST run (empty corpus + owl:welcomed unset) create ONE
// ordinary Welcome note via the REAL save path, so the landing always shows content. The
// flag is checked BEFORE emptiness, so deleting the note never resurrects it; an existing
// user (any notes) silently latches the flag and gets no surprise note.
const WELCOMED_KEY = 'owl:welcomed'; // once-ever latch (persisted): first run has been handled

// Test seam (mirrors __setSemanticFactoriesForTests): the failure test swaps in a save
// that throws to prove a creation hiccup never blocks boot or leaks an unhandled rejection.
// Production callers never touch this — the default IS the real saveNote.
let welcomeSaveImpl = saveNote;
export function __setWelcomeSaveForTests(fn) { welcomeSaveImpl = typeof fn === 'function' ? fn : saveNote; }

// Create the first-run Welcome note when (and only when) this install has never been
// welcomed AND the corpus is empty. Runs inside initUI — AFTER refreshPanes (so the
// emptiness probe can reuse ui.notes) and BEFORE
// the open-latest-note flow (so the editor lands on the new note). Gated on the Ask drawer
// being mounted (#ask-panel): the Welcome note is
// a full-app onboarding experience (it points at Ask Owl), so it
// stays inert in a bare harness/embedding without one — and app.html always mounts it.
// Fully guarded: it must never throw into boot.
async function maybeCreateWelcomeNote() {
  if (typeof document === 'undefined' || !document.getElementById('ask-panel')) return;
  let welcomed;
  try { welcomed = !!(await chrome.storage.local.get(WELCOMED_KEY))[WELCOMED_KEY]; }
  catch { return; } // storage unreadable — don't risk a duplicate; retried next boot
  if (welcomed) return; // first run already handled — never recreate (survives a delete)
  // Emptiness probe. At this point activeFolder is
  // still rootId, so ui.notes IS the whole corpus; guarded fallback to a direct read.
  let empty;
  try {
    empty = ui.activeFolder === ui.rootId
      ? !(ui.notes || []).some((n) => !n.draft)
      : (await loadNotes(ui.rootId)).length === 0;
  } catch { return; } // can't confirm emptiness — don't create
  // Existing user (any notes): latch the flag WITHOUT creating anything — no surprise note
  // now, and a later delete-everything can't resurrect one.
  if (!empty) { try { await chrome.storage.local.set({ [WELCOMED_KEY]: true }); } catch { /* best-effort */ } return; }
  // Empty + unflagged: create the Welcome note through the REAL save path so it is an
  // ordinary note (syncs, lists, deletes, indexes like any other — no special storage).
  const note = { ...createNote({ title: WELCOME_NOTE_TITLE, body: WELCOME_NOTE_BODY }), id: WELCOME_NOTE_ID };
  try {
    await welcomeSaveImpl(note, ui.rootId, undefined);
    await refreshPanes(); // repopulate ui.notes so the open-latest-note flow can land on it
    // Latch ONLY after a successful create. If this write fails, the next (now non-empty)
    // boot hits the existing-user branch above and latches then — still no duplicate.
    try { await chrome.storage.local.set({ [WELCOMED_KEY]: true }); } catch { /* best-effort */ }
  } catch (e) {
    // Storage/bookmark hiccup — leave the flag UNSET (retried next boot) and let boot
    // proceed exactly as before (a blank editor this once). Never a blocked boot or leak.
    console.warn('welcome note creation failed', e);
  }
}

export async function initUI(rootId) {
  ui.rootId = rootId;
  ui.activeFolder = rootId;
  ui.trashId = await ensureTrash(rootId);
  // Per-device sidebar collapse state (bookmark ids differ per device, so don't sync it).
  const storedCollapsed = (await chrome.storage.local.get('owl:collapsed'))['owl:collapsed'];
  ui.collapsed = new Set(Array.isArray(storedCollapsed) ? storedCollapsed : []);
  // [Task E16] Load the once-ever review-ask latch so a prior dismissal stays
  // suppressed across boots. Best-effort — a read failure just leaves it eligible.
  try { reviewAsked = !!(await chrome.storage.local.get(REVIEW_ASKED_KEY))[REVIEW_ASKED_KEY]; } catch { /* best-effort */ }
  // Repair notes whose bookmark URL embeds an old/foreign extension id (e.g. created
  // by an unpacked dev build) so clicking them opens this extension instead of being
  // blocked by Chrome. No-op once every note already uses the current id.
  try { await bm.healNoteUrls(rootId); } catch { /* best-effort; never block boot */ }
  await ensureAskUI(); // construct the Ask controller + drawer before the toolbar renders (needs askPanel)
  await initPanes();
  await refreshPanes();
  // [Task E18] First-run onboarding: create the Welcome note on a brand-new, empty install
  // so the open-latest-note flow below has content to land on instead of a blank editor.
  // Self-gating (flag + emptiness) and fully guarded, so it never blocks or breaks boot.
  await maybeCreateWelcomeNote();
  renderCurrentEditor();
  await openByHash();
  // Register before reading the one-shot value so a capture arriving during boot
  // cannot slip between the initial storage read and listener installation.
  await wireQuickCapture();
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
  // Boot catch-up: if the user opted into semantic search on a PRIOR run, silently
  // re-sync the vector index to the current corpus — a FLOATING, .catch-guarded promise
  // (same discipline as ui.indexReady) so it never delays first paint and a failure
  // (or a rejecting embed) degrades to lexical rather than surfacing. Gated inside
  // maybeCatchUpSemantic on the persisted flag, so a never-opted-in user does nothing
  // semantic at boot. ui.semanticReady lets tests await it deterministically.
  ui.semanticReady = maybeCatchUpSemantic().catch((e) => { console.warn('semantic boot catch-up failed:', e); });
  // A permanent delete performed while offline may have deferred Drive cleanup. Retry in
  // the background after launch; reference scanning keeps this safe across synced devices.
  void isEnabled()
    .then((enabled) => enabled && retryPendingDriveCleanup())
    .catch((e) => { console.warn('Drive cleanup retry failed:', e); });
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
  if (ui.query) notes = searchNotes(notes, ui.query);
  const list = orderNotes(notes);
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
    query: ui.query,
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
    onAsk: askPanel ? () => askPanel.open(document.activeElement) : null,
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
  for (const t of targets) { askIndex.removeNote(t.id); removeSemantic(t.id); } // trashed notes leave the live corpus (lexical + vector)
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
    for (const t of targets) { askIndex.removeNote(t.id); removeSemantic(t.id); } // purged notes are gone for good (no-op if never indexed, e.g. already in Trash)
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
      // .catch: a mid-mutation refresh can fail (a folder deleted by sync between the
      // event and the read — or, in tests, a stale pre-reset run). It must neither
      // become an unhandled rejection NOR die while holding the liveRefreshing lock:
      // a queued NEWER refresh still drains on the next pass, which is what actually
      // recovers the list. Same discipline as the index rebuild below.
      await refreshNoteList().catch((e) => console.warn('live refresh failed', e));
      // Rebuild the ask index on the SAME coalesced cycle as the note-list refresh:
      // a burst of external chrome.bookmarks events (Drive sync, another tab) collapses
      // into ONE rebuild per cycle via the do/while queue below — never one per event.
      // .catch: a rebuild failure here (e.g. a bad note) must not become a NEW
      // unhandled rejection or abort this refresh cycle — best-effort, like
      // bm.healNoteUrls above.
      await rebuildAskIndex().catch((e) => console.warn('ask index rebuild failed', e));
      // Mirror the coalesced rebuild into the vector index when semantic is on: an
      // external burst (Drive sync, another tab, a cross-notebook move/restore)
      // collapses into ONE catch-up per cycle, hash-diff-cheap (moves don't change
      // content → no-op by hash; restores re-add). .catch for the same reason as the
      // lexical rebuild above — a semantic hiccup must not abort this cycle or leak.
      if (semanticEnabled) await syncSemantic().catch((e) => console.warn('semantic rebuild failed', e));
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

// Reveal a note created by either context-menu command. Selection captures retain the
// non-disruptive list-only behavior. A full-page capture carries openNote:true: flush the
// current editor first, then open the exact captured note instead of merely showing it.
async function revealQuickCapture(capture) {
  if (!ui.rootId || !capture?.id) return; // not booted (or malformed signal)
  const openCapturedNote = capture.openNote === true;

  // Opening another note destroys the current editor and cancels its debounce timer.
  // Await the save first so focusing a capture cannot discard an in-progress edit.
  if (openCapturedNote && ui.current) await ui.editor?.flush?.();

  // A brand-new, not-yet-saved draft derives its CREATION folder from ui.activeFolder at
  // (debounced) save time, so switching to root here would silently file it in All notes
  // instead of the notebook the user is composing in. Don't disrupt an in-progress new
  // note: leave the folder as-is — the existing live-refresh still surfaces the capture,
  // and the user can navigate to root themselves. (Existing notes save in place regardless
  // of activeFolder, so they're unaffected.)
  const draftOpen = ui.isNew && ui.current && !ui.activeBookmarkId && !ui.activeLocalId;
  if (!draftOpen || openCapturedNote) {
    ui.activeFolder = ui.rootId;
    ui.query = '';
    ui.selected = new Set(); ui.anchor = null; ui.focus = -1;
  }
  await refreshPanes();

  if (!openCapturedNote) return;
  const target = (ui.notes || []).find((note) => note.id === capture.id);
  if (!target) throw new Error('The captured note could not be loaded');
  ui.focus = (ui.notes || []).filter((note) => !note.draft).findIndex((note) => note.id === capture.id);
  if (target.localOnly) await openLocalNote(target.id);
  else await openBookmark(target.bookmarkId);
  document.querySelector('#note-list .item.card.active')?.scrollIntoView?.({ block: 'nearest' });
}

function quickCaptureToken(capture) {
  return capture?.id ? `${capture.id}:${capture.at ?? ''}` : null;
}

async function consumeQuickCapture(capture) {
  const token = quickCaptureToken(capture);
  if (!token || token === lastQuickCaptureToken) return;
  lastQuickCaptureToken = token;
  try {
    await revealQuickCapture(capture);
  } catch (error) {
    // Leave a failed signal stored so the next app boot can retry it.
    if (lastQuickCaptureToken === token) lastQuickCaptureToken = null;
    throw error;
  }
  // Consume only the value we handled. A newer capture may arrive while the editor
  // is saving, and this older handler must never remove the newer signal.
  try {
    const current = (await chrome.storage.local.get(QUICK_CAPTURE_KEY))[QUICK_CAPTURE_KEY];
    if (quickCaptureToken(current) === token) await chrome.storage.local.remove(QUICK_CAPTURE_KEY);
  } catch { /* one-shot cleanup is best-effort */ }
}

function enqueueQuickCapture(capture) {
  // Preserve arrival order: if two captures complete close together, the newer one
  // must be the final note in focus rather than racing an older editor flush.
  quickCaptureQueue = quickCaptureQueue.catch(() => {}).then(() => consumeQuickCapture(capture));
  return quickCaptureQueue;
}

// Watch for the service worker's one-shot capture signal. Scoped to this key so ordinary
// storage writes and bookmark sync never yank the user's view. Read the stored value too:
// the worker writes it before opening OWL-Note, so a new app tab otherwise misses the
// onChanged event that occurred before its listener existed.
async function wireQuickCapture() {
  const c = typeof chrome !== 'undefined' ? chrome : undefined;
  if (!c?.storage?.local) return;
  c?.storage?.onChanged?.addListener((changes, area) => {
    const value = changes?.[QUICK_CAPTURE_KEY]?.newValue;
    if (area === 'local' && value) {
      enqueueQuickCapture(value).catch((e) => console.warn('quick-capture reveal failed', e));
    }
  });
  try {
    const pending = (await c.storage.local.get(QUICK_CAPTURE_KEY))[QUICK_CAPTURE_KEY];
    if (pending) await enqueueQuickCapture(pending);
  } catch (e) {
    console.warn('quick-capture restore failed', e);
  }
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
    onDropNote: async (folderId, draggedHandle) => {
      // Dragging any member of the current multi-selection moves the whole set.
      // A non-selected card keeps the familiar single-note behaviour even when
      // some other cards are selected.
      const handles = ui.selected.has(draggedHandle)
        ? [...ui.selected]
        : [draggedHandle];
      for (const handle of handles) await dropNote(handle, folderId);
      ui.selected = new Set(); ui.anchor = null; ui.focus = -1;
      await refreshPanes();
      toast(handles.length === 1 ? 'Note moved' : `${handles.length} notes moved`);
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
  ui.driveEnabled = await isEnabled();
  renderToolbar(document.getElementById('toolbar'), {
    query: ui.query,
    onSearch: async (q) => { ui.selected = new Set(); ui.anchor = null; ui.focus = -1; ui.query = q; await refreshNoteList(); },
    onExportMarkdown: () => doExportMarkdown(),
    onExportJson: doExport,
    onImport: (files) => doImportFiles(files),
    driveEnabled: ui.driveEnabled,
    onToggleDrive: async (checked) => {
      const result = await toggleDriveSync(checked);
      ui.driveEnabled = result;
      ui.editor?.setShareActionVisible?.('drive', result);
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
    created: ui.current ? (ui.current.created ?? ui.current.dateAdded) : null,
    updated: ui.current?.updated ?? null,
    recoverAttachments: async ({ body, attachments }) =>
      (await resolveReferencedAttachments({ body, attachments }, { rootId: ui.rootId })).attachments,
    focusTitle: !!opts.focusTitle,
    measure: measureNoteSize,
    onChange: ({ title, body, attachments }) => {
      if (ui.current) { ui.current.title = title; ui.current.body = body; ui.current.attachments = attachments; }
      // Keep the Ask drawer's context chip label in sync with TITLE edits too —
      // manual typing or the ✨ suggest-title fill (user-reported: chip kept the old
      // title). Cheap: rebuilds one small pill row; per-note dismissal survives
      // same-note refreshes by design.
      askPanel?.refreshChip?.();
    },
    onSave: async ({ title, body, attachments }, { auto = false } = {}) => {
      const existing = ui.current && (ui.activeBookmarkId || ui.activeLocalId);
      const note = existing
        ? withUpdatedContent(ui.current, { title, body, attachments })
        : createNote({ title, body, attachments });
      const folder = ui.activeLocalId
        ? (ui.activeLocalFolderId ?? ui.activeFolder)
        : (ui.activeFolder === ui.rootId ? ui.rootId : ui.activeFolder);
      const res = await saveNote(note, folder, ui.activeBookmarkId);
      const savedNote = res.note || note;
      ui.current = savedNote;
      ui.activeBookmarkId = res.bookmarkId;
      ui.activeLocalId = res.bookmarkId ? null : savedNote.id;
      ui.activeLocalFolderId = res.bookmarkId ? null : folder;
      ui.isNew = false;
      // Keep the ask index in sync with this save. Synchronous in-memory op — do NOT
      // await it. upsertNote replaces the note's stale chunks when its content hash
      // changed (edit), or just refreshes citation meta when only the folder moved.
      askIndex.upsertNote({
        ...savedNote, // id, title, body, hash
        bookmarkId: ui.activeBookmarkId || null,
        folderId: ui.activeLocalId ? (ui.activeLocalFolderId ?? folder) : folder,
        localOnly: !!ui.activeLocalId,
      });
      // Mirror the save into the vector index too, when semantic search is on. Same
      // fire-and-forget, .catch-guarded discipline as the lexical upsert above; hash-
      // diff means an unchanged body (e.g. a folder-only move) re-embeds nothing.
      upsertSemantic(savedNote);
      // [Task E16] Count this successful save toward the one-time review ask. Fire-and-
      // forget (its body is fully .catch-guarded) so it never delays or blocks the save;
      // a cheap in-memory guard stops all counting once the ask has been shown.
      countSaveTowardReview();
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
      return savedNote;
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
    shareActions: [
      { id: 'pdf', label: 'Share with PDF', run: shareNoteWithPdf },
      { id: 'drive', label: 'Create Drive share link', hidden: !ui.driveEnabled, run: createDriveShareLink },
      { id: 'owl-note', label: 'Export this note as .owl-note', run: exportSharedOwlNote },
    ],
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
    askIndex.removeNote(ui.current.id); removeSemantic(ui.current.id); // note left the live corpus (lexical + vector)
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
  for (const t of targets) { askIndex.removeNote(t.id); removeSemantic(t.id); } // the whole subtree's notes left the live corpus (lexical + vector)

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

function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function exportSharedOwlNote(snapshot) {
  try {
    toast('Creating .owl-note package…');
    const blob = await buildOwlNotePackage({ ...ui.current, ...snapshot }, getBytes);
    downloadBlob(blob, owlNoteFilename(snapshot.title));
    toast('Editable .owl-note copy exported');
  } catch (error) {
    console.warn('OWL-Note package export failed:', error);
    toast("Couldn't export this note — an attachment may be unavailable", true);
  }
}

async function pdfForSnapshot(snapshot) {
  updatePdfProgress({ percent: 0, label: 'Creating PDF…' });
  try {
    return await buildNotePdf(
      { ...ui.current, ...snapshot },
      { onProgress: ({ percent }) => updatePdfProgress({ percent, label: 'Creating PDF…' }) },
    );
  } catch (error) {
    hidePdfProgress();
    throw error;
  }
}

async function createDriveShareLink(snapshot) {
  try {
    if (!(await isEnabled())) {
      ui.driveEnabled = false;
      ui.editor?.setShareActionVisible?.('drive', false);
      toast('Enable Drive sync to create a Drive share link', true);
      return;
    }
    const confirmed = window.confirm(
      'Create a public read-only PDF link?\n\n'
      + 'A PDF copy of this note will be stored in your Google Drive. Anyone '
      + 'who receives the link can view it until you revoke access or delete the file in Drive.',
    );
    if (!confirmed) return;
    const blob = await pdfForSnapshot(snapshot);
    updatePdfProgress({ percent: null, label: 'Uploading PDF to Drive…' });
    const bytes = await verifiedPdfBytes(blob);
    const hash = `share-${SparkMD5.ArrayBuffer.hash(bytes.buffer)}`;
    let fileId = await driveClient.findByHash(hash);
    if (!fileId) {
      fileId = await driveClient.uploadFile({
        name: notePdfFilename(snapshot.title),
        mime: 'application/pdf',
        bytes,
        hash,
      });
    }
    const link = await driveClient.createPublicShareLink(fileId);
    showShareLinkDialog(link);
    hidePdfProgress();
    toast('Read-only Drive share link created');
  } catch (error) {
    hidePdfProgress();
    console.warn('Drive share failed:', error);
    toast("Couldn't create the Drive share link", true);
  }
}

async function shareNoteWithPdf(snapshot) {
  try {
    const blob = await pdfForSnapshot(snapshot);
    const file = await verifiedPdfFile(blob, notePdfFilename(snapshot.title));
    showPdfShareDialog({
      file,
      title: snapshot.title,
      download: (readyFile) => downloadBlob(readyFile, readyFile.name),
      onShared: () => toast('PDF shared'),
    });
    hidePdfProgress();
  } catch (error) {
    hidePdfProgress();
    console.warn('PDF share failed:', error);
    toast("Couldn't create the PDF", true);
  }
}

// Gather every saved note from the bookmark tree, decode it, and build the
// per-note markdown file list. Pure of DOM/download concerns so it is testable.
export async function collectExportEntries(root, fetchDriveBody = noteDrive.loadNoteBody) {
  const trashId = await ensureTrash(root);
  const folders = (await bm.listNotebooks(root)).filter((f) => f.id !== trashId);
  const raw = (await bm.allNotes(root)).filter((r) => r.folderId !== trashId);
  const notes = [];
  let skipped = 0;
  const seen = new Set();
  for (const r of raw) {
    try {
      let n = await decode(r.payload);
      // A Drive-offloaded note's bookmark is a body-less metadata stub. Hydrate it —
      // local mirror first (origin device, no fetch), else the Drive body — or the
      // export writes an empty .md that a later import silently skips, losing the
      // note across an export → import round-trip. If neither source is reachable,
      // the throw lands in the catch below: skipped, never exported empty.
      if (n && n._driveBody) {
        const backup = await mirror.getBackup(n.id);
        if (backup && backup.current && backup.current.body !== undefined && backup.current.hash === n.hash) n = backup.current;
        else n = await decode(await fetchDriveBody(n._driveBody));
      }
      // Async inlining: offloaded attachments (driveFileId, no dataUri) resolve via the
      // local byte cache or Drive; unresolvable refs stay as-is instead of corrupting.
      notes.push({ id: n.id, title: n.title, body: await inlineImagesAsync(n.body, n.attachments, getBytes), folderId: r.folderId });
      if (n.id) seen.add(n.id);
    } catch {
      skipped += 1; // unreadable payload or unreachable Drive body — leave it out rather than abort the export
    }
  }
  // Device-local notes (e.g. image notes too large to be bookmarks) have no
  // bookmark, so include them from the mirror — images inlined so each exported
  // .md stays self-contained.
  for (const ln of await mirror.allLocalOnly()) {
    if (ln && ln.id && !seen.has(ln.id) && ln.folderId !== trashId) {
      notes.push({ id: ln.id, title: ln.title, body: await inlineImagesAsync(ln.body, ln.attachments, getBytes), folderId: ln.folderId });
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

function importedTimestamp(value) {
  if (value == null || value === '') return null;
  const timestamp = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

async function importOne({ id, title, body, attachments, created, updated }, targetFolderId, ctx) {
  const { idMap, tally } = ctx;
  // Imported ids are untrusted. Strip angle brackets so a crafted id can never forge
  // the <<<NOTE c:...>>> sentinel the Ask prompt wraps chunks in — the chunk id
  // round-trips as a citation key, so it must be sanitized here at ingestion (a fixed
  // choke point for every import format), not in the prompt where it can't be altered.
  const safeId = typeof id === 'string' ? id.replace(/[<>]/g, '') : id;
  const existing = safeId ? idMap.get(safeId) : undefined;
  const now = Date.now();
  const createdAt = importedTimestamp(created) ?? now;
  const updatedAt = importedTimestamp(updated) ?? createdAt;
  const note = {
    id: safeId || crypto.randomUUID(),
    title,
    body,
    attachments: attachments || [],
    created: createdAt,
    updated: updatedAt,
    version: 1,
    hash: contentHash(body),
  };
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
// Progress: each file is one unit of work; parsing a container (.zip/.enex/.json)
// grows the total by its inner note count. onProgress (optional) receives monotonic
// {done, total} ticks and always ends with done === total, even on unreadable files.
export async function importFiles(files, onProgress) {
  const root = ui.rootId ?? (await bm.ensureRoot());
  const ctx = { root, idMap: await buildIdMap(root), nbCache: new Map(), tally: { created: 0, updated: 0, skipped: 0, tooLarge: 0 }, touched: new Set() };
  const progress = { done: 0, total: files.length };
  const report = () => { if (onProgress) onProgress({ ...progress }); };
  report();
  for (const file of files) {
    const name = (file.name || '').toLowerCase();
    let pending = 1; // this file's unfinished units: its own parse + discovered notes
    const discover = (n) => { progress.total += n; pending += n; report(); };
    const step = () => { progress.done += 1; pending -= 1; report(); };
    try {
      if (name.endsWith('.owl-note')) {
        const imported = await parseOwlNotePackage(new Uint8Array(await file.arrayBuffer()));
        // A shared note is always an independent editable copy, never an update of
        // the sender's original id (even if this package is imported twice).
        await importOne({ ...imported, id: undefined }, root, ctx);
        step();
      } else if (name.endsWith('.zip')) {
        const entries = (await unzip(new Uint8Array(await file.arrayBuffer())))
          .filter((e) => e.path.toLowerCase().endsWith('.md'));
        discover(entries.length); step(); // file parsed; each entry is now its own unit
        for (const entry of entries) {
          await importMarkdown(new TextDecoder().decode(entry.bytes), entry.path, true, ctx);
          step();
        }
      } else if (name.endsWith('.md')) {
        await importMarkdown(await file.text(), file.name, false, ctx);
        step();
      } else if (name.endsWith('.enex')) {
        const notes = parseEnexNotes(await file.text());
        const folder = await findOrCreateNotebook(ctx.root, enexStem(file.name) || 'Imported', ctx.nbCache);
        discover(notes.length); step();
        for (const n of notes) {
          if (!n.body.trim()) { ctx.tally.skipped += 1; step(); continue; }
          const prepared = await prepareImport(n.body);
          await importOne({ id: n.meta.id, title: n.title, body: prepared.body, attachments: prepared.attachments }, folder, ctx);
          step();
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
        step();
      } else if (name.endsWith('.json')) {
        const data = JSON.parse(await file.text());
        const notes = Array.isArray(data.notes) ? data.notes : [];
        discover(notes.length); step();
        for (const n of notes) {
          if (!n || typeof n.id !== 'string') { step(); continue; }
          const prepared = await prepareImport(n.body || '', n.attachments || []);
          await importOne({
            id: n.id,
            title: n.title || extractTitle(prepared.body),
            body: prepared.body,
            attachments: prepared.attachments,
            created: n.created,
            updated: n.updated,
          }, root, ctx);
          step();
        }
      } else {
        ctx.tally.skipped += 1;
        step();
      }
    } catch { // couldn't read this file — continue the batch
      ctx.tally.skipped += 1;
      progress.done += pending; pending = 0; report(); // close out its units so the bar still completes
    }
  }
  return { ...ctx.tally, touched: [...ctx.touched] };
}

async function doImportFiles(files) {
  // This runs fire-and-forget from the toolbar's file input. It must NEVER fail
  // silently: a throw anywhere in the import used to escape uncaught — the progress
  // bar vanished and the user saw no toast and no refresh, indistinguishable from
  // "nothing happened" (user-reported). Whatever happens: the user gets feedback,
  // and the panes re-render (a failed import may still have partially landed).
  let t;
  try { t = await importFiles(files, renderImportProgress); }
  catch (e) {
    console.warn('import failed', e);
    toast('Import failed — nothing (or only part) was imported', true);
  }
  finally { renderImportProgress(null); } // the summary toast (or the error) takes over from here
  if (t) {
    const parts = [`${t.created} new`, `${t.updated} updated`];
    if (t.tooLarge) parts.push(`${t.tooLarge} local-only (not synced — use Export → Import to copy to other devices)`);
    if (t.skipped) parts.push(`${t.skipped} skipped`);
    toast(`Imported: ${parts.join(', ')}`, t.tooLarge > 0 || t.skipped > 0);
  }
  try {
    await refreshPanes(); // updates ui.notebooks with the newly created folders
    // Reveal what was imported: expand the folders it landed in (and their ancestors) and show
    // them, so the user doesn't have to hunt for or expand the tree. Select the single imported
    // folder if there's exactly one, otherwise fall back to root ("All notes").
    const touched = ((t && t.touched) || []).filter((f) => f && f !== ui.rootId);
    for (const f of touched) expandToReveal(f);
    ui.activeFolder = touched.length === 1 ? touched[0] : ui.rootId;
    await refreshPanes();
  } catch (e) { console.warn('post-import refresh failed', e); }
}

// Boot is implemented incrementally; guarded so tests importing saveNote don't run UI.
export async function boot() {
  // Chrome's "Create shortcut" launches app.html itself, bypassing action.onClicked.
  // Register every app tab so action clicks still find it on browsers that predate
  // runtime.getContexts. Plain launches are deduplicated; #note bookmarks only register.
  if (chrome.runtime?.sendMessage) {
    try {
      const currentTab = await chrome.tabs?.getCurrent?.();
      const claim = await chrome.runtime.sendMessage({
        type: 'owl-app-opened',
        dedupe: !location.hash,
        tabId: currentTab?.id,
        windowId: currentTab?.windowId,
      });
      if (claim?.reused) {
        // The worker removes tab-backed duplicates. window.close is the fallback for
        // Chrome shortcut/app-window contexts that do not expose a tab id.
        try { window.close(); } catch { /* best-effort */ }
        return;
      }
    } catch { /* service worker unavailable — continue booting this tab */ }
  }
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
