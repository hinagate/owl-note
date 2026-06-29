// src/background/service-worker.js
import { ensureRoot, isNoteUrl, payloadFromUrl } from '../lib/bookmarks.js';
import { decode } from '../lib/codec.js';
import { saveBackup } from '../lib/mirror.js';
import { createNote } from '../lib/note.js';
import { saveNote } from '../lib/save-note.js';
import { buildQuickNote } from '../lib/quick-note.js';

const SAVE_SELECTION_ID = 'owl-save-selection';

export async function handleInstalled() {
  await ensureRoot();
  // Right-click "Save selection to OWL-Note" — shown only when text is selected.
  chrome.contextMenus?.create({ id: SAVE_SELECTION_ID, title: 'Save selection to OWL-Note', contexts: ['selection'] });
}

export async function handleActionClick() {
  await chrome.tabs.create({ url: 'app.html' });
}

// Save the right-clicked selection as a note (selection + a markdown source link).
export async function handleSaveSelection(info, tab) {
  if (info.menuItemId !== SAVE_SELECTION_ID) return;
  const selection = (info.selectionText || '').trim();
  if (!selection) return;
  const url = info.pageUrl || (tab && tab.url) || '';
  const title = (tab && tab.title) || ''; // best-effort; no `tabs` permission required
  const { title: noteTitle, body } = buildQuickNote({ title, url, selection });
  const root = await ensureRoot();
  await saveNote(createNote({ title: noteTitle, body }), root, undefined);
  await flashSaved();
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
