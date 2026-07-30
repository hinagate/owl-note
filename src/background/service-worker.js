// src/background/service-worker.js
import { ensureRoot, isNoteUrl, payloadFromUrl, listNotebooks, createNotebook } from '../lib/bookmarks.js';
import {
  startSession, appendCues, getSession, getSessionMeta, getSessionTail, patchSession,
  stopSession, clearSession, isSilent,
} from '../lib/capture-session.js';
import { buildTranscriptNote, cuesToMarkdown } from '../lib/transcript.js';
import { decode } from '../lib/codec.js';
import { captureFullPage } from '../lib/full-page-capture.js';
import { captureSmartPage } from '../lib/smart-page-capture.js';
import { captureSmartSelection } from '../lib/smart-selection-capture.js';
import { saveBackup } from '../lib/mirror.js';
import { contentHash, createNote } from '../lib/note.js';
import { saveNote } from '../lib/save-note.js';
import { buildQuickNote } from '../lib/quick-note.js';

const SAVE_SELECTION_ID = 'owl-save-selection';
const CAPTURE_FULL_PAGE_ID = 'owl-capture-full-page';
const CAPTURE_SMART_PAGE_ID = 'owl-capture-smart-page';
const TRANSCRIBE_ID = 'owl-transcribe-video';
const TRANSCRIPTS_NOTEBOOK = 'Transcripts';
const TRANSCRIBE_ARM_KEY = 'owl:transcribeArm';
const TRANSCRIBE_ARM_TTL_MS = 30 * 60 * 1000;
const TRANSCRIBE_SETUP_TEXT = 'One-time language download: click “Enable and continue” in the OWL-Note window.';
// Only reachable when the page navigated out from under a starting session, which
// revokes activeTab. A plain repeat of the gesture re-grants it.
const TRANSCRIBE_REINVOKE_TEXT = 'This page changed while transcription was starting. Right-click “Live Transcription save to OWL-Note” again.';
const APP_OPENED_MESSAGE = 'owl-app-opened';
const APP_TAB_KEY = 'owl:appTab';
// A one-shot signal the app tab watches (chrome.storage.onChanged): after a capture it
// jumps to All notes (root) so the new note shows on top. Carries {id, at} — a fresh
// timestamp each time so back-to-back captures always register as a change.
const QUICK_CAPTURE_KEY = 'owl:quickCapture';

export async function handleInstalled() {
  await ensureRoot();
  // Both commands are explicit gestures and therefore grant temporary activeTab.
  chrome.contextMenus?.create({ id: SAVE_SELECTION_ID, title: 'Save selection to OWL-Note', contexts: ['selection'] });
  chrome.contextMenus?.create({ id: CAPTURE_SMART_PAGE_ID, title: 'Rebuild LLM chat to OWL-Note', contexts: ['page'] });
  chrome.contextMenus?.create({ id: CAPTURE_FULL_PAGE_ID, title: 'Capture entire page to OWL-Note', contexts: ['page'] });
  chrome.contextMenus?.create({ id: TRANSCRIBE_ID, title: 'Live Transcription save to OWL-Note', contexts: ['page', 'video'] });
}

export async function handleActionClick(tab) {
  await focusOrOpenApp();
}

// Capture the selected DOM while the context-menu click grants activeTab access.
// Restricted pages and browser-internal URLs reject injection; callers then use
// contextMenus.selectionText as a quoted plain-text fallback.
export async function captureRichSelection(info, tab, capture = captureSmartSelection) {
  if (!Number.isInteger(tab?.id) || !chrome.scripting?.executeScript) return null;
  try {
    return await capture(info, tab, { onProgress: showCaptureProgress });
  } catch {
    return null;
  }
}

