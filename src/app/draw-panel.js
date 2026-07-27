// src/app/draw-panel.js
// The sketchpad's view: a modal canvas over the app, following the dialog idiom
// in pdf-share-dialog.js (backdrop, aria-modal, Escape, focus restored on close).
// It owns pixels and pointer events only — what a drawing IS lives in
// src/lib/drawing.js, which keeps this file readable and the geometry testable
// without a real canvas.
import {
  createSketch, beginStroke, extendStroke, straightenStroke, endStroke,
  beginShape, updateShape, endShape,
  addImage, imageAt, beginTransform, applyTransform, endTransform, removeItem,
  undo, redo, clear, isEmpty, canUndo, canRedo, replay, visibleItems, boxOf,
  isShapeTool, isFreehandTool,
  PEN, HIGHLIGHT, ERASE, SELECT, LINE, ARROW, RECT, ROUND_RECT, ELLIPSE,
} from '../lib/drawing.js';

const TOOLS = [
  { id: SELECT, className: 'draw-tool-select', glyph: '↖', label: 'Select — move or resize a pasted photo' },
  { id: PEN, className: 'draw-tool-pen', glyph: '✏️', label: 'Pen — hold Shift for a straight line' },
  { id: HIGHLIGHT, className: 'draw-tool-highlight', glyph: '🖍', label: 'Highlighter — hold Shift for a straight line' },
  { id: ERASE, className: 'draw-tool-erase', glyph: '◻️', label: 'Eraser' },
  { id: LINE, className: 'draw-tool-line', glyph: '╱', label: 'Line — hold Shift to snap to 45°' },
  { id: ARROW, className: 'draw-tool-arrow', glyph: '↗', label: 'Arrow — hold Shift to snap to 45°' },
  { id: RECT, className: 'draw-tool-rect', glyph: '▭', label: 'Rectangle — hold Shift for a square' },
  { id: ROUND_RECT, className: 'draw-tool-round-rect', glyph: '▢', label: 'Rounded rectangle — hold Shift for a square' },
  { id: ELLIPSE, className: 'draw-tool-ellipse', glyph: '◯', label: 'Ellipse — hold Shift for a circle' },
];

const COLORS = [
  { value: '#202124', label: 'Black' },
  { value: '#d93025', label: 'Red' },
  { value: '#1a73e8', label: 'Blue' },
  { value: '#137333', label: 'Green' },
  { value: '#f29900', label: 'Amber' },
];
const WIDTHS = [
  { value: 2, label: 'Thin' },
  { value: 4, label: 'Medium' },
  { value: 8, label: 'Thick' },
];
// An eraser you can barely see is useless — it tracks the pen's width but wider.
const ERASER_SCALE = 3;
// A highlighter lays down a broad band, not a line.
const HIGHLIGHT_SCALE = 5;

// The width actually laid down, which is what the cursor ring must preview —
// otherwise the ring lies about the eraser and the highlighter.
export function effectiveWidth(tool, width) {
  if (tool === ERASE) return width * ERASER_SCALE;
  if (tool === HIGHLIGHT) return width * HIGHLIGHT_SCALE;
  return width;
}
// Used when the layout reports nothing (jsdom, or a panel measured before paint).
const FALLBACK_SIZE = { width: 960, height: 560 };
const HANDLE = 8;          // corner handle size, in CSS pixels
const HANDLE_GRAB = 12;    // how close the pointer must be to grab one
// A pasted photo lands at most this fraction of the canvas, so a phone-camera
// image does not cover the whole sketch the moment it arrives.
const PASTE_FIT = 0.6;

const raf = typeof requestAnimationFrame === 'function'
  ? requestAnimationFrame
  : (fn) => setTimeout(fn, 16);
const cancelRaf = typeof cancelAnimationFrame === 'function'
  ? cancelAnimationFrame
  : clearTimeout;

function two(n) { return String(n).padStart(2, '0'); }

export function drawingFileName(date = new Date()) {
  return `drawing-${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}`
    + `-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}.png`;
}

// Decode a data: URI into something canvas can draw. Browser-only; the panel
// takes this as an option so tests can supply dimensions without a decoder.
export function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('image decode failed'));
    el.src = src;
  });
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

