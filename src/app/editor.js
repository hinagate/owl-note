// src/app/editor.js
import { renderMarkdown } from '../lib/markdown.js';
import { imageFileToDataUri } from '../lib/image-downscale.js';
import { extractImages, inlineImages, pruneAttachments, attachFile, listFileRefs, linkifyFileRefs } from '../lib/note-images.js';
import { getBytes } from '../lib/attachment-store.js';
import * as panes from './panes.js';
import { renderFormatBar, formatActions } from './format-bar.js';
import { nextTableRow } from '../lib/format.js';
import { tableCellTarget, tableCellLineBreak, isTableCellSelection, alignTableAt } from '../lib/table.js';
import { showDrawPanel } from './draw-panel.js';
import { annotateRuby } from '../lib/ruby-annotate.js';
import { createZoomBar } from './preview-zoom.js';

export function renderEditor(
  container,
  { title = '', body = '', attachments = [], created = null, updated = null, onChange = () => {}, onSave = () => {}, onDelete = null, focusTitle = false, measure = null, breadcrumb = [], onNavigate = () => {}, onSuggestTitle = null, shareActions = [], recoverAttachments = null, loadImageBytes = getBytes, phonetics = null, previewZoom = null },
) {
  container.innerHTML = '';
  // Images live in `atts` (as data: URIs); the body only carries short owl-img refs.
  let atts = (attachments || []).slice();
  let destroyed = false;

  const bar = document.createElement('div');
  bar.className = 'editor-bar';

  const save = document.createElement('button');
  save.className = 'save primary';
  save.textContent = 'Save';

  const shareWrap = document.createElement('div');
  shareWrap.className = 'menu-wrap share-wrap';
  const shareBtn = document.createElement('button');
  shareBtn.type = 'button';
  shareBtn.className = 'share-button';
  shareBtn.textContent = 'Share ▾';
  shareBtn.setAttribute('aria-haspopup', 'menu');
  shareBtn.setAttribute('aria-expanded', 'false');
  const shareMenu = document.createElement('div');
  shareMenu.className = 'menu share-menu';
  shareMenu.setAttribute('role', 'menu');
  shareMenu.hidden = true;
  const shareItems = new Map();
  const shareSnapshot = () => ({
    title: titleInput.value,
    body: ta.value,
    attachments: pruneAttachments(ta.value, atts),
  });
  for (const action of shareActions) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'menu-item';
    item.textContent = action.label;
    item.hidden = !!action.hidden;
    item.disabled = !!action.disabled;
    item.setAttribute('role', 'menuitem');
    item.addEventListener('click', async () => {
      shareMenu.hidden = true;
      shareBtn.setAttribute('aria-expanded', 'false');
      shareBtn.disabled = true;
      try { await action.run(shareSnapshot()); }
      finally { shareBtn.disabled = false; }
    });
    shareItems.set(action.id, item);
    shareMenu.appendChild(item);
  }
  shareBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    shareMenu.hidden = !shareMenu.hidden;
    shareBtn.setAttribute('aria-expanded', String(!shareMenu.hidden));
  });
  const closeShareMenu = (event) => {
    if (shareWrap.contains(event.target)) return;
    shareMenu.hidden = true;
    shareBtn.setAttribute('aria-expanded', 'false');
  };
  document.addEventListener('click', closeShareMenu);
  shareWrap.append(shareBtn, shareMenu);

  const statusRow = document.createElement('div');
  statusRow.className = 'editor-status-row';
  const updatedLabel = document.createElement('span');
  updatedLabel.className = 'note-updated-time';
  const updatedTime = document.createElement('time');
  updatedLabel.append('Updated ', updatedTime);
  const status = document.createElement('span'); // subtle auto-save status: Unsaved… / Saving… / Saved ✓
  status.className = 'save-status';
  statusRow.append(updatedLabel, status);

  let createdValue = created;
  let updatedValue = updated;
  const asValidDate = (value) => {
    if (value == null) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  };
  const formatCompactDate = (date) =>
    new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
  const formatFullDate = (date) => date ? date.toLocaleString() : 'Not recorded';
  const setTimestamps = ({ created: nextCreated = createdValue, updated: nextUpdated = updatedValue } = {}) => {
    createdValue = nextCreated;
    updatedValue = nextUpdated;
    const createdDate = asValidDate(createdValue);
    const editedDate = asValidDate(updatedValue);
    const visibleDate = editedDate || createdDate; // legacy notes use their best known time
    updatedLabel.hidden = !visibleDate;
    if (visibleDate) {
      updatedTime.dateTime = visibleDate.toISOString();
      updatedTime.textContent = formatCompactDate(visibleDate);
      updatedLabel.title = [
        `Created: ${formatFullDate(createdDate)}`,
        `Updated: ${editedDate ? formatFullDate(editedDate) : 'Not recorded (showing created time)'}`,
      ].join('\n');
    } else {
      updatedTime.removeAttribute('datetime');
      updatedTime.textContent = '';
      updatedLabel.removeAttribute('title');
    }
    statusRow.hidden = !visibleDate && !status.textContent;
  };
  setTimestamps();

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

  // Sketchpad. The panel hands back a PNG File, which goes through the very same
  // pipeline as a picked photo — so a drawing is just an image attachment, and
  // Drive sync, export, and pruning need to know nothing about drawings.
  // (insertImageFile is a hoisted function declaration, defined further down.)
  const drawBtn = document.createElement('button');
  drawBtn.className = 'insert-drawing';
  drawBtn.textContent = '✏️ Draw';
  drawBtn.title = 'Draw a sketch and insert it as an image';
  drawBtn.addEventListener('click', () => showDrawPanel({ onSave: (file) => insertImageFile(file) }));

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
  // Phonetic readings (M10) — a reading aid for the PREVIEW, so it sits beside the
  // other preview control rather than among the text-editing buttons. Absent unless
  // the host wires it, which keeps every existing renderEditor caller untouched.
  const phoneticsBtn = document.createElement('button');
  if (phonetics) {
    phoneticsBtn.className = `phonetics-toggle${phonetics.enabled ? ' on' : ''}`;
    phoneticsBtn.textContent = 'ˈɑ';
    phoneticsBtn.disabled = !!phonetics.busy;
    // Names the three languages AND says "only": the button gives no feedback on a note
    // written in anything else, so the tooltip is the one place a reader can find out that
    // silence is the feature working as intended rather than failing.
    phoneticsBtn.title = phonetics.busy
      ? 'Loading the pronunciation dictionary…'
      : `${phonetics.enabled ? 'Hide' : 'Show'} readings in the preview — English (IPA), Japanese (hiragana) and Chinese (pinyin) only`;
    phoneticsBtn.addEventListener('click', () => {
      Promise.resolve(phonetics.onToggle?.()).catch((err) => console.warn('phonetics toggle failed', err));
    });
  }

  bar.append(viewBtn, save, shareWrap, codeBtn, imgBtn, imgInput, drawBtn, fileBtn, fileInput, listBtn, readingHint);
  if (phonetics) bar.insertBefore(phoneticsBtn, readingHint);

  if (onDelete) {
    const del = document.createElement('button');
    del.className = 'delete danger';
    del.textContent = '🗑 Delete';
    // onDelete is async and a click handler cannot await it, so guard the floating
    // promise the way sidebar.js does for notebook deletion: a bookmark read that
    // fails mid-delete should log, not surface as an unhandled rejection.
    del.addEventListener('click', () => {
      Promise.resolve(onDelete()).catch((err) => console.warn('delete note failed', err));
    });
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

  // The title row holds the title field and, when the host wires it, the ✨
  // "Suggest a title" button — the first AI surface outside the Ask panel. The
  // model only PROPOSES: the button fills the title FIELD (via the same events a
  // manual edit fires), so autosave/onChange treat it exactly like the user typed
  // it. No callback -> no button (same optional-handler pattern as onDelete).
  const titleRow = document.createElement('div');
  titleRow.className = 'title-row';
  titleRow.appendChild(titleInput);
  if (onSuggestTitle) {
    const suggestBtn = document.createElement('button');
    suggestBtn.type = 'button';
    suggestBtn.className = 'suggest-title';
    suggestBtn.textContent = '✨';
    suggestBtn.title = 'Suggest a title';
    suggestBtn.setAttribute('aria-label', 'Suggest a title');
    suggestBtn.addEventListener('click', async () => {
      // Busy affordance + guard against a second click while the model runs.
      suggestBtn.disabled = true;
      suggestBtn.classList.add('busy');
      try {
        // Keep the editor dumb: hand the host the raw body and let it decide
        // (empty-note / unavailable toasts live in app.js). A non-empty string
        // lands in the title field; null means "no change" (host already toasted).
        const suggested = await onSuggestTitle(ta.value);
        if (typeof suggested === 'string' && suggested.trim()) {
          titleInput.value = suggested;
          // Fire the SAME event a manual keystroke fires so growTitle + fireChange
          // (refresh + onChange + autosave) register the fill as a real edit.
          titleInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
      } finally {
        suggestBtn.disabled = false; // always re-enable, even on failure
        suggestBtn.classList.remove('busy');
      }
    });
    titleRow.appendChild(suggestBtn);
  }

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
  // Formatting row between title and body. Actions are pure edits from
  // src/lib/format.js routed through insertText, so each click is ONE native
  // undo step and the input event it fires drives refresh + autosave with no
  // extra plumbing. (insertText is a function declaration — hoisted, so this
  // wiring can sit above it.)
  const formatBar = document.createElement('div');
  formatBar.className = 'format-bar';
  const fmtActions = formatActions();
  const applyFormat = (run) => {
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? start;
    const edit = run(ta.value, start, end);
    if (!edit) return; // no-op (e.g. list button on a heading-only selection)
    insertText(edit.insert, edit.replaceStart, edit.replaceEnd);
    ta.setSelectionRange(edit.selStart, edit.selEnd);
  };
  renderFormatBar(formatBar, { apply: applyFormat, actions: fmtActions });

  // Compact current-note search lives at the right edge of the formatting row. It
  // highlights every body match without taking focus away while the user is typing;
  // Enter / Shift+Enter cycles forward / backward.
  const noteSearch = document.createElement('div');
  noteSearch.className = 'note-search';
  noteSearch.setAttribute('role', 'search');
  const noteSearchIcon = document.createElement('span');
  noteSearchIcon.className = 'note-search-icon';
  noteSearchIcon.textContent = '⌕';
  noteSearchIcon.setAttribute('aria-hidden', 'true');
  const noteSearchInput = document.createElement('input');
  noteSearchInput.type = 'search';
  noteSearchInput.className = 'note-search-input';
  noteSearchInput.placeholder = 'Find in note…';
  noteSearchInput.setAttribute('aria-label', 'Find in current note');
  noteSearchInput.title = 'Find in current note (Enter for next, Shift+Enter for previous)';
  const noteSearchCount = document.createElement('output');
  noteSearchCount.className = 'note-search-count';
  noteSearchCount.setAttribute('aria-live', 'polite');
  noteSearch.append(noteSearchIcon, noteSearchInput, noteSearchCount);
  formatBar.appendChild(noteSearch);

  let searchMatches = [];
  let activeSearchMatch = 0;

  function collectSearchMatches() {
    const query = noteSearchInput.value;
    searchMatches = [];
    if (!query) return;
    const haystack = ta.value.toLocaleLowerCase();
    const needle = query.toLocaleLowerCase();
    if (!needle) return;
    let from = 0;
    while (from <= haystack.length - needle.length) {
      const start = haystack.indexOf(needle, from);
      if (start < 0) break;
      searchMatches.push({ start, end: start + query.length });
      from = start + Math.max(needle.length, 1);
    }
  }

  function scrollToSearchMatch() {
    if (!searchMatches.length) return;
    const match = searchMatches[activeSearchMatch];
    ta.setSelectionRange(match.start, match.end);
    const line = ta.value.slice(0, match.start).split('\n').length - 1;
    const lineHeight = Number.parseFloat(getComputedStyle(ta).lineHeight) || 24;
    ta.scrollTop = Math.max(0, line * lineHeight - ta.clientHeight / 3);
    backdrop.scrollTop = ta.scrollTop;
  }

  function updateNoteSearch({ reset = false, scroll = false } = {}) {
    collectSearchMatches();
    if (reset || activeSearchMatch >= searchMatches.length) activeSearchMatch = 0;
    const hasQuery = !!noteSearchInput.value;
    noteSearchCount.hidden = !hasQuery;
    noteSearchCount.textContent = hasQuery
      ? (searchMatches.length ? `${activeSearchMatch + 1}/${searchMatches.length}` : '0/0')
      : '';
    noteSearch.classList.toggle('no-match', hasQuery && !searchMatches.length);
    renderHighlights();
    if (scroll) scrollToSearchMatch();
  }

  noteSearchInput.addEventListener('input', () => updateNoteSearch({ reset: true, scroll: true }));
  noteSearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      noteSearchInput.value = '';
      updateNoteSearch({ reset: true });
      ta.focus();
      return;
    }
    if (e.key !== 'Enter' || !searchMatches.length) return;
    e.preventDefault();
    activeSearchMatch = (activeSearchMatch + (e.shiftKey ? -1 : 1) + searchMatches.length) % searchMatches.length;
    updateNoteSearch({ scroll: true });
  });
  editPane.append(titleRow, formatBar, bodyWrap);
  const attachBar = document.createElement('div');
  attachBar.className = 'attachments-bar';
  editPane.append(attachBar, statusRow); // chips under the body; metadata + save state share the footer
  const preview = document.createElement('div');
  preview.className = 'preview';

  split.append(editPane, preview);
  panes.initEditSplitter(split); // draggable edit/preview divider — restores the saved ratio
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

  // Zoom bar, pinned to the foot of the preview. Appended after the content so it is the
  // last flex item, which is what puts it at the bottom when a note is shorter than the
  // pane. The level is the READER's preference, so it is handed back to the host to persist
  // rather than kept here — this editor is rebuilt on every note switch.
  const zoomBar = createZoomBar(preview, content, {
    value: previewZoom?.value,
    onChange: (zoom) => previewZoom?.onChange?.(zoom),
  });

  // Preview image lightbox. Event delegation on `content` survives every Markdown
  // refresh (including the later Drive-image replacement).
  const lightbox = document.createElement('div');
  lightbox.className = 'image-lightbox';
  lightbox.hidden = true;
  lightbox.setAttribute('role', 'dialog');
  lightbox.setAttribute('aria-modal', 'true');
  lightbox.setAttribute('aria-label', 'Enlarged note image');
  const lightboxZoom = document.createElement('output');
  lightboxZoom.className = 'image-lightbox-zoom';
  lightboxZoom.setAttribute('aria-live', 'polite');
  const lightboxClose = document.createElement('button');
  lightboxClose.type = 'button';
  lightboxClose.className = 'image-lightbox-close';
  lightboxClose.textContent = '×';
  lightboxClose.setAttribute('aria-label', 'Close enlarged image');
  const lightboxImage = document.createElement('img');
  lightboxImage.className = 'image-lightbox-image';
  lightbox.append(lightboxZoom, lightboxClose, lightboxImage);
  let lightboxOpener = null;
  let lightboxScale = 1;
  let lightboxPanX = 0;
  let lightboxPanY = 0;
  let lightboxDrag = null;

  function applyLightboxTransform() {
    const pan = lightboxPanX || lightboxPanY
      ? `translate3d(${Math.round(lightboxPanX)}px, ${Math.round(lightboxPanY)}px, 0) `
      : '';
    lightboxImage.style.transform = `${pan}scale(${lightboxScale})`;
  }

  function clampLightboxPan() {
    // getBoundingClientRect includes the current transform; dividing by scale
    // recovers the image's fitted size. jsdom reports zeroes, so tests retain the
    // raw drag delta while real browser views stay bounded to the image edges.
    const rect = lightboxImage.getBoundingClientRect();
    const viewportWidth = lightbox.clientWidth || window.innerWidth;
    const viewportHeight = lightbox.clientHeight || window.innerHeight;
    const baseWidth = lightboxScale ? rect.width / lightboxScale : rect.width;
    const baseHeight = lightboxScale ? rect.height / lightboxScale : rect.height;
    if (!baseWidth || !baseHeight || !viewportWidth || !viewportHeight) return;
    const maxX = Math.max(0, (baseWidth * lightboxScale - viewportWidth) / 2);
    const maxY = Math.max(0, (baseHeight * lightboxScale - viewportHeight) / 2);
    lightboxPanX = Math.min(maxX, Math.max(-maxX, lightboxPanX));
    lightboxPanY = Math.min(maxY, Math.max(-maxY, lightboxPanY));
  }

  function endLightboxDrag(event) {
    if (!lightboxDrag || (event?.pointerId != null && event.pointerId !== lightboxDrag.pointerId)) return;
    if (event?.pointerId != null && lightboxImage.hasPointerCapture?.(event.pointerId)) {
      lightboxImage.releasePointerCapture(event.pointerId);
    }
    lightboxDrag = null;
    lightboxImage.classList.remove('dragging');
  }

  function setLightboxScale(value) {
    lightboxScale = Math.min(5, Math.max(0.5, Math.round(value * 100) / 100));
    if (lightboxScale <= 1) {
      lightboxPanX = 0;
      lightboxPanY = 0;
      endLightboxDrag();
    }
    lightboxImage.classList.toggle('pannable', lightboxScale > 1);
    applyLightboxTransform();
    clampLightboxPan();
    applyLightboxTransform();
    lightboxZoom.value = `${Math.round(lightboxScale * 100)}%`;
    lightboxZoom.textContent = lightboxZoom.value;
  }

  function closeLightbox() {
    if (lightbox.hidden) return;
    endLightboxDrag();
    lightbox.hidden = true;
    lightboxImage.removeAttribute('src');
    lightboxPanX = 0;
    lightboxPanY = 0;
    setLightboxScale(1);
    lightboxOpener?.focus?.();
    lightboxOpener = null;
  }

  function openLightbox(img) {
    lightboxOpener = img;
    lightboxImage.src = img.currentSrc || img.src;
    lightboxImage.alt = img.alt || 'Enlarged note image';
    lightboxImage.draggable = false;
    lightbox.hidden = false;
    lightboxPanX = 0;
    lightboxPanY = 0;
    setLightboxScale(1);
    lightboxClose.focus();
  }

  function decoratePreviewImages(root) {
    for (const img of root.querySelectorAll('img')) {
      img.tabIndex = 0;
      img.title = img.title || 'Click to enlarge';
      img.setAttribute('role', 'button');
      img.setAttribute('aria-label', `Enlarge ${img.alt || 'note image'}`);
    }
  }

  content.addEventListener('click', (e) => {
    const img = e.target.closest?.('img');
    if (!img || !content.contains(img)) return;
    e.preventDefault();
    e.stopPropagation();
    openLightbox(img);
  });
  content.addEventListener('keydown', (e) => {
    const img = e.target.closest?.('img');
    if (!img || !content.contains(img) || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    openLightbox(img);
  });
  lightboxClose.addEventListener('click', closeLightbox);
  lightbox.addEventListener('click', (e) => { if (e.target === lightbox) closeLightbox(); });
  lightbox.addEventListener('wheel', (e) => {
    if (lightbox.hidden) return;
    e.preventDefault();
    setLightboxScale(lightboxScale * (e.deltaY < 0 ? 1.15 : (1 / 1.15)));
  }, { passive: false });
  lightboxImage.addEventListener('dragstart', (e) => e.preventDefault());
  lightboxImage.addEventListener('pointerdown', (e) => {
    if (lightboxScale <= 1 || e.button !== 0) return;
    e.preventDefault();
    lightboxDrag = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      panX: lightboxPanX,
      panY: lightboxPanY,
    };
    lightboxImage.setPointerCapture?.(e.pointerId);
    lightboxImage.classList.add('dragging');
  });
  lightboxImage.addEventListener('pointermove', (e) => {
    if (!lightboxDrag || (e.pointerId != null && e.pointerId !== lightboxDrag.pointerId)) return;
    e.preventDefault();
    lightboxPanX = lightboxDrag.panX + e.clientX - lightboxDrag.startX;
    lightboxPanY = lightboxDrag.panY + e.clientY - lightboxDrag.startY;
    clampLightboxPan();
    applyLightboxTransform();
  });
  lightboxImage.addEventListener('pointerup', endLightboxDrag);
  lightboxImage.addEventListener('pointercancel', endLightboxDrag);
  const onLightboxResize = () => {
    if (lightbox.hidden) return;
    clampLightboxPan();
    applyLightboxTransform();
  };
  window.addEventListener('resize', onLightboxResize);
  const onLightboxKeydown = (e) => { if (e.key === 'Escape' && !lightbox.hidden) closeLightbox(); };
  document.addEventListener('keydown', onLightboxKeydown);

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

  container.append(crumbs, bar, split, lightbox);
  growTitle(); // size the title to its content now that it's in the DOM
  // Recompute the auto-grown title height when the edit pane's width changes (pane drag /
  // window resize): a title that now wraps to more lines would otherwise clip (UI audit).
  // Guarded — jsdom has no ResizeObserver; self-limiting since growTitle is idempotent.
  let titleRO = null;
  if (typeof ResizeObserver !== 'undefined') {
    titleRO = new ResizeObserver(() => growTitle());
    titleRO.observe(titleInput);
  }

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
  const PREVIEW_IMG_REF_RE = /!\[([^\]]*)\]\(owl-img:([A-Za-z0-9]+)\)/g;
  const loadingImageIds = new Set();
  const recoveringImageIds = new Set();
  const failedImageIds = new Set();
  const loadedImageData = new Map();

  const imageRefIds = (text) => [...String(text ?? '').matchAll(PREVIEW_IMG_REF_RE)].map((m) => m[2]);

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

  // [Task E10] Replace the ENTIRE body with `text`, preserving the textarea's native
  // undo stack so a single Ctrl+Z reverts the whole reformat. This is the repo's
  // Arc-1 lesson: assigning `ta.value` wipes the browser's undo history, so we
  // instead select all and let execCommand('insertText') perform the replacement as
  // a real edit the browser can undo (it also fires a native `input` event, so
  // fireChange → onChange + autosave run). jsdom has no execCommand, so we fall back
  // to a value assignment plus the SAME input event a keystroke fires — the change
  // path must run either way so the new body is observed and persisted.
  function replaceBody(text) {
    const value = String(text ?? '');
    ta.focus();
    ta.setSelectionRange(0, ta.value.length);
    let ok = false;
    try { ok = !!(document.execCommand && document.execCommand('insertText', false, value)); } catch { ok = false; }
    if (!ok) {
      ta.value = value;
      ta.selectionStart = ta.selectionEnd = value.length;
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
      const nameEl = document.createElement('span');
      nameEl.className = 'attach-chip-name'; // truncates a long filename instead of overflowing
      nameEl.textContent = name;
      chip.append(ico, nameEl);
      chip.addEventListener('click', () => openAttachment(att, () => chip.classList.add('unavailable')));
      attachBar.appendChild(chip);
    }
  }

  // Drive-backed images have no inline dataUri on this device — fetch + cache them,
  // then re-render so they appear. Sync inlineImages (in refresh) shows what's local first.
  function resolveDriveImages() {
    const referenced = new Set(imageRefIds(ta.value));
    const pending = atts.filter((a) => referenced.has(a.id) && a.driveFileId && !a.dataUri && !loadedImageData.has(a.id)
      && !loadingImageIds.has(a.id) && !failedImageIds.has(a.id));
    for (const att of pending) {
      loadingImageIds.add(att.id);
      Promise.resolve()
        .then(() => loadImageBytes(att))
        .then((uri) => {
          if (destroyed) return;
          loadingImageIds.delete(att.id);
          if (uri) {
            // Keep downloaded bytes for this editor session. The saved attachment
            // remains a compact Drive pointer; getBytes has also cached the URI so a
            // later editor can recover it without another network request.
            loadedImageData.set(att.id, uri);
            failedImageIds.delete(att.id);
          } else {
            failedImageIds.add(att.id);
          }
          refresh(); // replace the progress box with the image (or unavailable state)
        })
        .catch(() => {
          if (destroyed) return;
          loadingImageIds.delete(att.id);
          failedImageIds.add(att.id);
          refresh();
        });
    }
  }

  // Draw a grey box behind each owl-img / owl-file reference so attachments stand out in
  // the raw markdown. The backdrop mirrors the textarea text and aligns 1:1 (monospace).
  const HL_RE = /!\[[^\]]*\]\(owl-img:[A-Za-z0-9]+\)|\[[^\]]*\]\(owl-file:[A-Za-z0-9]+\)/g;
  const escHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  function withImagePlaceholders(body) {
    return String(body ?? '').replace(PREVIEW_IMG_REF_RE, (whole, alt, id) => {
      const att = attById(id);
      const failed = failedImageIds.has(id) || (!att && !recoveringImageIds.has(id));
      const state = failed ? 'failed' : 'loading';
      const label = failed ? 'Image unavailable' : 'Loading image…';
      const name = alt || (att && att.name) || 'image';
      return `<span class="owl-image-placeholder ${state}" data-owl-img="${id}" role="status" aria-live="polite">`
        + `<span class="owl-image-spinner" aria-hidden="true"></span>`
        + `<span class="owl-image-state">${label}</span><small>${escHtml(name)}</small></span>`;
    });
  }
  function renderHighlights() {
    const text = ta.value;
    const ranges = [];
    for (const m of text.matchAll(HL_RE)) ranges.push({ start: m.index, end: m.index + m[0].length, kind: 'attachment' });
    searchMatches.forEach((m, index) => ranges.push({ ...m, kind: index === activeSearchMatch ? 'search-active' : 'search' }));
    ranges.sort((a, b) => a.start - b.start || (a.kind.startsWith('search') ? -1 : 1));
    let html = '';
    let last = 0;
    for (const range of ranges) {
      if (range.start < last) continue;
      const cls = range.kind === 'attachment' ? 'attachment-ref'
        : (range.kind === 'search-active' ? 'note-search-hit active' : 'note-search-hit');
      html += escHtml(text.slice(last, range.start)) + `<mark class="${cls}">` + escHtml(text.slice(range.start, range.end)) + '</mark>';
      last = range.end;
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
    const previewAttachments = atts.map((att) => loadedImageData.has(att.id)
      ? { ...att, dataUri: loadedImageData.get(att.id) }
      : att);
    const previewBody = withImagePlaceholders(inlineImages(ta.value, previewAttachments));
    bodyEl.innerHTML = renderMarkdown(linkifyFileRefs(previewBody)); // local images inline; remote images show progress until hydrated
    content.appendChild(bodyEl);
    decorateCodeBlocks(content);
    wireFileLinks(content);
    decoratePreviewImages(content);
    // Last of the decorators: it rewrites text nodes, so everything that looks for
    // its own markup (code blocks, file links, images) must have run already.
    //
    // Asked for per refresh rather than captured once: the reading tables load in the
    // background, so a segmenter that was null when this editor was built can be ready by
    // the time the reader's next keystroke repaints the preview.
    const segment = phonetics?.enabled ? phonetics.segmenter?.() : null;
    content.classList.toggle('phonetics', !!segment);
    if (segment) annotateRuby(content, segment);
    renderChips();
    updateNoteSearch();
    resolveDriveImages();
    updateSize();
  };

  // Typing a new header cell should fill the matching empty cells into the rows
  // below, rather than leaving a table that no longer parses. Only ever APPENDS
  // ` |` at the ends of lines, so nothing the user has typed moves, and the
  // caret is remapped exactly. Guarded because insertText fires `input` again.
  let aligningTable = false;
  const alignTable = () => {
    if (aligningTable) return;
    const edit = alignTableAt(ta.value, ta.selectionStart ?? 0);
    if (!edit) return;
    aligningTable = true;
    try {
      insertText(edit.insert, edit.replaceStart, edit.replaceEnd); // one undo step
      ta.setSelectionRange(edit.selStart, edit.selEnd);
    } finally {
      aligningTable = false;
    }
  };

  const fireChange = () => {
    alignTable();
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
  const setStatus = (s) => {
    status.textContent = s;
    statusRow.hidden = updatedLabel.hidden && !s;
  };
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
      const saved = await onSave({ title, body, attachments: pruneAttachments(ta.value, atts) }, { auto });
      if (saved) setTimestamps({ created: saved.created, updated: saved.updated });
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
  // Ctrl/Cmd+B / I / U / K are the universal formatting shortcuts. Alt+Enter
  // has one table-specific meaning below; other modifier combos stay untouched.
  const shortcutActions = new Map(fmtActions.filter((a) => a.shortcut).map((a) => [a.shortcut, a]));
  ta.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return; // IME composition — never format mid-composition (ask-panel.js convention)
    // Excel-style Alt+Enter creates a visual newline inside the current cell.
    // It inserts <br>, not a physical newline, because GFM table rows cannot
    // span source lines. Outside a valid cell the browser keeps normal control.
    if (e.key === 'Enter' && e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      const edit = tableCellLineBreak(ta.value, ta.selectionStart, ta.selectionEnd);
      if (edit) {
        e.preventDefault();
        insertText(edit.insert, edit.replaceStart, edit.replaceEnd);
        ta.setSelectionRange(edit.selStart, edit.selEnd);
      }
      return;
    }
    // Enter inside a table opens the next row. nextTableRow returns null
    // everywhere else, so a plain Enter keeps its normal behaviour — including
    // Shift+Enter, which stays a hard line break inside a cell's paragraph.
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const edit = nextTableRow(ta.value, ta.selectionStart, ta.selectionEnd);
      if (edit) {
        e.preventDefault();
        insertText(edit.insert, edit.replaceStart, edit.replaceEnd);
        ta.setSelectionRange(edit.selStart, edit.selEnd);
      }
      return;
    }
    // Tab walks cell to cell inside a table, selecting each cell so typing
    // replaces it. tableCellTarget returns null outside a table AND for
    // Shift+Tab in the very first cell, so Tab always keeps a way to move focus
    // out of the textarea — it is never trapped.
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const move = tableCellTarget(ta.value, ta.selectionStart, ta.selectionEnd, !e.shiftKey);
      if (move) {
        e.preventDefault();
        if (move.insert != null) insertText(move.insert, move.replaceStart, move.replaceEnd);
        ta.setSelectionRange(move.selStart, move.selEnd);
      }
      return;
    }
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    const action = shortcutActions.get(e.key.toLowerCase());
    if (!action) return;
    e.preventDefault();
    applyFormat(action.run);
  });
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

  // Attachments are inline tokens inside table cells, but block-style everywhere
  // else. A physical newline inside a pipe row would split and break the table.
  function attachmentSnippet(ref, start, end) {
    if (isTableCellSelection(ta.value, start, end)) return ref;
    const before = ta.value.slice(0, start);
    return (before && !before.endsWith('\n') ? '\n' : '') + ref + '\n';
  }

  // Shared image insertion pipeline used by Draw, the 🖼 button, paste, and drop.
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
      const snippet = attachmentSnippet(ref, start, end);
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

  // Shared ordinary-file pipeline used by the File button, paste, and drop.
  // Files become compact owl-file refs while their bytes live in attachments.
  async function insertAttachmentFile(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let bin = ''; for (let k = 0; k < bytes.length; k++) bin += String.fromCharCode(bytes[k]);
    const dataUri = `data:${file.type || 'application/octet-stream'};base64,${btoa(bin)}`;
    const { ref, attachments: merged } = attachFile({ name: file.name || 'file', mime: file.type, dataUri }, atts);
    atts = merged;
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? start;
    const snippet = attachmentSnippet(ref, start, end);
    insertText(snippet, start, end); // keeps undo alive
  }

  function filesFromTransfer(transfer) {
    const itemFiles = [...(transfer?.items || [])]
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile?.())
      .filter(Boolean);
    return itemFiles.length ? itemFiles : [...(transfer?.files || [])];
  }

  async function insertTransferredFiles(files) {
    for (const file of files) {
      if (String(file.type || '').startsWith('image/')) await insertImageFile(file);
      else await insertAttachmentFile(file);
    }
  }

  fileBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (file) await insertAttachmentFile(file);
  });

  // Paste real clipboard files through the same paths as the Image/File buttons.
  // Plain text is untouched so the browser retains its normal paste behavior.
  ta.addEventListener('paste', async (e) => {
    const files = filesFromTransfer(e.clipboardData);
    if (!files.length) {
      // A copied owl-img/owl-file link contains only an id; recover its attachment
      // from the source note so the preview and eventual save keep working.
      const text = e.clipboardData?.getData?.('text/plain') || '';
      if (!recoverAttachments || !/\bowl-(?:img|file):[A-Za-z0-9]+\b/.test(text)) return;
      e.preventDefault();
      const pastedImageIds = imageRefIds(text);
      pastedImageIds.forEach((id) => { recoveringImageIds.add(id); failedImageIds.delete(id); });
      const start = ta.selectionStart ?? ta.value.length;
      insertText(text, start, ta.selectionEnd ?? start);
      let added = false;
      try {
        const recovered = await recoverAttachments({ body: ta.value, attachments: atts.slice() });
        const candidates = Array.isArray(recovered) ? recovered : recovered?.attachments;
        if (Array.isArray(candidates)) {
          const byId = new Map(atts.map((a) => [a.id, a]));
          for (const att of candidates) {
            if (att && !byId.has(att.id)) { byId.set(att.id, att); failedImageIds.delete(att.id); added = true; }
          }
          if (added) atts = [...byId.values()];
        }
      } catch { /* leave the pasted text intact when its source attachment is unavailable */ }
      finally {
        pastedImageIds.forEach((id) => {
          recoveringImageIds.delete(id);
          if (!attById(id)) failedImageIds.add(id);
        });
        if (added) fireChange();
        else refresh();
      }
      return;
    }
    e.preventDefault();
    await insertTransferredFiles(files);
  });

  // Dragging over the body mirrors paste, with a clear target so users know both
  // images and ordinary files can be attached here.
  const hasDraggedFiles = (transfer) => [...(transfer?.types || [])].includes('Files')
    || [...(transfer?.items || [])].some((item) => item.kind === 'file');
  bodyWrap.addEventListener('dragover', (e) => {
    if (!hasDraggedFiles(e.dataTransfer)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    bodyWrap.classList.add('file-drop-active');
  });
  bodyWrap.addEventListener('dragleave', (e) => {
    if (!bodyWrap.contains(e.relatedTarget)) bodyWrap.classList.remove('file-drop-active');
  });
  bodyWrap.addEventListener('drop', async (e) => {
    const files = filesFromTransfer(e.dataTransfer);
    bodyWrap.classList.remove('file-drop-active');
    if (!files.length) return;
    e.preventDefault();
    e.stopPropagation();
    ta.focus();
    await insertTransferredFiles(files);
  });

  if (focusTitle) {
    titleInput.focus();
    titleInput.select();
  }

  return {
    getBody: () => ta.value,
    getTitle: () => titleInput.value,
    getAttachments: () => atts,
    replaceBody, // [Task E10] undo-preserving whole-body replace (Format's Apply path)
    refresh, // repaint the preview in place — lets a late-arriving reading table show up
             // without rebuilding the editor and taking the caret with it
    setShareActionVisible: (id, visible) => { const item = shareItems.get(id); if (item) item.hidden = !visible; },
    flush: () => doSave({ auto: true }),
    destroy: () => {
      destroyed = true;
      clearTimeout(saveTimer);
      zoomBar.destroy();
      titleRO?.disconnect();
      document.removeEventListener('keydown', onLightboxKeydown);
      window.removeEventListener('resize', onLightboxResize);
      document.removeEventListener('click', closeShareMenu);
    }, // cancel pending auto-save + stop observing on teardown
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