// Save the right-clicked selection as a formatted note with a source URL, then
// bring OWL-Note to the front so the capture is immediately visible on top of All notes.
export async function handleSaveSelection(info, tab, capture = captureRichSelection) {
  if (info.menuItemId !== SAVE_SELECTION_ID) return;
  const selection = (info.selectionText || '').trim();
  const url = info.pageUrl || (tab && tab.url) || '';
  const title = (tab && tab.title) || ''; // best-effort; no `tabs` permission required
  const rich = await capture(info, tab);
  if (!selection && !rich?.markdown?.trim()) return;
  const { title: noteTitle, body } = buildQuickNote({
    title: rich?.title || title,
    url,
    selection,
    selectionMarkdown: rich?.markdown || '',
  });
  const note = createNote({ title: noteTitle, body, attachments: rich?.attachments || [] });
  const root = await ensureRoot();
  await saveNote(note, root, undefined);
  // Signal the (possibly already-open) app tab to reveal it, THEN focus/open the tab.
  // Written first so an open tab reacts as it comes forward; best-effort, never fatal.
  await signalQuickCapture(note, { openNote: true });
  await focusOrOpenApp();
  await flashSaved();
}

function cleanCaptureTitle(value) {
  return String(value || '').replace(/\s+/g, ' ').trim() || 'Full-page capture';
}

function captureFilename(title) {
  const stem = cleanCaptureTitle(title)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/[. ]+$/g, '')
    .slice(0, 80) || 'full-page';
  return `${stem}.jpg`;
}

function markdownAlt(value) {
  return cleanCaptureTitle(value).replace(/[\\\[\]]/g, '\\$&');
}

async function signalQuickCapture(note, { openNote = false } = {}) {
  try {
    await chrome.storage?.local?.set?.({
      [QUICK_CAPTURE_KEY]: { id: note.id, at: Date.now(), openNote },
    });
  } catch { /* best-effort */ }
}

async function showCaptureProgress({ completed = 0, total = 1 } = {}) {
  try {
    const percent = Math.min(99, Math.round((completed / Math.max(1, total)) * 100));
    await chrome.action?.setBadgeText?.({ text: `${percent}%` });
    await chrome.action?.setBadgeBackgroundColor?.({ color: '#3567c8' });
    await chrome.action?.setTitle?.({ title: `OWL-Note — capturing page (${completed}/${total})` });
  } catch { /* progress is cosmetic */ }
}

async function flashCaptureError(error) {
  const reason = String(error?.message || error || 'Capture failed').slice(0, 160);
  try {
    await chrome.action?.setBadgeText?.({ text: '!' });
    await chrome.action?.setBadgeBackgroundColor?.({ color: '#b3261e' });
    await chrome.action?.setTitle?.({ title: `OWL-Note — ${reason}` });
    setTimeout(() => {
      chrome.action?.setBadgeText?.({ text: '' });
      chrome.action?.setTitle?.({ title: 'Open OWL-Note' });
    }, 8000);
  } catch { /* badge is cosmetic */ }
}

// Capture before focusing OWL-Note (captureVisibleTab always targets the active
// tab), stitch locally, then use the normal attachment and optional Drive path.
export async function handleCaptureFullPage(info, tab, capture = captureFullPage) {
  if (info.menuItemId !== CAPTURE_FULL_PAGE_ID) return null;
  try {
    await showCaptureProgress({ completed: 0, total: 1 });
    const captured = await capture(tab, { onProgress: showCaptureProgress });
    if (!captured?.dataUri) throw new Error('The browser returned an empty capture');

    const title = cleanCaptureTitle(tab?.title);
    const id = contentHash(captured.dataUri);
    const attachment = {
      id,
      name: captureFilename(title),
      mime: captured.mime || 'image/jpeg',
      dataUri: captured.dataUri,
      width: captured.width,
      height: captured.height,
    };
    const imageRef = `![${markdownAlt(title)}](owl-img:${id})`;
    const { body } = buildQuickNote({
      title,
      url: info.pageUrl || tab?.url || '',
      selectionMarkdown: imageRef,
    });
    const note = createNote({ title, body, attachments: [attachment] });
    const root = await ensureRoot();
    const saved = await saveNote(note, root, undefined);
    // Unlike a clipped selection, a full-page screenshot is the user's explicit
    // destination: ask the app to open this exact note, not merely reveal it in the list.
    await signalQuickCapture(note, { openNote: true });
    await focusOrOpenApp();
    await flashSaved();
    return { note, saved, captured };
  } catch (error) {
    console.warn('[owl-note] Full-page capture failed:', error);
    await flashCaptureError(error);
    return null;
  }
}

