// src/app/draw-panel.js
// The sketchpad's view: a modal canvas over the app, following the dialog idiom
// in pdf-share-dialog.js (backdrop, aria-modal, Escape, focus restored on close).
// It owns pixels and pointer events only — what a drawing IS lives in
// src/lib/drawing.js, which keeps this file readable and the history logic
// testable without a real canvas.
import {
  createSketch, beginStroke, extendStroke, endStroke,
  undo, redo, clear, isEmpty, canUndo, canRedo, replay, PEN, ERASE,
} from '../lib/drawing.js';

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
// Used when the layout reports nothing (jsdom, or a panel measured before paint).
const FALLBACK_SIZE = { width: 960, height: 560 };

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

// Flatten strokes onto white. Two canvases, deliberately: eraser strokes use
// 'destination-out', so replaying them straight onto a white fill would cut
// holes THROUGH the white. The strokes are composited on a transparent layer
// which is then stamped onto the opaque one.
export async function drawingToPngBlob(strokes, width, height, scale = 1) {
  const layer = document.createElement('canvas');
  layer.width = Math.max(1, Math.round(width * scale));
  layer.height = Math.max(1, Math.round(height * scale));
  const layerCtx = layer.getContext('2d');
  if (!layerCtx) throw new Error('no 2d context');
  layerCtx.scale(scale, scale);
  replay(layerCtx, strokes);

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

export function showDrawPanel({ onSave = () => {}, exportBlob = drawingToPngBlob, now = () => new Date() } = {}) {
  document.querySelector('.draw-backdrop')?.remove();

  const state = createSketch();
  let tool = PEN;
  let color = COLORS[0].value;
  let width = WIDTHS[1].value;
  let drawing = false;
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
  const penButton = button('draw-tool draw-tool-pen active', '✏️', 'Pen');
  const eraseButton = button('draw-tool draw-tool-erase', '◻️', 'Eraser');
  const toolDivider = document.createElement('span');
  toolDivider.className = 'draw-divider';
  tools.append(penButton, eraseButton, toolDivider);

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
  const widthButtons = WIDTHS.map((w) => {
    const el = button(`draw-width${w.value === width ? ' active' : ''}`, '●', `${w.label} stroke`);
    el.dataset.width = String(w.value);
    el.style.fontSize = `${8 + w.value}px`;
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

  dialog.append(header, tools, canvas, status, footer, confirmRow);
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

  function paint() {
    frame = 0;
    if (!ctx) return;
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    replay(ctx, state.strokes);
  }

  function syncControls() {
    saveButton.disabled = isEmpty(state);
    undoButton.disabled = !canUndo(state);
    redoButton.disabled = !canRedo(state);
    clearButton.disabled = isEmpty(state);
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

  canvas.addEventListener('pointerdown', (event) => {
    if (event.button != null && event.button !== 0) return; // left button / touch / pen only
    event.preventDefault();
    canvas.setPointerCapture?.(event.pointerId);
    drawing = true;
    const { x, y } = pointAt(event);
    beginStroke(state, {
      x,
      y,
      color,
      width: tool === ERASE ? width * ERASER_SCALE : width,
      mode: tool,
    });
    invalidate();
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!drawing) return;
    const { x, y } = pointAt(event);
    extendStroke(state, { x, y });
    invalidate();
  });
  function finishStroke(event) {
    if (!drawing) return;
    drawing = false;
    if (event?.pointerId != null && canvas.hasPointerCapture?.(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
    endStroke(state);
    invalidate();
  }
  canvas.addEventListener('pointerup', finishStroke);
  canvas.addEventListener('pointercancel', finishStroke);

  function selectIn(buttons, chosen) {
    for (const el of buttons) el.classList.toggle('active', el === chosen);
  }
  penButton.addEventListener('click', () => { tool = PEN; selectIn([penButton, eraseButton], penButton); });
  eraseButton.addEventListener('click', () => { tool = ERASE; selectIn([penButton, eraseButton], eraseButton); });
  for (const el of colorButtons) {
    el.addEventListener('click', () => {
      color = el.dataset.color;
      tool = PEN; // picking a color means you want to draw, not erase
      selectIn([penButton, eraseButton], penButton);
      selectIn(colorButtons, el);
    });
  }
  for (const el of widthButtons) {
    el.addEventListener('click', () => { width = Number(el.dataset.width); selectIn(widthButtons, el); });
  }
  undoButton.addEventListener('click', () => { undo(state); invalidate(); });
  redoButton.addEventListener('click', () => { redo(state); invalidate(); });
  clearButton.addEventListener('click', () => { clear(state); invalidate(); });

  function close() {
    document.removeEventListener('keydown', onKeydown);
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
    if (event.key === 'Escape') { event.preventDefault(); requestClose(); return; }
    if (!(event.ctrlKey || event.metaKey)) return;
    const key = String(event.key).toLowerCase();
    if (key === 'z' && !event.shiftKey) { event.preventDefault(); undo(state); invalidate(); }
    else if ((key === 'z' && event.shiftKey) || key === 'y') { event.preventDefault(); redo(state); invalidate(); }
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
      blob = await exportBlob(state.strokes, cssWidth, cssHeight, dpr);
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
  return { close, canvas, saveButton, dialog };
}