// Flatten items onto white. Two canvases, deliberately: eraser strokes use
// 'destination-out', so replaying them straight onto a white fill would cut
// holes THROUGH the white. The items are composited on a transparent layer
// which is then stamped onto the opaque one.
export async function drawingToPngBlob(items, width, height, scale = 1) {
  const layer = document.createElement('canvas');
  layer.width = Math.max(1, Math.round(width * scale));
  layer.height = Math.max(1, Math.round(height * scale));
  const layerCtx = layer.getContext('2d');
  if (!layerCtx) throw new Error('no 2d context');
  layerCtx.scale(scale, scale);
  replay(layerCtx, items);

  const flat = document.createElement('canvas');
  flat.width = layer.width;
  flat.height = layer.height;
  const ctx = flat.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, flat.width, flat.height);
  ctx.drawImage(layer, 0, 0);

  if (typeof flat.toBlob !== 'function') throw new Error('toBlob unsupported');
  return await new Promise((resolve, reject) => {
    flat.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob produced nothing'))), 'image/png');
  });
}

function button(className, text, title) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = className;
  el.textContent = text;
  if (title) {
    el.title = title;
    el.setAttribute('aria-label', title);
  }
  return el;
}

// The four corners of a box, in the order the resize logic indexes them.
function cornersOf(box) {
  return [
    { id: 'nw', x: box.x, y: box.y },
    { id: 'ne', x: box.x + box.width, y: box.y },
    { id: 'se', x: box.x + box.width, y: box.y + box.height },
    { id: 'sw', x: box.x, y: box.y + box.height },
  ];
}

// Resize from a corner: the opposite corner stays pinned. Shift keeps the
// photo's aspect ratio, which is what you almost always want for a photo.
export function resizeBox(box, corner, x, y, keepAspect = false) {
  const right = corner === 'ne' || corner === 'se';
  const bottom = corner === 'se' || corner === 'sw';
  const anchorX = right ? box.x : box.x + box.width;
  const anchorY = bottom ? box.y : box.y + box.height;
  let w = Math.abs(x - anchorX);
  let h = Math.abs(y - anchorY);
  if (keepAspect && box.width > 0 && box.height > 0) {
    const ratio = box.height / box.width;
    if (w * ratio > h) h = w * ratio; else w = h / ratio;
  }
  return { x: right ? anchorX : anchorX - w, y: bottom ? anchorY : anchorY - h, width: w, height: h };
}