// Rebuild a readable page as editable Markdown and copy its rendered content images as
// OWL-Note attachments. This remains distinct from full-page screenshot capture: users
// can choose a faithful bitmap or a semantic note depending on what they need.
export async function handleCaptureSmartPage(info, tab, capture = captureSmartPage) {
  if (info.menuItemId !== CAPTURE_SMART_PAGE_ID) return null;
  try {
    await showCaptureProgress({ completed: 0, total: 1 });
    const converted = await capture(tab, { onProgress: showCaptureProgress });
    if (!converted?.markdown) throw new Error('The page did not contain readable content');

    const title = cleanCaptureTitle(converted.title || tab?.title);
    const { body } = buildQuickNote({
      title,
      url: info.pageUrl || tab?.url || '',
      selectionMarkdown: converted.markdown,
    });
    const note = createNote({ title, body, attachments: converted.attachments || [] });
    const root = await ensureRoot();
    const saved = await saveNote(note, root, undefined);
    await signalQuickCapture(note, { openNote: true });
    await focusOrOpenApp();
    await flashSaved();
    return { note, saved, converted };
  } catch (error) {
    console.warn('[owl-note] Smart page capture failed:', error);
    await flashCaptureError(error);
    return null;
  }
}

// ─────────────────────────────────────────────────────────── transcription
// Chrome-native, on-device, no fallback: either Web Speech confirms that the
// requested local language resource is ready or no tab audio is captured. The
// service worker owns the session; the page overlay is only a view of it.

let lastVideoTime = null; // most recent player position reported by the overlay
let asrStarting = false; // a double-click must not start two readiness checks
let captureStarting = false; // two ready messages must not mint two streams

function sessionToken(session) {
  return `${session?.tabId}:${session?.startedAt}`;
}

// The only setup step that can remain: SpeechRecognition.install() needs a user
// gesture in an extension page, so it lives in this small popup. tabCapture is a
// required permission, so nothing here touches chrome.permissions.
async function openLanguageSetup(lang) {
  try {
    await chrome.windows.create({
      url: chrome.runtime.getURL(`enable.html?lang=${encodeURIComponent(lang || 'en-US')}`),
      type: 'popup',
      width: 460,
      height: 460,
    });
  } catch (error) {
    console.warn('[owl-note] Could not open the language setup window:', error);
  }
}

async function showOverlay(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['overlay.js'] });
    return true;
  } catch (error) {
    await patchSession({ status: { asr: 'error', error: `overlay: ${error?.message || error}` } });
    return false;
  }
}

function updateOverlay(tabId, patch) {
  try {
    const pending = chrome.tabs?.sendMessage?.(tabId, { type: 'owl-overlay-update', ...patch });
    pending?.catch?.(() => {});
  } catch { /* tab gone */ }
}

function transcribeArmStore() {
  return chrome.storage?.session || chrome.storage?.local;
}

async function getArmedTranscription() {
  try {
    const armed = (await transcribeArmStore()?.get?.(TRANSCRIBE_ARM_KEY))?.[TRANSCRIBE_ARM_KEY];
    if (!armed) return null;
    if (Date.now() - Number(armed.armedAt || 0) <= TRANSCRIBE_ARM_TTL_MS) return armed;
    await clearArmedTranscription(armed.tabId);
  } catch { /* unavailable storage means no armed action */ }
  return null;
}

async function armTranscription({ tabId, windowId, url, title, lang }) {
  const armed = {
    tabId,
    windowId,
    url: url || '',
    title: title || 'Transcript',
    lang: lang || 'en-US',
    armedAt: Date.now(),
  };
  await transcribeArmStore()?.set?.({ [TRANSCRIBE_ARM_KEY]: armed });
  return armed;
}

async function clearArmedTranscription(tabId) {
  try { await transcribeArmStore()?.remove?.(TRANSCRIBE_ARM_KEY); } catch { /* best-effort */ }
}

