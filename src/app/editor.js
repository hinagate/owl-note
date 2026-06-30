// src/app/editor.js
import { renderMarkdown } from '../lib/markdown.js';
import { imageFileToDataUri } from '../lib/image-downscale.js';
import { extractImages, inlineImages, inlineImagesAsync, pruneAttachments, attachFile, listFileRefs } from '../lib/note-images.js';
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
  fileBtn.textContent = '📎 File';
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
  bar.append(viewBtn, save, status, codeBtn, imgBtn, imgInput, fileBtn, fileInput, listBtn, readingHint);

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
  editPane.append(titleInput, ta);
  const attachBar = document.createElement('div');
  attachBar.className = 'attachments-bar';
  editPane.append(attachBar); // chips list under the body
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

  function renderChips() {
    attachBar.innerHTML = '';
    const ids = new Set(listFileRefs(ta.value).map((r) => r.id));
    for (const a of atts) {
      if (!ids.has(a.id)) continue; // only files still referenced in the body
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'attach-chip';
      chip.textContent = `📎 ${a.name}`;
      chip.addEventListener('click', async () => {
        const win = window.open();                 // sync: keep the user gesture
        const uri = await getBytes(a);
        if (!uri) { if (win) win.close(); chip.classList.add('unavailable'); return; }
        const blob = await (await fetch(uri)).blob();
        if (win) win.location = URL.createObjectURL(blob);
      });
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
        bodyEl.innerHTML = renderMarkdown(resolved);
        decorateCodeBlocks(content);
      }
    } finally { resolving = false; }
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
    bodyEl.innerHTML = renderMarkdown(inlineImages(ta.value, atts)); // refs -> local data URIs, then sanitized
    content.appendChild(bodyEl);
    decorateCodeBlocks(content);
    renderChips();
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
      setStatus("Couldn't save — will retry");
    } finally {
      saving = false;
      if (resaveQueued) { resaveQueued = false; scheduleAutoSave(); }
    }
  }

  refresh();
  ta.addEventListener('input', fireChange);
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
    const after = ta.value.slice(end);
    const open = (before && !before.endsWith('\n') ? '\n' : '') + '```js\n';
    const close = '\n```\n';
    ta.value = before + open + selected + close + after;
    const caret = before.length + open.length + selected.length;
    ta.selectionStart = ta.selectionEnd = caret;
    ta.focus();
    fireChange();
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
      ta.value = before + snippet + ta.value.slice(end);
      const caret = before.length + snippet.length;
      ta.selectionStart = ta.selectionEnd = caret;
      ta.focus();
      fireChange();
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
    ta.value = before + snippet + ta.value.slice(ta.selectionEnd ?? start);
    ta.selectionStart = ta.selectionEnd = before.length + snippet.length;
    ta.focus();
    fireChange();
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

  return { getBody: () => ta.value, getTitle: () => titleInput.value, getAttachments: () => atts, flush: () => doSave({ auto: true }) };
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