export function showDrawPanel({
  onSave = () => {},
  exportBlob = drawingToPngBlob,
  now = () => new Date(),
  loadImage = loadImageElement,
} = {}) {
  document.querySelector('.draw-backdrop')?.remove();

  const state = createSketch();
  let tool = PEN;
  let color = COLORS[0].value;
  let width = WIDTHS[1].value;
  let selected = null;      // index into state.items; images only
  let drag = null;          // { mode: 'draw' | 'move' | 'resize', ... }
  let shiftHeld = false;
  let cursor = null;        // last pointer position, for the brush-size ring
  let frame = 0;

  const backdrop = document.createElement('div');
  backdrop.className = 'share-link-backdrop draw-backdrop';
  const dialog = document.createElement('section');
  dialog.className = 'share-link-dialog draw-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'draw-title');

  const header = document.createElement('header');
  const heading = document.createElement('h2');
  heading.id = 'draw-title';
  heading.textContent = 'Draw';
  const closeButton = button('share-link-close draw-close', '×', 'Close drawing panel');
  header.append(heading, closeButton);

  const tools = document.createElement('div');
  tools.className = 'draw-tools';

  const toolButtons = TOOLS.map((t) => {
    const el = button(`draw-tool ${t.className}${t.id === tool ? ' active' : ''}`, t.glyph, t.label);
    el.dataset.tool = t.id;
    tools.appendChild(el);
    return el;
  });

  const colorDivider = document.createElement('span');
  colorDivider.className = 'draw-divider';
  tools.appendChild(colorDivider);
  const colorButtons = COLORS.map((c, i) => {
    const el = button(`draw-color${i === 0 ? ' active' : ''}`, '', c.label);
    el.dataset.color = c.value;
    el.style.background = c.value;
    tools.appendChild(el);
    return el;
  });

  const widthDivider = document.createElement('span');
  widthDivider.className = 'draw-divider';
  tools.appendChild(widthDivider);
  // The swatch is a dot drawn at the ACTUAL stroke width, so the toolbar shows
  // the size rather than describing it.
  const widthButtons = WIDTHS.map((w) => {
    const el = button(`draw-width${w.value === width ? ' active' : ''}`, '', `${w.label} stroke`);
    el.dataset.width = String(w.value);
    const dot = document.createElement('span');
    dot.className = 'draw-width-dot';
    dot.style.width = `${w.value}px`;
    dot.style.height = `${w.value}px`;
    el.appendChild(dot);
    tools.appendChild(el);
    return el;
  });

  const historyDivider = document.createElement('span');
  historyDivider.className = 'draw-divider';
  const undoButton = button('draw-undo', '↶', 'Undo (Ctrl+Z)');
  const redoButton = button('draw-redo', '↷', 'Redo (Ctrl+Shift+Z)');
  const clearButton = button('draw-clear', 'Clear', 'Clear the whole drawing');
  tools.append(historyDivider, undoButton, redoButton, clearButton);

  const canvas = document.createElement('canvas');
  canvas.className = 'draw-canvas';
  canvas.tabIndex = 0;
  canvas.setAttribute('aria-label', 'Drawing canvas');

  const hint = document.createElement('p');
  hint.className = 'draw-hint';
  hint.textContent = 'Hold Shift to constrain · paste a photo with Ctrl+V, then drag its corners to resize';

  const status = document.createElement('div');
  status.className = 'draw-status';
  status.setAttribute('aria-live', 'polite');

  const footer = document.createElement('footer');
  const cancelButton = button('share-link-copy draw-cancel', 'Cancel');
  const saveButton = button('share-link-done draw-save', 'Save drawing');
  saveButton.disabled = true;
  footer.append(cancelButton, saveButton);

  const confirmRow = document.createElement('footer');
  confirmRow.className = 'draw-confirm';
  confirmRow.hidden = true;
  const confirmText = document.createElement('span');
  confirmText.textContent = 'Discard this drawing?';
  const keepButton = button('share-link-copy draw-keep', 'Keep drawing');
  const discardButton = button('share-link-done danger draw-discard', 'Discard');
  confirmRow.append(confirmText, keepButton, discardButton);

  dialog.append(header, tools, canvas, hint, status, footer, confirmRow);
  backdrop.appendChild(dialog);
  const previouslyFocused = document.activeElement;
  document.body.appendChild(backdrop); // append before measuring: layout must exist

  // The surface is measured once and then fixed. Resizing a canvas clears it, so
  // reacting to window resize would silently destroy work mid-drawing.
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const cssWidth = Math.max(1, Math.round(rect.width || FALLBACK_SIZE.width));
  const cssHeight = Math.max(1, Math.round(rect.height || FALLBACK_SIZE.height));
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  const ctx = canvas.getContext('2d'); // null under jsdom — replay() handles that
  if (ctx) ctx.scale(dpr, dpr);

  function paintSelection() {
    if (selected == null) return;
    const item = state.items[selected];
    if (!item) return;
    const box = boxOf(item);
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = '#1a73e8';
    ctx.lineWidth = 1;
    ctx.setLineDash?.([4, 3]);
    ctx.strokeRect(box.x, box.y, box.width, box.height);
    ctx.setLineDash?.([]);
    ctx.fillStyle = '#ffffff';
    for (const corner of cornersOf(box)) {
      ctx.fillRect(corner.x - HANDLE / 2, corner.y - HANDLE / 2, HANDLE, HANDLE);
      ctx.strokeRect(corner.x - HANDLE / 2, corner.y - HANDLE / 2, HANDLE, HANDLE);
    }
    ctx.restore();
  }

  // A ring at the pointer, drawn at the exact width the tool will lay down.
  // Without it, changing the stroke size gives no feedback until after a stroke
  // is already committed — which is the whole point of this preview.
  function paintCursor() {
    if (!cursor || !isFreehandTool(tool)) return;
    const radius = Math.max(1.5, effectiveWidth(tool, width) / 2);
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineWidth = 1;
    // Two rings, dark over light, so the preview stays visible on white paper
    // and on top of a dark photo alike.
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.arc(cursor.x, cursor.y, radius + 1, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = tool === ERASE ? 'rgba(32,33,36,0.75)' : color;
    ctx.beginPath();
    ctx.arc(cursor.x, cursor.y, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function paint() {
    frame = 0;
    if (!ctx) return;
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    replay(ctx, visibleItems(state));
    // Chrome only — both are drawn after replay, so neither ever exports.
    paintSelection();
    paintCursor();
  }

  function syncControls() {
    saveButton.disabled = isEmpty(state);
    undoButton.disabled = !canUndo(state);
    redoButton.disabled = !canRedo(state);
    clearButton.disabled = isEmpty(state);
    // Hide the OS cursor for brush tools: the ring is the cursor, and showing
    // both reads as two pointers.
    canvas.classList.toggle('brush', isFreehandTool(tool));
  }

  function invalidate() {
    syncControls();
    if (!frame) frame = raf(paint);
  }
  syncControls();

  function pointAt(event) {
    const box = canvas.getBoundingClientRect();
    return { x: (event.clientX || 0) - (box.left || 0), y: (event.clientY || 0) - (box.top || 0) };
  }

  function handleAt(x, y) {
    if (selected == null || !state.items[selected]) return null;
    for (const corner of cornersOf(boxOf(state.items[selected]))) {
      if (Math.abs(x - corner.x) <= HANDLE_GRAB && Math.abs(y - corner.y) <= HANDLE_GRAB) return corner.id;
    }
    return null;
  }

  function selectItem(index) {
    selected = index;
    invalidate();
  }

  /* ------------------------------------------------------------- pointer */

  canvas.addEventListener('pointerdown', (event) => {
    if (event.button != null && event.button !== 0) return; // left button / touch / pen only
    event.preventDefault();
    canvas.setPointerCapture?.(event.pointerId);
    shiftHeld = !!event.shiftKey;
    const { x, y } = pointAt(event);

    if (tool === SELECT) {
      const corner = handleAt(x, y);
      if (corner) {
        beginTransform(state, selected);
        drag = { mode: 'resize', corner, box: { ...boxOf(state.items[selected]) } };
        return;
      }
      const index = imageAt(state, x, y);
      if (index < 0) { selectItem(null); drag = null; return; }
      selectItem(index);
      beginTransform(state, index);
      const item = state.items[index];
      drag = { mode: 'move', offsetX: x - item.x, offsetY: y - item.y };
      return;
    }

    selected = null;
    if (isFreehandTool(tool)) {
      beginStroke(state, { x, y, color, width: effectiveWidth(tool, width), mode: tool });
    } else if (isShapeTool(tool)) {
      beginShape(state, { tool, x, y, color, width });
    }
    drag = { mode: 'draw' };
    invalidate();
  });

  canvas.addEventListener('pointermove', (event) => {
    shiftHeld = !!event.shiftKey;
    const { x, y } = pointAt(event);
    cursor = { x, y };
    if (!drag) { invalidate(); return; } // still repaint, so the ring follows

    if (drag.mode === 'draw') {
      if (isFreehandTool(tool)) {
        if (shiftHeld) straightenStroke(state, { x, y, constrain: true });
        else extendStroke(state, { x, y });
      } else {
        updateShape(state, { x, y, constrain: shiftHeld });
      }
    } else if (drag.mode === 'move') {
      applyTransform(state, { x: x - drag.offsetX, y: y - drag.offsetY });
    } else if (drag.mode === 'resize') {
      applyTransform(state, resizeBox(drag.box, drag.corner, x, y, shiftHeld));
    }
    invalidate();
  });

  function finishDrag(event) {
    if (!drag) return;
    if (event?.pointerId != null && canvas.hasPointerCapture?.(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
    if (drag.mode === 'draw') {
      if (isFreehandTool(tool)) endStroke(state);
      else endShape(state);
    } else {
      endTransform(state);
    }
    drag = null;
    invalidate();
  }
  canvas.addEventListener('pointerup', finishDrag);
  canvas.addEventListener('pointercancel', finishDrag);
  canvas.addEventListener('pointerleave', () => { cursor = null; invalidate(); });

  /* --------------------------------------------------------------- paste */

  async function placeImageFile(file) {
    try {
      const src = await readAsDataUrl(file);
      const el = await loadImage(src);
      const naturalWidth = el.naturalWidth || el.width || 320;
      const naturalHeight = el.naturalHeight || el.height || 240;
      const fit = Math.min(1, (cssWidth * PASTE_FIT) / naturalWidth, (cssHeight * PASTE_FIT) / naturalHeight);
      const w = Math.max(8, Math.round(naturalWidth * fit));
      const h = Math.max(8, Math.round(naturalHeight * fit));
      const index = addImage(state, {
        src,
        el,
        x: Math.round((cssWidth - w) / 2),
        y: Math.round((cssHeight - h) / 2),
        width: w,
        height: h,
      });
      setTool(SELECT); // so the fresh photo can be dragged immediately
      selectItem(index);
      status.textContent = '';
      return index;
    } catch {
      status.textContent = 'Could not paste that image.';
      return -1;
    }
  }

  async function onPaste(event) {
    const entries = [...(event.clipboardData?.items || [])];
    const entry = entries.find((i) => String(i.type || '').startsWith('image/'));
    if (!entry) return;
    event.preventDefault();
    const file = entry.getAsFile?.();
    if (file) await placeImageFile(file);
  }
  document.addEventListener('paste', onPaste);

  /* ------------------------------------------------------------ controls */

  function setTool(next) {
    tool = next;
    for (const el of toolButtons) el.classList.toggle('active', el.dataset.tool === next);
    if (next !== SELECT) selected = null;
    invalidate();
  }
  for (const el of toolButtons) el.addEventListener('click', () => setTool(el.dataset.tool));

  for (const el of colorButtons) {
    el.addEventListener('click', () => {
      color = el.dataset.color;
      if (tool === ERASE || tool === SELECT) setTool(PEN); // picking a color means you want to draw
      for (const other of colorButtons) other.classList.toggle('active', other === el);
    });
  }
  for (const el of widthButtons) {
    el.addEventListener('click', () => {
      width = Number(el.dataset.width);
      for (const other of widthButtons) other.classList.toggle('active', other === el);
    });
  }
  undoButton.addEventListener('click', () => { selected = null; undo(state); invalidate(); });
  redoButton.addEventListener('click', () => { selected = null; redo(state); invalidate(); });
  clearButton.addEventListener('click', () => { selected = null; clear(state); invalidate(); });

  function close() {
    document.removeEventListener('keydown', onKeydown);
    document.removeEventListener('paste', onPaste);
    if (frame) cancelRaf(frame);
    backdrop.remove();
    previouslyFocused?.focus?.();
  }

  // One route for every dismissal — ×, Cancel, Escape, backdrop click — so real
  // work can never vanish to a stray keypress. An inline row, not window.confirm:
  // a blocking browser modal is out of place inside an extension page.
  function requestClose() {
    if (isEmpty(state)) { close(); return; }
    confirmRow.hidden = false;
    footer.hidden = true;
    keepButton.focus();
  }
  function keepDrawing() {
    confirmRow.hidden = true;
    footer.hidden = false;
    canvas.focus();
  }

  function onKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      // Escape clears a selection first, so it never means "throw away my work"
      // when the user only meant to deselect a photo.
      if (selected != null) { selectItem(null); return; }
      requestClose();
      return;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && selected != null) {
      event.preventDefault();
      removeItem(state, selected);
      selectItem(null);
      return;
    }
    if (!(event.ctrlKey || event.metaKey)) return;
    const key = String(event.key).toLowerCase();
    if (key === 'z' && !event.shiftKey) { event.preventDefault(); selected = null; undo(state); invalidate(); }
    else if ((key === 'z' && event.shiftKey) || key === 'y') { event.preventDefault(); selected = null; redo(state); invalidate(); }
  }
  document.addEventListener('keydown', onKeydown);

  closeButton.addEventListener('click', requestClose);
  cancelButton.addEventListener('click', requestClose);
  keepButton.addEventListener('click', keepDrawing);
  discardButton.addEventListener('click', close);
  backdrop.addEventListener('click', (event) => { if (event.target === backdrop) requestClose(); });

  saveButton.addEventListener('click', async () => {
    if (isEmpty(state)) return;
    saveButton.disabled = true;
    saveButton.textContent = 'Saving…';
    status.textContent = '';
    let blob;
    try {
      blob = await exportBlob(state.items, cssWidth, cssHeight, dpr);
    } catch {
      status.textContent = 'Could not export the drawing. Your strokes are still here.';
      saveButton.disabled = false;
      saveButton.textContent = 'Save drawing';
      return;
    }
    const file = new File([blob], drawingFileName(now()), { type: 'image/png' });
    // Close first, then hand off: onSave may be async, and its failures belong to
    // the editor's status line, not this panel's.
    close();
    onSave(file);
  });

  canvas.focus();
  return { close, canvas, saveButton, dialog, placeImageFile, state };
}