export async function handleTranscribe(info, tab) {
  if (info.menuItemId !== TRANSCRIBE_ID) return null;
  const tabId = tab?.id;
  if (!Number.isInteger(tabId)) return null;
  const lang = chrome.i18n?.getUILanguage?.() || 'en-US';
  const title = cleanCaptureTitle(tab?.title);

  // A context-menu click is an explicit activeTab invocation, and Chrome folds
  // per-tab capture access into that same grant because tabCapture is a required
  // permission. So the FIRST right-click can start transcribing — no page reload,
  // no repeated gesture, no pinned toolbar icon. Moving tabCapture back to
  // optional_permissions would cost both again: the grant is computed at the
  // instant of the gesture, and a permission granted afterwards cannot be
  // backfilled into a grant that already exists.
  //
  // Inject first: a restricted page must fail here, before a session exists, so
  // nothing is ever captured without a visible overlay.
  if (!(await showOverlay(tabId))) return null;

  return startTranscription({
    tabId,
    windowId: tab?.windowId,
    url: info.pageUrl || tab?.url || '',
    title: title === 'Full-page capture' ? 'Transcript' : title,
    lang,
  });
}

async function startTranscription(armed) {
  if (!armed || !Number.isInteger(armed.tabId)) return false;
  await clearArmedTranscription(armed.tabId);
  lastVideoTime = null;
  await startSession(armed);
  if (!(await showOverlay(armed.tabId))) {
    await clearSession();
    return true;
  }
  updateOverlay(armed.tabId, { canSave: true, armed: false });
  await handleStartAsr();
  return true;
}

// The language download is finished. Installing it happened in an extension
// window, which never navigated the source tab, so that tab's activeTab grant —
// capture access included — is still live: return to the video and just start.
export async function handleTranscribeSetupComplete() {
  const armed = await getArmedTranscription();
  if (!armed) return null;
  try { await chrome.tabs?.update?.(armed.tabId, { active: true }); } catch { /* tab may have closed */ }
  if (Number.isInteger(armed.windowId)) {
    try { await chrome.windows?.update?.(armed.windowId, { focused: true }); } catch { /* best-effort */ }
  }
  return startTranscription(armed);
}

export async function handleCancelArmedTranscription() {
  const armed = await getArmedTranscription();
  if (!armed) return null;
  await clearArmedTranscription(armed.tabId);
  try { await chrome.tabs?.sendMessage?.(armed.tabId, { type: 'owl-overlay-close' }); } catch { /* tab gone */ }
  return true;
}

// While the language downloads, the armed marker holds the session that will
// resume once setup finishes. Navigating that tab revokes activeTab and destroys
// the injected overlay, so the marker becomes unresumable the moment a reload
// starts: drop it and the dead overlay rather than auto-starting into a capture
// error. The reloaded page is a clean slate — one right-click starts it again.
export async function handleTranscribeTabUpdated(tabId, changeInfo = {}) {
  if (changeInfo.status !== 'loading') return null;
  const armed = await getArmedTranscription();
  if (!armed || armed.tabId !== tabId) return null;
  await clearArmedTranscription(tabId);
  try { await chrome.tabs?.sendMessage?.(tabId, { type: 'owl-overlay-close' }); } catch { /* old document already gone */ }
  return true;
}

// Retrying audio must first release the stream the previous attempt is holding.
// Chrome refuses a second capture of the same tab with "Cannot capture a tab with
// an active stream", and closing the offscreen document is what actually frees it.
async function releaseCapture() {
  try { await chrome.runtime.sendMessage({ target: 'offscreen', type: 'owl-offscreen-stop' }); } catch { /* no doc */ }
  try {
    if (await chrome.offscreen?.hasDocument?.()) await chrome.offscreen.closeDocument();
  } catch { /* nothing open */ }
}

async function ensureOffscreen() {
  if (await chrome.offscreen?.hasDocument?.()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Transcribe captured tab audio on-device.',
  });
}

export async function handleStartAsr(lang) {
  const session = await getSessionMeta();
  if (!session || asrStarting) return null;
  asrStarting = true;
  const useLang = lang || session.lang;
  try {
    await patchSession({ lang: useLang, status: { asr: 'starting', error: null } });
    updateOverlay(session.tabId, { state: 'checking native speech', text: 'Checking Chrome’s local speech model…' });
    await releaseCapture();
    await ensureOffscreen();
    await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'owl-offscreen-prepare',
      lang: useLang,
      sessionToken: sessionToken(session),
    });
  } catch (error) {
    const message = String(error?.message || error);
    await patchSession({ status: { asr: 'error', error: message } });
    updateOverlay(session.tabId, { state: 'error', text: message });
    await releaseCapture(); // never leave a half-open capture pinning the tab
  } finally {
    asrStarting = false;
  }
  return true;
}

