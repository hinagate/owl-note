// src/background/service-worker.js
import { ensureRoot, isNoteUrl, payloadFromUrl } from '../lib/bookmarks.js';
import { decode } from '../lib/codec.js';
import { saveBackup } from '../lib/mirror.js';
import { createNote } from '../lib/note.js';
import { saveNote } from '../lib/save-note.js';
import { buildQuickNote } from '../lib/quick-note.js';

const SAVE_SELECTION_ID = 'owl-save-selection';
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
  await chrome.tabs.create({ url: 'app.html' });
}

// Save the right-clicked selection as a note (selection + a markdown source link), then
// bring OWL-Note to the front so the capture is immediately visible on top of All notes.
export async function handleSaveSelection(info, tab) {
  if (info.menuItemId !== SAVE_SELECTION_ID) return;
  const selection = (info.selectionText || '').trim();
  if (!selection) return;
  const url = info.pageUrl || (tab && tab.url) || '';
  const title = (tab && tab.title) || ''; // best-effort; no `tabs` permission required
  const { title: noteTitle, body } = buildQuickNote({ title, url, selection });
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
  try {
    const base = chrome.runtime?.getURL?.('app.html');
    if (base && chrome.runtime?.getContexts) {
      // Enumerate our OWN tabs (permission-free) and match app.html — INCLUDING
      // app.html#<note-hash>, which is what a tab opened on a note keeps for its whole
      // lifetime (the app deep-links notes via location.hash and never strips it). A
      // documentUrls:[base] filter would exact-match the full URL spec and MISS those,
      // spawning a duplicate tab. Prefix-match instead.
      const ctxs = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
      const ctx = (ctxs || []).find((c) => typeof c.tabId === 'number' && c.tabId >= 0
        && typeof c.documentUrl === 'string'
        && (c.documentUrl === base || c.documentUrl.startsWith(`${base}#`)));
      if (ctx) {
        await chrome.tabs.update(ctx.tabId, { active: true });
        if (typeof ctx.windowId === 'number' && ctx.windowId >= 0) {
          try { await chrome.windows?.update?.(ctx.windowId, { focused: true }); } catch { /* window focus is best-effort */ }
        }
        return;
      }
    }
  } catch { /* getContexts/update unavailable or failed — open a fresh tab instead */ }
  // Fallback also guarded: nothing may escape (the note + signal are already saved, and
  // this runs as a fire-and-forget context-menu callback — an unhandled rejection helps
  // no one and skips flashSaved).
  try { await chrome.tabs.create({ url: 'app.html' }); } catch { /* best-effort */ }
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
  c?.action?.onClicked?.addListener(handleActionClick);
  c?.contextMenus?.onClicked?.addListener(handleSaveSelection);
  c?.bookmarks?.onChanged?.addListener(handleBookmarkChanged);
  c?.bookmarks?.onCreated?.addListener((id, node) => handleBookmarkChanged(id, { url: node.url }));
}

// Register on load (no-op in environments where chrome is not yet defined).
wireEvents();
