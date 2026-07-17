// src/background/service-worker.js
import { ensureRoot, isNoteUrl, payloadFromUrl } from '../lib/bookmarks.js';
import { decode } from '../lib/codec.js';
import { saveBackup } from '../lib/mirror.js';
import { createNote } from '../lib/note.js';
import { saveNote } from '../lib/save-note.js';
import { buildQuickNote } from '../lib/quick-note.js';
import { captureSelectionMarkdown } from '../lib/selection-capture.js';

const SAVE_SELECTION_ID = 'owl-save-selection';
const APP_OPENED_MESSAGE = 'owl-app-opened';
const APP_TAB_KEY = 'owl:appTab';
// A one-shot signal the app tab watches (chrome.storage.onChanged): after a capture it
// jumps to All notes (root) so the new note shows on top. Carries {id, at} — a fresh
// timestamp each time so back-to-back captures always register as a change.
const QUICK_CAPTURE_KEY = 'owl:quickCapture';

export async function handleInstalled() {
  await ensureRoot();
  // Right-click "Save selection to OWL-Note" — shown only when text is selected.
  chrome.contextMenus?.create({ id: SAVE_SELECTION_ID, title: 'Save selection to OWL-Note', contexts: ['selection'] });
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
  try { await chrome.storage?.local?.set?.({ [QUICK_CAPTURE_KEY]: { id: note.id, at: Date.now() } }); } catch { /* signal is best-effort */ }
  await focusOrOpenApp();
  await flashSaved();
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
  c?.contextMenus?.onClicked?.addListener(handleSaveSelection);
  c?.bookmarks?.onChanged?.addListener(handleBookmarkChanged);
  c?.bookmarks?.onCreated?.addListener((id, node) => handleBookmarkChanged(id, { url: node.url }));
}

// Register on load (no-op in environments where chrome is not yet defined).
wireEvents();