export async function handleNativeSpeechReady(lang, readyToken) {
  const session = await getSessionMeta();
  if (!session || session.state !== 'recording' || captureStarting) return null;
  if (lang && lang !== session.lang) return null; // stale result from an earlier check
  if (readyToken !== sessionToken(session)) return null;
  if (['starting-capture', 'listening'].includes(session.status?.asr)) return null;
  captureStarting = true;
  try {
    await patchSession({ status: { asr: 'starting-capture', error: null } });
    updateOverlay(session.tabId, { state: 'starting', text: 'Listening for speech…' });
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: session.tabId });
    await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'owl-offscreen-start',
      streamId,
      lang: session.lang,
      sessionToken: readyToken,
    });
  } catch (error) {
    const message = String(error?.message || error);
    await releaseCapture();
    if (/not been invoked|activeTab permission/i.test(message)) {
      // Park the target so the overlay's Cancel button still has something to
      // clear; the next right-click supersedes it either way.
      await armTranscription(session);
      await clearSession();
      updateOverlay(session.tabId, {
        state: 'needs another right-click',
        text: TRANSCRIBE_REINVOKE_TEXT,
        canSave: false,
        armed: true,
      });
    } else {
      await patchSession({ status: { asr: 'error', error: message } });
      updateOverlay(session.tabId, { state: 'error', text: message });
    }
  } finally {
    captureStarting = false;
  }
  return true;
}

export async function handleNativeSpeechInstallRequired(lang, readyToken) {
  const session = await getSessionMeta();
  if (!session || session.state !== 'recording') return null;
  if (lang && lang !== session.lang) return null;
  if (readyToken !== sessionToken(session)) return null;
  // Preserve the source page untouched while the user installs the language
  // resource: leaving it un-navigated is what keeps its activeTab grant alive,
  // so handleTranscribeSetupComplete can resume without another gesture.
  await releaseCapture();
  await armTranscription(session);
  await clearSession();
  updateOverlay(session.tabId, {
    state: 'one-time setup',
    text: TRANSCRIBE_SETUP_TEXT,
    canSave: false,
    armed: true,
  });
  await openLanguageSetup(session.lang);
  return true;
}

async function teardownEngines(tabId) {
  await releaseCapture();
  try { await chrome.tabs?.sendMessage?.(tabId, { type: 'owl-overlay-close' }); } catch { /* tab gone */ }
}

export async function handleStopCapture() {
  const session = await getSessionMeta();
  if (!session) return null;
  await stopSession();
  await teardownEngines(session.tabId);
  return true;
}

// A paused session resumes by re-injecting the overlay: the old one died with the
// page it was drawn on.
export async function handleResumeCapture() {
  const session = await getSessionMeta();
  if (!session || session.state !== 'paused') return null;
  if (await showOverlay(session.tabId)) {
    await patchSession({ state: 'recording', lastCueAt: Date.now() });
    updateOverlay(session.tabId, { canSave: true, armed: false });
  }
  return true;
}

async function ensureTranscriptsNotebook() {
  const root = await ensureRoot();
  try {
    const existing = (await listNotebooks(root)).find((n) => n.title === TRANSCRIPTS_NOTEBOOK);
    return existing ? existing.id : await createNotebook(root, TRANSCRIPTS_NOTEBOOK);
  } catch {
    return root; // never lose a transcript over a notebook that refused to create
  }
}

