// src/app/editor.js
import { renderMarkdown } from '../lib/markdown.js';
import { imageFileToDataUri } from '../lib/image-downscale.js';
import { extractImages, inlineImages, inlineImagesAsync, pruneAttachments, attachFile, listFileRefs, linkifyFileRefs } from '../lib/note-images.js';
import { getBytes } from '../lib/attachment-store.js';
import * as panes from './panes.js';

export function renderEditor(
  container,
  { title = '', body = '', attachments = [], onChange = () => {}, onSave = () => {}, onDelete = null, focusTitle = false, measure = null, breadcrumb = [], onNavigate = () => {} },
) {
  container.innerHTML = '';
  // Images live in `atts` (as data: URIs); the body only carries short owl-img refs.
  let atts = (attachments || []).slice();

  const bar = document.createElement('div');
  bar.className = 'editor-bar';

  const save = document.createElement('button');
  save.className = 'save primary';
  save.textContent = 'Save';

  const status = document.createElement('span'); // subtle auto-save status: Unsaved… / Saving… / Saved ✓
  status.className = 'save-status';

  const codeBtn = document.createElement('button');
  codeBtn.className = 'code-block';
  codeBtn.textContent = '</> Code';

  const imgBtn = document.createElement('button');
  imgBtn.className = 'insert-image';
  imgBtn.textContent = '🖼 Image';
  const imgInput = document.createElement('input');
  imgInput.type = 'file';
  imgInput.accept = 'image/*';
  imgInput.style.display = 'none';

  const fileBtn = document.createElement('button');
  fileBtn.className = 'attach-file';
  const fileBtnIco = document.createElement('span');
  fileBtnIco.className = 'owl-file-ico';
  fileBtn.append(fileBtnIco, document.createTextNode('File'));
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.style.display = 'none';

  const listBtn = document.createElement('button');
  listBtn.className = 'toggle-list';
  const setListLabel = () => { listBtn.textContent = panes.isNoteListHidden() ? '⬓ Show list' : '⬓ Hide list'; };
  setListLabel();
  listBtn.addEventListener('click', () => { panes.toggleNoteList(); setListLabel(); });

  const viewBtn = document.createElement('button');
  viewBtn.className = 'toggle-edit';
  const setViewLabel = () => {
    viewBtn.textContent = panes.isEditCollapsed() ? '«' : '»';
    viewBtn.title = panes.isEditCollapsed() ? 'Show editor' : 'Preview only — hide editor';
  };
  setViewLabel();
  viewBtn.addEventListener('click', () => { panes.toggleEditPane(); setViewLabel(); syncPreviewLock(); refresh(); });

  // "Reading mode" hint — sits to the RIGHT of the Hide-list button, shown only in preview-only.
  const readingHint = document.createElement('span');
  readingHint.className = 'reading-hint';
  readingHint.textContent = '📖 Reading mode';

  // viewBtn (« / ») sits to the LEFT of Save — a quick "preview only" reading toggle.
  bar.append(viewBtn, save, codeBtn, imgBtn, imgInput, fileBtn, fileInput, listBtn, readingHint);

  if (onDelete) {
    const del = document.createElement('button');
    del.className = 'delete danger';
    del.textContent = '🗑 Delete';
    del.addEventListener('click', () => onDelete());
    bar.appendChild(del);
  }

  const titleInput = document.createElement('textarea');
  titleInput.className = 'note-title';
  titleInput.rows = 1;
  titleInput.placeholder = 'Title';
  titleInput.value = title;
  // A title is one logical line that just wraps — block Enter, and grow to fit.
  titleInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
  const growTitle = () => { titleInput.style.height = 'auto'; titleInput.style.height = `${titleInput.scrollHeight}px`; };

  const split = document.createElement('div');
  split.className = 'editor-split';
  const editPane = document.createElement('div'); // left column: [title] stacked above [body]
  editPane.className = 'edit-pane';
  const ta = document.createElement('textarea');
  ta.className = 'note-body';
  ta.value = body;
  // A highlight backdrop sits behind the (transparent) textarea and draws a grey box
  // behind each attachment reference, so they're easy to spot in the raw markdown.
  const backdrop = document.createElement('div');
  backdrop.className = 'note-body-highlights';
  backdrop.setAttribute('aria-hidden', 'true');
  const bodyWrap = document.createElement('div');
  bodyWrap.className = 'note-body-wrap';
  bodyWrap.append(backdrop, ta);
  editPane.append(titleInput, bodyWrap);
  const attachBar = document.createElement('div');
  attachBar.className = 'attachments-bar';
  editPane.append(attachBar, status); // chips under the body; status sits below the chips
  const preview = document.createElement('div');
  preview.className = 'preview';

  split.append(editPane, preview);
  split.classList.toggle('edit-collapsed', panes.isEditCollapsed());

  // Preview-only is a reading mode: the edit pane (incl. the title field) is hidden by CSS
  // and the title shows via the preview heading — here we only toggle the reading hint.
  // (Hoisted so the viewBtn click handler above can call it; run once now for initial state.)
  function syncPreviewLock() {
    readingHint.hidden = !panes.isEditCollapsed();
  }
  syncPreviewLock();

  // Live size meter — a note is stored inside a bookmark URL, so it must stay
  // under the sync byte cap. Shown only when the caller supplies a `measure` fn.
  // It lives outside the refresh-managed content so a re-render never wipes it.
  let sizeBadge = null;
  if (measure) {
    sizeBadge = document.createElement('div');
    sizeBadge.className = 'preview-size';
    sizeBadge.title = "This note's compressed size inside its bookmark URL. Over the cap it won't sync across devices.";
    preview.appendChild(sizeBadge);
  }
  const content = document.createElement('div');
  content.className = 'preview-content';
  preview.appendChild(content);

  // Clickable notebook path for the open note (📓 Notes › Work › Research). Empty
  // when no note is open — CSS hides the row via :empty.
  const crumbs = document.createElement('nav');
  crumbs.className = 'editor-breadcrumb';
  breadcrumb.forEach((c, i) => {
    if (i) { const sep = document.createElement('span'); sep.className = 'sep'; sep.textContent = '›'; crumbs.appendChild(sep); }
    const cb = document.createElement('button');
    cb.type = 'button';
    cb.className = 'crumb';
    cb.textContent = c.title;
    cb.addEventListener('click', () => onNavigate(c.id));
    crumbs.appendChild(cb);
  });

  container.append(crumbs, bar, split);
  growTitle(); // size the title to its content now that it's in the DOM

  let sizeSeq = 0; // guards against an older keystroke's measurement landing last
  const updateSize = () => {
    if (!measure || !sizeBadge) return;
    const seq = ++sizeSeq;
    // Measure what would actually be saved — prune attachments whose owl-img ref is no
    // longer in the body, so the meter drops when an image is removed (matches onSave).
    Promise.resolve(measure({ title: titleInput.value, body: ta.value, attachments: pruneAttachments(ta.value, atts) }))
      .then(({ bytes, warn, max }) => {
        if (seq !== sizeSeq) return;
        sizeBadge.textContent = `${(bytes / 1024).toFixed(1)} / ${Math.round(max / 1024)} KB`;
        sizeBadge.classList.toggle('over', bytes > max);
        sizeBadge.classList.toggle('warn', bytes > warn && bytes <= max);
      })
      .catch(() => { /* sizing is best-effort; never block editing */ });
  };

  const attById = (id) => atts.find((a) => a.id === id);

  // Insert text over [start,end] while PRESERVING the textarea's native undo stack — assigning
  // ta.value directly wipes Ctrl+Z. Uses execCommand('insertText') where available (all
  // Chromium browsers); falls back to a manual splice (loses undo) e.g. under jsdom.
  function insertText(text, start, end) {
    ta.focus();
    ta.setSelectionRange(start, end);
    let ok = false;
    try { ok = !!(document.execCommand && document.execCommand('insertText', false, text)); } catch { ok = false; }
    if (!ok) {
      ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
      ta.selectionStart = ta.selectionEnd = start + text.length;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  // Open an attachment's bytes in a new tab. window.open() runs synchronously to keep
  // the click's user gesture (popup blocker), and we navigate via a blob: URL because
  // Chrome blocks top-level navigation to data: URIs.
  async function openAttachment(att, markUnavailable) {
    const win = window.open();
    const uri = att && (await getBytes(att));
    if (!uri) { if (win) win.close(); if (markUnavailable) markUnavailable(); return; }
    const blob = await (await fetch(uri)).blob();
    if (win) win.location = URL.createObjectURL(blob);
  }

  // Wire the clickable file links rendered into the preview by linkifyFileRefs
  // (`<a data-owl-file="id">`): the owl-file: scheme can't be a real href, so open via JS.
  function wireFileLinks(root) {
    for (const el of root.querySelectorAll('a[data-owl-file]')) {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        openAttachment(attById(el.dataset.owlFile), () => el.classList.add('unavailable'));
      });
    }
  }

  // One chip per file REFERENCE in the body (not per unique attachment), so two refs —
  // even to the same underlying file — show two chips, matching the two preview links.
  function renderChips() {
    attachBar.innerHTML = '';
    for (const { id, name } of listFileRefs(ta.value)) {
      const att = attById(id);
      if (!att) continue; // referenced file has no attachment bytes
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'attach-chip';
      const ico = document.createElement('span');
      ico.className = 'owl-file-ico';
      chip.append(ico, document.createTextNode(name));
      chip.addEventListener('click', () => openAttachment(att, () => chip.classList.add('unavailable')));
      attachBar.appendChild(chip);
    }
  }

  // Drive-backed images have no inline dataUri on this device — fetch + cache them,
  // then re-render so they appear. Sync inlineImages (in refresh) shows what's local first.
  let resolving = false;
  async function resolveDriveImages() {
    if (resolving) return;
    if (!atts.some((a) => a.driveFileId && !a.dataUri)) return; // all local already
    resolving = true;
    try {
      const resolved = await inlineImagesAsync(ta.value, atts, getBytes);
      const bodyEl = content.querySelector('.preview-body');
      if (bodyEl) {
        bodyEl.innerHTML = renderMarkdown(linkifyFileRefs(resolved));
        decorateCodeBlocks(content);
        wireFileLinks(content);
      }
    } finally { resolving = false; }
  }

  // Draw a grey box behind each owl-img / owl-file reference so attachments stand out in
  // the raw markdown. The backdrop mirrors the textarea text and aligns 1:1 (monospace).
  const HL_RE = /!\[[^\]]*\]\(owl-img:[A-Za-z0-9]+\)|\[[^\]]*\]\(owl-file:[A-Za-z0-9]+\)/g;
  const escHtml = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  function renderHighlights() {
    const text = ta.value;
    let html = '';
    let last = 0;
    for (const m of text.matchAll(HL_RE)) {
      html += escHtml(text.slice(last, m.index)) + '<mark>' + escHtml(m[0]) + '</mark>';
      last = m.index + m[0].length;
    }
    backdrop.innerHTML = html + escHtml(text.slice(last)) + '\n'; // trailing \n keeps the last line aligned
    backdrop.scrollTop = ta.scrollTop;
    backdrop.scrollLeft = ta.scrollLeft;
  }

  const refresh = () => {
    content.innerHTML = '';
    const t = titleInput.value.trim();
    if (t) { // always show the rendered title heading in the preview
      const h = document.createElement('h1');
      h.className = 'preview-title';
      h.textContent = t; // textContent, never innerHTML — title is not sanitized markdown
      content.appendChild(h);
    }
    const bodyEl = document.createElement('div');
    bodyEl.className = 'preview-body';
    bodyEl.innerHTML = renderMarkdown(linkifyFileRefs(inlineImages(ta.value, atts))); // img refs -> data URIs, file refs -> links, then sanitized
    content.appendChild(bodyEl);
    decorateCodeBlocks(content);
    wireFileLinks(content);
    renderChips();
    renderHighlights();
    resolveDriveImages().catch(() => {});
    updateSize();
  };

  const fireChange = () => {
    refresh();
    onChange({ title: titleInput.value, body: ta.value, attachments: atts });
    scheduleAutoSave();
  };

  // --- Auto-save: persist ~2.5s after the user stops editing, and flush on blur /
  // tab-hide. Subtle status only (no toast spam); empty new notes are never auto-created. ---
  const SAVE_DELAY = 2500;
  let saveTimer = null;
  let saving = false;
  let resaveQueued = false;
  const setStatus = (s) => { status.textContent = s; };
  function scheduleAutoSave() {
    setStatus('Unsaved…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => doSave({ auto: true }), SAVE_DELAY);
  }
  async function doSave({ auto }) {
    clearTimeout(saveTimer);
    const title = titleInput.value;
    const body = ta.value;
    if (auto && !title.trim() && !body.trim()) { setStatus(''); return; } // never auto-create an empty note
    if (saving) { resaveQueued = true; return; } // a save is already in flight — coalesce edits made during it
    saving = true;
    setStatus('Saving…');
    try {
      await onSave({ title, body, attachments: pruneAttachments(ta.value, atts) }, { auto });
      setStatus('Saved ✓');
    } catch {
      setStatus('Save failed');
    } finally {
      saving = false;
      if (resaveQueued) { resaveQueued = false; scheduleAutoSave(); }
    }
  }

  refresh();
  ta.addEventListener('input', fireChange);
  ta.addEventListener('scroll', () => { backdrop.scrollTop = ta.scrollTop; backdrop.scrollLeft = ta.scrollLeft; });
  titleInput.addEventListener('input', () => {
    if (titleInput.value.includes('\n')) {
      const caret = titleInput.selectionStart;
      titleInput.value = titleInput.value.replace(/\n/g, ' '); // newlines (e.g. paste) -> one logical line
      titleInput.selectionStart = titleInput.selectionEnd = caret;
    }
    growTitle();
    fireChange();
  });
  ta.addEventListener('blur', () => doSave({ auto: true }));
  titleInput.addEventListener('blur', () => doSave({ auto: true }));
  save.addEventListener('click', () => doSave({ auto: false }));

  codeBtn.addEventListener('click', () => {
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? start;
    const before = ta.value.slice(0, start);
    const selected = ta.value.slice(start, end);
    const open = (before && !before.endsWith('\n') ? '\n' : '') + '```js\n';
    const close = '\n```\n';
    insertText(open + selected + close, start, end); // replaces the selection, keeps undo alive
    ta.selectionStart = ta.selectionEnd = before.length + open.length + selected.length;
  });

  // Shared image insertion pipeline used by the 🖼 button and paste handler.
  async function insertImageFile(file) {
    const label = imgBtn.textContent;
    imgBtn.disabled = true;
    imgBtn.textContent = 'Adding…';
    try {
      const uri = await imageFileToDataUri(file);
      // Store the image in attachments and insert a short owl-img ref (no base64 in the body).
      const { body: ref, attachments: merged } = extractImages(`![${file.name || 'pasted-image.png'}](${uri})`, atts);
      atts = merged;
      const start = ta.selectionStart ?? ta.value.length;
      const end = ta.selectionEnd ?? start;
      const before = ta.value.slice(0, start);
      const snippet = (before && !before.endsWith('\n') ? '\n' : '') + ref + '\n';
      insertText(snippet, start, end); // keeps undo alive
    } finally {
      imgBtn.disabled = false;
      imgBtn.textContent = label;
    }
  }

  // Insert a picked photo as a (auto-downscaled) base64 image at the cursor.
  imgBtn.addEventListener('click', () => imgInput.click());
  imgInput.addEventListener('change', async () => {
    const file = imgInput.files && imgInput.files[0];
    imgInput.value = ''; // allow re-picking the same file
    if (file) await insertImageFile(file);
  });

  fileBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    let bin = ''; for (let k = 0; k < bytes.length; k++) bin += String.fromCharCode(bytes[k]);
    const dataUri = `data:${file.type || 'application/octet-stream'};base64,${btoa(bin)}`;
    const { ref, attachments: merged } = attachFile({ name: file.name || 'file', mime: file.type, dataUri }, atts);
    atts = merged;
    const start = ta.selectionStart ?? ta.value.length;
    const before = ta.value.slice(0, start);
    const snippet = (before && !before.endsWith('\n') ? '\n' : '') + ref + '\n';
    insertText(snippet, start, ta.selectionEnd ?? start); // keeps undo alive
  });

  // Paste a copied image straight into the editor (same pipeline as the 🖼 button).
  ta.addEventListener('paste', async (e) => {
    const imgs = [...(e.clipboardData?.items || [])].filter((it) => it.kind === 'file' && it.type.startsWith('image/'));
    if (!imgs.length) return; // plain text/other — let the default paste run
    e.preventDefault();
    for (const it of imgs) { const f = it.getAsFile(); if (f) await insertImageFile(f); }
  });

  if (focusTitle) {
    titleInput.focus();
    titleInput.select();
  }

  return {
    getBody: () => ta.value,
    getTitle: () => titleInput.value,
    getAttachments: () => atts,
    flush: () => doSave({ auto: true }),
    destroy: () => clearTimeout(saveTimer), // cancel a pending auto-save when this editor is torn down
  };
}

// Add a hover "Copy" button to every rendered code block.
function decorateCodeBlocks(root) {
  for (const pre of root.querySelectorAll('pre')) {
    if (pre.querySelector('.copy-code')) continue;
    const code = pre.querySelector('code');
    if (!code) continue;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copy-code';
    btn.textContent = 'Copy';
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(code.textContent);
        btn.textContent = 'Copied';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
      } catch {
        btn.textContent = 'Copy failed';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
      }
    });
    pre.appendChild(btn);
  }
}
