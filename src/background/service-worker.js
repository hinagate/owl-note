// src/background/service-worker.js
import { ensureRoot, isNoteUrl, payloadFromUrl } from '../lib/bookmarks.js';
import { decode } from '../lib/codec.js';
import { captureFullPage } from '../lib/full-page-capture.js';
import { captureSmartPage } from '../lib/smart-page-capture.js';
import { saveBackup } from '../lib/mirror.js';
import { contentHash, createNote } from '../lib/note.js';
import { saveNote } from '../lib/save-note.js';
import { buildQuickNote } from '../lib/quick-note.js';
import { captureSelectionMarkdown } from '../lib/selection-capture.js';

const SAVE_SELECTION_ID = 'owl-save-selection';
const CAPTURE_FULL_PAGE_ID = 'owl-capture-full-page';
const CAPTURE_SMART_PAGE_ID = 'owl-capture-smart-page';
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
}

export async function handleActionClick() {
  await focusOrOpenApp();
}

// Capture the selected DOM while the context-menu click grants activeTab access.
// Restricted pages and browser-internal URLs reject injection; callers then use
// contextMenus.selectionText as a quoted plain-text fallback.
export async function captureRichSelection(info, tab) {
  if (!Number.isInteger(tab?.id) || !chrome.scripting?.executeScript) return null;
  const target = Number.isInteger(info?.frameId)
    ? { tabId: tab.id, frameIds: [info.frameId] }
    : { tabId: tab.id };
  try {
    const results = await chrome.scripting.executeScript({ target, func: captureSelectionMarkdown });
    const captured = results?.[0]?.result;
    return captured && typeof captured === 'object' ? captured : null;
  } catch {
    return null;
  }
}

// Save the right-clicked selection as a formatted note with a source URL, then
// bring OWL-Note to the front so the capture is immediately visible on top of All notes.
export async function handleSaveSelection(info, tab) {
  if (info.menuItemId !== SAVE_SELECTION_ID) return;
  const selection = (info.selectionText || '').trim();
  if (!selection) return;
  const url = info.pageUrl || (tab && tab.url) || '';
  const title = (tab && tab.title) || ''; // best-effort; no `tabs` permission required
  const rich = await captureRichSelection(info, tab);
  const { title: noteTitle, body } = buildQuickNote({
    title: rich?.title || title,
    url,
    selection,
    selectionMarkdown: rich?.markdown || '',
  });
  const note = createNote({ title: noteTitle, body });
  const root = await ensureRoot();
  await saveNote(note, root, undefined);
  // Signal the (possibly already-open) app tab to reveal it, THEN focus/open the tab.
  // Written first so an open tab reacts as it comes forward; best-effort, never fatal.
  await signalQuickCapture(note);
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

export function handleContextMenuClick(info, tab) {
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
}

// Register on load (no-op in environments where chrome is not yet defined).
wireEvents();