export async function handleSaveTranscript() {
  const session = await getSession();
  if (!session) return null;
  await stopSession();
  await teardownEngines(session.tabId);
  if (!session.cues?.length) {
    await clearSession();
    return null;
  }
  const { title, body } = buildTranscriptNote({
    title: session.title || 'Transcript',
    url: session.url,
    cues: session.cues,
    startedAt: session.startedAt,
    endedAt: session.endedAt || Date.now(),
  });
  try {
    const note = createNote({ title: title || 'Transcript', body });
    const saved = await saveNote(note, await ensureTranscriptsNotebook(), undefined);
    await clearSession();
    await signalQuickCapture(note, { openNote: true });
    await focusOrOpenApp();
    await flashSaved();
    return { note, saved };
  } catch (error) {
    console.warn('[owl-note] Saving the transcript failed:', error);
    await flashCaptureError(error);
    return null;
  }
}

export async function handleDiscardTranscript() {
  const session = await getSessionMeta();
  const armed = await getArmedTranscription();
  const tabId = session?.tabId ?? armed?.tabId;
  if (Number.isInteger(tabId)) await teardownEngines(tabId);
  if (armed) await clearArmedTranscription(armed.tabId);
  await clearSession();
  return true;
}

// Closing the captured tab ends the session and keeps what was said — losing an
// hour of lecture to a stray Ctrl+W would be unforgivable.
export async function handleTabClosed(tabId) {
  const armed = await getArmedTranscription();
  if (armed?.tabId === tabId) {
    await clearArmedTranscription(tabId);
    return true;
  }
  const session = await getSessionMeta();
  if (!session || session.tabId !== tabId || session.state === 'stopped') return null;
  return handleSaveTranscript();
}

// A recording nobody stopped — laptop closed, tab forgotten. Finish it rather
// than leave a session that looks live forever.
export async function finalizeIfSilent() {
  const session = await getSessionMeta();
  if (session && isSilent(session)) await handleStopCapture();
}

// Web Speech receives an audio track, not a video player, so its cues carry no
// position. Stamp them with the player time the overlay last reported.
async function appendAsrCues(cues) {
  const stamped = (cues || []).map((cue) => (
    cue.videoTime == null && lastVideoTime != null ? { ...cue, videoTime: lastVideoTime } : cue
  ));
  const count = await appendCues(stamped);
  if (!count) return 0;
  const session = await getSessionTail();
  if (session) {
    updateOverlay(session.tabId, { text: cuesToMarkdown(session.cues).replace(/\n+/g, ' '), state: 'listening' });
  }
  return count;
}

async function showInterimCaption(text) {
  const session = await getSessionMeta();
  if (!session || session.state !== 'recording') return null;
  updateOverlay(session.tabId, { text: String(text || ''), state: 'listening' });
  return true;
}

async function applyCaptureStatus(status = {}) {
  const session = await patchSession({ status });
  if (session) {
    const state = status.asr === 'error' ? 'error'
      : status.asr === 'checking' ? 'checking native speech'
        : status.asr === 'downloading' ? 'downloading speech resource'
          : status.asr === 'needs-install' ? 'setup required'
            : status.asr === 'restarting' ? 'reconnecting'
              : status.asr === 'listening' ? 'listening' : undefined;
    updateOverlay(session.tabId, {
      state,
      ...(status.interim ? { text: status.interim } : {}),
      ...(status.asr === 'error' ? { text: status.error } : {}),
    });
  }
  return session;
}

export function handleCaptureMessage(message) {
  switch (message?.type) {
    case 'owl-cue': return appendAsrCues(message.cues);
    case 'owl-interim': return showInterimCaption(message.text);
    case 'owl-capture-status': return applyCaptureStatus(message.status);
    case 'owl-capture-paused': return patchSession({ state: 'paused' });
    case 'owl-video-time': lastVideoTime = message.videoTime; return true;
    case 'owl-overlay-ready': lastVideoTime = message.videoTime; return true;
    case 'owl-native-speech-ready':
      return handleNativeSpeechReady(message.lang, message.sessionToken);
    case 'owl-native-speech-install-required':
      return handleNativeSpeechInstallRequired(message.lang, message.sessionToken);
    case 'owl-transcribe-setup-complete': return handleTranscribeSetupComplete();
    case 'owl-transcribe-setup-cancelled':
    case 'owl-panel-cancel-arm': return handleCancelArmedTranscription();
    case 'owl-panel-stop': return handleStopCapture();
    case 'owl-panel-save': return handleSaveTranscript();
    case 'owl-panel-discard': return handleDiscardTranscript();
    case 'owl-panel-resume': return handleResumeCapture();
    default: return undefined;
  }
}

export function handleContextMenuClick(info, tab) {
  if (info?.menuItemId === TRANSCRIBE_ID) return handleTranscribe(info, tab);
  if (info?.menuItemId === SAVE_SELECTION_ID) return handleSaveSelection(info, tab);
  if (info?.menuItemId === CAPTURE_FULL_PAGE_ID) return handleCaptureFullPage(info, tab);
  if (info?.menuItemId === CAPTURE_SMART_PAGE_ID) return handleCaptureSmartPage(info, tab);
  return undefined;
}

// Bring the OWL-Note app tab to the front, or open one if none exists. Permission-free:
// runtime.getContexts enumerates the extension's OWN tabs (no `tabs` permission), and
// tabs.update/windows.update activate+focus without it either. Any gap — old Chrome with
// no getContexts, a query error, a since-closed tab — falls through to opening a new tab.
export async function focusOrOpenApp() {
  if (await focusExistingApp()) return;
  // Fallback also guarded: nothing may escape (the note + signal may already be saved,
  // and this can run as a fire-and-forget callback).
  try { await chrome.tabs.create({ url: 'app.html' }); } catch { /* best-effort */ }
}

// Focus an existing app tab, optionally excluding the newly opened launcher tab.
// The exclusion powers Chrome's "Create shortcut" flow: app.html starts in a fresh
// window, identifies itself through sender.tab.id, and asks us to reuse an older tab.
function appTabStore() {
  // session survives MV3 service-worker sleeps but clears with the browser, so a tab
  // id can never go stale across a browser restart. Older browsers fall back to local;
  // a failed tabs.update below validates and clears that stale entry before use.
  return chrome.storage?.session || chrome.storage?.local;
}

async function rememberAppTab(tabId, windowId) {
  if (typeof tabId !== 'number' || tabId < 0) return;
  try { await appTabStore()?.set?.({ [APP_TAB_KEY]: { tabId, windowId } }); } catch { /* best-effort */ }
}

async function forgetAppTab() {
  try { await appTabStore()?.remove?.(APP_TAB_KEY); } catch { /* best-effort */ }
}

export async function focusExistingApp(excludeTabId = null, excludeDocumentId = null) {
  // Primary path after an app page has launched once: focus its registered tab id.
  // This works on browsers older than runtime.getContexts (Chrome 116).
  try {
    const remembered = (await appTabStore()?.get?.(APP_TAB_KEY))?.[APP_TAB_KEY];
    if (typeof remembered?.tabId === 'number' && remembered.tabId >= 0 && remembered.tabId !== excludeTabId) {
      await chrome.tabs.update(remembered.tabId, { active: true });
      if (typeof remembered.windowId === 'number' && remembered.windowId >= 0) {
        try { await chrome.windows?.update?.(remembered.windowId, { focused: true }); } catch { /* best-effort */ }
      }
      return true;
    }
  } catch {
    await forgetAppTab(); // tab closed or a legacy stored id is no longer valid
  }

  try {
    const base = chrome.runtime?.getURL?.('app.html');
    if (base && chrome.runtime?.getContexts) {
      // Enumerate our OWN tabs (permission-free) and match app.html — INCLUDING
      // app.html#<note-hash>, which is what a tab opened on a note keeps for its whole
      // lifetime (the app deep-links notes via location.hash and never strips it). A
      // documentUrls:[base] filter would exact-match the full URL spec and MISS those,
      // spawning a duplicate tab. Prefix-match instead.
      const ctxs = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
      const ctx = (ctxs || []).find((c) => typeof c.tabId === 'number' && c.tabId >= 0 && c.tabId !== excludeTabId
        && (!excludeDocumentId || c.documentId !== excludeDocumentId)
        && typeof c.documentUrl === 'string'
        && (c.documentUrl === base || c.documentUrl.startsWith(`${base}#`)));
      if (ctx) {
        await chrome.tabs.update(ctx.tabId, { active: true });
        if (typeof ctx.windowId === 'number' && ctx.windowId >= 0) {
          try { await chrome.windows?.update?.(ctx.windowId, { focused: true }); } catch { /* window focus is best-effort */ }
        }
        await rememberAppTab(ctx.tabId, ctx.windowId);
        return true;
      }
    }
  } catch { /* getContexts/update unavailable or failed */ }
  return false;
}

// A plain app.html opened through Chrome's desktop shortcut reports itself here. Reply
// before removing the duplicate so its boot can stop cleanly; hash-linked note bookmarks
// deliberately do not send this message.
export function handleRuntimeMessage(message, sender, sendResponse) {
  // Messages we ADDRESSED to the offscreen document are broadcast back to us too.
  if (message?.target === 'offscreen') return undefined;
  if (message && message.type !== APP_OPENED_MESSAGE) {
    const handled = handleCaptureMessage(message);
    if (handled !== undefined) {
      // The setup page waits for this acknowledgement before closing itself.
      // Keeping the message port open also keeps the MV3 worker alive while it
      // focuses the armed source tab and updates its overlay.
      if (['owl-transcribe-setup-complete', 'owl-transcribe-setup-cancelled'].includes(message.type)) {
        Promise.resolve(handled)
          .then((result) => sendResponse?.({ ok: Boolean(result) }))
          .catch(() => sendResponse?.({ ok: false }));
        return true;
      }
      return undefined; // other capture messages are fire-and-forget
    }
  }
  if (!message || message.type !== APP_OPENED_MESSAGE) return undefined;
  // getCurrent() data supplied by app.html is a fallback for shortcut/app-window
  // contexts where Chrome omits sender.tab.
  const senderTabId = sender?.tab?.id ?? message.tabId;
  const senderWindowId = sender?.tab?.windowId ?? message.windowId;
  const checkExisting = message.dedupe === false
    ? Promise.resolve(false)
    : focusExistingApp(senderTabId, sender?.documentId);
  checkExisting.then(async (reused) => {
    if (!reused) await rememberAppTab(senderTabId, senderWindowId);
    sendResponse?.({ reused });
    if (reused && typeof senderTabId === 'number') {
      setTimeout(() => chrome.tabs?.remove?.(senderTabId)?.catch?.(() => {}), 0);
    }
  }).catch(() => sendResponse?.({ reused: false }));
  return true;
}

// Brief ✓ on the toolbar icon as save confirmation (best-effort; no extra permission).
async function flashSaved() {
  try {
    await chrome.action?.setBadgeText?.({ text: '✓' });
    await chrome.action?.setBadgeBackgroundColor?.({ color: '#2e7d32' });
    await chrome.action?.setTitle?.({ title: 'Open OWL-Note' });
    setTimeout(() => chrome.action?.setBadgeText?.({ text: '' }), 2000);
  } catch { /* badge is cosmetic */ }
}

export async function handleBookmarkChanged(id, changeInfo) {
  const url = changeInfo && changeInfo.url;
  if (!isNoteUrl(url)) return;
  try {
    const note = await decode(payloadFromUrl(url));
    await saveBackup(note);
  } catch {
    /* malformed payload — ignore, the live bookmark is unchanged */
  }
}

export function wireEvents() {
  /* eslint-disable no-undef */
  const c = typeof chrome !== 'undefined' ? chrome : undefined;
  c?.runtime?.onInstalled?.addListener(handleInstalled);
  c?.runtime?.onMessage?.addListener(handleRuntimeMessage);
  c?.action?.onClicked?.addListener(handleActionClick);
  c?.contextMenus?.onClicked?.addListener(handleContextMenuClick);
  c?.bookmarks?.onChanged?.addListener(handleBookmarkChanged);
  c?.bookmarks?.onCreated?.addListener((id, node) => handleBookmarkChanged(id, { url: node.url }));
  c?.tabs?.onUpdated?.addListener(handleTranscribeTabUpdated);
  c?.tabs?.onRemoved?.addListener((tabId) => handleTabClosed(tabId));
  // The worker wakes on every message, so this is checked often enough to catch a
  // session whose tab was left playing silence.
  finalizeIfSilent().catch(() => {});
}

// Register on load (no-op in environments where chrome is not yet defined).
wireEvents();
