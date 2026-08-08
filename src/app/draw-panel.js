// src/app/draw-panel.js
// The sketchpad's view: a modal canvas over the app, following the dialog idiom
// in pdf-share-dialog.js (backdrop, aria-modal, Escape, focus restored on close).
// It owns pixels and pointer events only — what a drawing IS lives in
// src/lib/drawing.js, which keeps this file readable and the geometry testable
// without a real canvas.
import {
  createSketch, beginStroke, extendStroke, straightenStroke, endStroke,
  beginShape, updateShape, endShape,
  addImage, imageAt, itemAt, addText, setText, styleText, beginTransform, applyTransform, endTransform, removeItem,
  undo, redo, clear, isEmpty, canUndo, canRedo, replay, visibleItems, paintableItems, boxOf,
  isShapeTool, isFreehandTool, isFillable,
  centerOf, rotatePoint, toLocalPoint, setAngle, normalizeAngle, textFontCss, TEXT_FONTS,
  bringToFront, sendToBack,
  PEN, HIGHLIGHT, ERASE, SELECT, LINE, ARROW, RECT, ROUND_RECT, ELLIPSE,
  TRIANGLE, RIGHT_TRIANGLE, DIAMOND, PENTAGON, HEXAGON, STAR, TEXT,
  LINE_HEIGHT,
} from '../lib/drawing.js';

const TOOLS = [
  { id: SELECT, className: 'draw-tool-select', glyph: '↖', label: 'Select — move or resize anything you have drawn' },
  { id: PEN, className: 'draw-tool-pen', glyph: '✏️', label: 'Pen — hold Shift for a straight line' },
  { id: HIGHLIGHT, className: 'draw-tool-highlight', glyph: '🖍', label: 'Highlighter — hold Shift for a straight line' },
  { id: ERASE, className: 'draw-tool-erase', glyph: '◻️', label: 'Eraser' },
  { id: TEXT, className: 'draw-tool-text', glyph: 'A', label: 'Text — click the canvas, then type' },
  { id: LINE, className: 'draw-tool-line', glyph: '╱', label: 'Line — hold Shift to snap to 45°' },
  { id: ARROW, className: 'draw-tool-arrow', glyph: '↗', label: 'Arrow — hold Shift to snap to 45°' },
  { id: RECT, className: 'draw-tool-rect', glyph: '▭', label: 'Rectangle — hold Shift for a square' },
  { id: ROUND_RECT, className: 'draw-tool-round-rect', glyph: '▢', label: 'Rounded rectangle — hold Shift for a square' },
  { id: ELLIPSE, className: 'draw-tool-ellipse', glyph: '◯', label: 'Ellipse — hold Shift for a circle' },
  { id: TRIANGLE, className: 'draw-tool-triangle', glyph: '△', label: 'Triangle — hold Shift to keep it even' },
  { id: RIGHT_TRIANGLE, className: 'draw-tool-right-triangle', glyph: '◺', label: 'Right triangle — hold Shift to keep it even' },
  { id: DIAMOND, className: 'draw-tool-diamond', glyph: '◇', label: 'Diamond — hold Shift to keep it even' },
  { id: PENTAGON, className: 'draw-tool-pentagon', glyph: '⬠', label: 'Pentagon — hold Shift to keep it even' },
  { id: HEXAGON, className: 'draw-tool-hexagon', glyph: '⬡', label: 'Hexagon — hold Shift to keep it even' },
  { id: STAR, className: 'draw-tool-star', glyph: '☆', label: 'Star — hold Shift to keep it even' },
];

// Paint's two-row swatch grid, in its order: darks on top, tints below. A
// five-color strip is a note-taking accent set, not a drawing palette.
export const COLORS = [
  { value: '#000000', label: 'Black' },
  { value: '#7f7f7f', label: 'Grey 50%' },
  { value: '#880015', label: 'Dark red' },
  { value: '#ed1c24', label: 'Red' },
  { value: '#ff7f27', label: 'Orange' },
  { value: '#fff200', label: 'Yellow' },
  { value: '#22b14c', label: 'Green' },
  { value: '#00a2e8', label: 'Turquoise' },
  { value: '#3f48cc', label: 'Indigo' },
  { value: '#a349a4', label: 'Purple' },
  { value: '#ffffff', label: 'White' },
  { value: '#c3c3c3', label: 'Grey 25%' },
  { value: '#b97a57', label: 'Brown' },
  { value: '#ffaec9', label: 'Rose' },
  { value: '#ffc90e', label: 'Gold' },
  { value: '#efe4b0', label: 'Light yellow' },
  { value: '#b5e61d', label: 'Lime' },
  { value: '#99d9ea', label: 'Aqua' },
  { value: '#7092be', label: 'Blue grey' },
  { value: '#c8bfe7', label: 'Lavender' },
];
// The slider's bounds. Stroke and text are separate scales because 4px is a
// sensible pen and a useless font size.
export const MIN_WIDTH = 1;
export const MAX_WIDTH = 40;
// Paint's size list, which is what people actually reach for.
export const TEXT_SIZES = [8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 64, 72, 96];
const DEFAULT_TEXT_SIZE = 24;
// A compact preset row for the text controls. Ten covers the useful range in one
// line — an OS colour dialog is the wrong weight for a toolbar choice.
export const TEXT_PRESETS = [
  '#000000', '#7f7f7f', '#ffffff', '#ed1c24', '#ff7f27',
  '#fff200', '#22b14c', '#00a2e8', '#3f48cc', '#a349a4',
];
// A fresh text box is given room to type into before it is auto-sized on commit.
const TEXT_BOX_WIDTH = 260;
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

// How far above the box the rotate grip floats, in CSS pixels.
const ROTATE_OFFSET = 22;
// Shift while rotating snaps to this step, the way Shift constrains every other
// drag in this panel.
const ROTATE_SNAP = Math.PI / 12; // 15°

function rotateGripOf(box) {
  return { x: box.x + box.width / 2, y: box.y - ROTATE_OFFSET };
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
  let width = 4;
  let textSize = DEFAULT_TEXT_SIZE;
  // Sticky text styling: the next box you draw keeps the last one's look, the
  // way Paint's text toolbar does.
  const textStyle = { font: 'sans', bold: false, italic: false, underline: false, background: null };
  let textColor = '#000000';
  // Remembered while the fill is off, so toggling back on restores the choice.
  let textBgColor = '#ffffff';
  let fill = false;
  let selected = null;      // index into state.items
  let drag = null;          // { mode: 'draw' | 'move' | 'resize', ... }
  let shiftHeld = false;
  let cursor = null;        // last pointer position, for the brush-size ring
  let frame = 0;
  let editing = null;       // { index, textarea } while a text box is open

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
  // The highlighter's icon draws the swipe it would lay down, so it has to carry
  // the current ink the way the size dot does.
  const highlightButton = toolButtons.find((el) => el.dataset.tool === HIGHLIGHT);

  const colorDivider = document.createElement('span');
  colorDivider.className = 'draw-divider';
  tools.appendChild(colorDivider);
  // A 10 × 2 grid rather than a strip, so twenty swatches cost one row of
  // toolbar height instead of twenty slots.
  const palette = document.createElement('div');
  palette.className = 'draw-palette';
  palette.setAttribute('role', 'group');
  palette.setAttribute('aria-label', 'Colors');
  const colorButtons = COLORS.map((c, i) => {
    const el = button(`draw-color${i === 0 ? ' active' : ''}`, '', c.label);
    el.dataset.color = c.value;
    el.style.background = c.value;
    palette.appendChild(el);
    return el;
  });
  tools.appendChild(palette);

  // Paint's "Edit colors". A native color input is the whole picker for free,
  // and it is the only control here that can reach a color off the grid.
  const customWrap = document.createElement('label');
  customWrap.className = 'draw-custom-color';
  customWrap.title = 'Edit colors — pick any color';
  const customInput = document.createElement('input');
  customInput.type = 'color';
  customInput.value = COLORS[0].value;
  customInput.setAttribute('aria-label', 'Custom color');
  const customPlus = document.createElement('span');
  customPlus.className = 'draw-custom-plus';
  customPlus.textContent = '+';
  customWrap.append(customInput, customPlus);
  tools.appendChild(customWrap);

  // Fill sits with the shapes it applies to. Disabled for tools that enclose no
  // area, so the control never claims to do something it cannot.
  const fillButton = button('draw-fill', '', 'Fill shapes with the current color');
  fillButton.setAttribute('aria-pressed', 'false');
  const fillSwatch = document.createElement('span');
  fillSwatch.className = 'draw-fill-swatch';
  fillButton.appendChild(fillSwatch);
  tools.appendChild(fillButton);

  const widthDivider = document.createElement('span');
  widthDivider.className = 'draw-divider';
  tools.appendChild(widthDivider);

  // One slider, dragged rather than picked from three presets. It doubles as the
  // font-size control while the Text tool is active — same gesture, and it keeps
  // the toolbar from growing a second slider that is dead most of the time.
  const sizeWrap = document.createElement('label');
  sizeWrap.className = 'draw-size';
  const sizeDot = document.createElement('span');
  sizeDot.className = 'draw-width-dot';
  const sizeInput = document.createElement('input');
  sizeInput.type = 'range';
  sizeInput.className = 'draw-size-range';
  sizeInput.min = String(MIN_WIDTH);
  sizeInput.max = String(MAX_WIDTH);
  sizeInput.step = '1';
  sizeInput.value = String(width);
  sizeInput.setAttribute('aria-label', 'Stroke width');
  const sizeValue = document.createElement('span');
  sizeValue.className = 'draw-size-value';
  sizeWrap.append(sizeDot, sizeInput, sizeValue);
  tools.appendChild(sizeWrap);

  // The dot previews the real laid-down width, so the slider shows the size
  // rather than describing it. Capped so a fat brush cannot burst the toolbar.
  //
  // This slider is the STROKE width only. Text size lives next to the font in
  // the text bar, where Paint puts it — folding both onto one control meant the
  // font size was somewhere you would never think to look for it.
  function syncSize() {
    sizeInput.value = String(width);
    sizeInput.title = `Stroke width: ${width}px`;
    sizeValue.textContent = String(width);
    const preview = Math.min(22, effectiveWidth(tool, width));
    sizeDot.style.width = `${preview}px`;
    sizeDot.style.height = `${preview}px`;
    sizeDot.style.background = tool === ERASE ? '#9aa0a6' : color;
    highlightButton?.style.setProperty('--tool-ink', color);
    const hasSelection = selected != null && !!state.items[selected];
    frontButton.disabled = !hasSelection;
    backButton.disabled = !hasSelection;
    // Stroke width means nothing to a text box, so the control steps aside.
    sizeWrap.hidden = tool === TEXT;
  }

  // Paint shows a text toolbar only while the Text tool is live. Same here: it
  // is a second row that appears rather than five controls that sit dead.
  const textBar = document.createElement('div');
  textBar.className = 'draw-text-bar';
  textBar.hidden = true;
  const fontSelect = document.createElement('select');
  fontSelect.className = 'draw-font';
  fontSelect.title = 'Font';
  fontSelect.setAttribute('aria-label', 'Font');
  for (const font of TEXT_FONTS) {
    const option = document.createElement('option');
    option.value = font.id;
    option.textContent = font.name;
    option.style.fontFamily = font.stack;
    fontSelect.appendChild(option);
  }
  // Paint's size combo, next to the font where it belongs. Presets rather than a
  // free number: they are the sizes anyone actually picks, and there is nothing
  // to mistype.
  const textSizeSelect = document.createElement('select');
  textSizeSelect.className = 'draw-text-size';
  textSizeSelect.title = 'Text size';
  textSizeSelect.setAttribute('aria-label', 'Text size');
  for (const size of TEXT_SIZES) {
    const option = document.createElement('option');
    option.value = String(size);
    option.textContent = String(size);
    textSizeSelect.appendChild(option);
  }
  textSizeSelect.value = String(DEFAULT_TEXT_SIZE);
  // Text keeps its own colour, separate from the shape palette. Preset swatches
  // rather than an OS colour dialog: one click, and the choice is visible in the
  // toolbar instead of hidden behind a modal.
  function presetRow(className, label, presets, isActive, onPick) {
    const row = document.createElement('div');
    row.className = `draw-preset-row ${className}`;
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', label);
    const swatches = presets.map((preset) => {
      const value = preset === null ? null : preset;
      const el = button(`draw-preset${value === null ? ' draw-preset-none' : ''}`, '',
        value === null ? 'No fill' : value);
      if (value !== null) el.style.background = value;
      el.dataset.preset = value === null ? 'none' : value;
      el.addEventListener('mousedown', (event) => event.preventDefault()); // keep the caret
      el.addEventListener('click', () => onPick(value));
      row.appendChild(el);
      return el;
    });
    row.sync = () => {
      for (const el of swatches) {
        const value = el.dataset.preset === 'none' ? null : el.dataset.preset;
        el.classList.toggle('active', isActive(value));
      }
    };
    return row;
  }



  const textColorRow = presetRow(
    'draw-text-color-row', 'Text color', TEXT_PRESETS,
    (value) => value === textColor,
    (value) => {
      textColor = value;
      if (editing) {
        const item = styleText(state, editing.index, { color: value });
        if (item) applyEditorFont(item);
      }
      syncTextBar();
      invalidate();
      resumeEditing();
    },
  );

  // A leading "None" is what makes the fill removable at all — without it the
  // only way back from a fill applied by mistake is undo.
  const textBgRow = presetRow(
    'draw-text-bg-row', 'Fill behind text', [null, ...TEXT_PRESETS],
    (value) => value === textStyle.background,
    (value) => {
      if (value) textBgColor = value;
      applyTextStyle({ background: value });
      resumeEditing();
    },
  );

  const boldButton = button('draw-text-style draw-bold', 'B', 'Bold');
  const italicButton = button('draw-text-style draw-italic', 'I', 'Italic');
  const underlineButton = button('draw-text-style draw-underline', 'U', 'Underline');
  for (const el of [boldButton, italicButton, underlineButton]) el.setAttribute('aria-pressed', 'false');
  const textColorLabel = document.createElement('span');
  textColorLabel.className = 'draw-preset-label';
  textColorLabel.textContent = 'Text';
  const textBgLabel = document.createElement('span');
  textBgLabel.className = 'draw-preset-label';
  textBgLabel.textContent = 'Behind';
  textBar.append(
    fontSelect, textSizeSelect, boldButton, italicButton, underlineButton,
    textColorLabel, textColorRow, textBgLabel, textBgRow,
  );

  // Stacking order is what decides whether a caption sits over a photo or under
  // it, so it belongs to Select — these act on whatever is selected and are dead
  // otherwise, rather than being a mode of their own.
  const orderDivider = document.createElement('span');
  orderDivider.className = 'draw-divider';
  const frontButton = button('draw-order draw-front', '', 'Bring to front — put the selected object above the others');
  const backButton = button('draw-order draw-back', '', 'Send to back — put the selected object behind the others');
  tools.append(orderDivider, frontButton, backButton);

  const imageDivider = document.createElement('span');
  imageDivider.className = 'draw-divider';
  // Pasting worked before this button existed, but nothing on screen said so.
  const imageButton = button('draw-image', '🖼 Image', 'Add an image from a file (or paste one with Ctrl+V)');
  const imageInput = document.createElement('input');
  imageInput.type = 'file';
  imageInput.accept = 'image/*';
  imageInput.className = 'draw-image-input';
  imageInput.hidden = true;
  tools.append(imageDivider, imageButton, imageInput);

  const historyDivider = document.createElement('span');
  historyDivider.className = 'draw-divider';
  const undoButton = button('draw-undo', '↶', 'Undo (Ctrl+Z)');
  const redoButton = button('draw-redo', '↷', 'Redo (Ctrl+Shift+Z)');
  const clearButton = button('draw-clear', 'Clear', 'Clear the whole drawing');
  tools.append(historyDivider, undoButton, redoButton, clearButton);

  // The canvas and the text editor share a positioned wrapper: the overlay has
  // to sit exactly over the box it is editing, in canvas coordinates.
  const surface = document.createElement('div');
  surface.className = 'draw-surface';
  const canvas = document.createElement('canvas');
  canvas.className = 'draw-canvas';
  canvas.tabIndex = 0;
  canvas.setAttribute('aria-label', 'Drawing canvas');
  // A real textarea rather than canvas-drawn text: it brings the caret, IME,
  // selection and wrapping for free, and reports the height the committed box
  // should take so nothing has to be measured on the canvas.
  const textEditor = document.createElement('textarea');
  textEditor.className = 'draw-text-editor';
  textEditor.hidden = true;
  textEditor.setAttribute('aria-label', 'Text box');
  surface.append(canvas, textEditor);

  const hint = document.createElement('p');
  hint.className = 'draw-hint';
  hint.textContent = 'Hold Shift to constrain · Select (↖) moves and resizes anything · Delete removes it';

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

  dialog.append(header, tools, textBar, surface, hint, status, footer, confirmRow);
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
    // The chrome rotates with the item, so the handles stay on its real corners.
    const c = centerOf(item);
    if (item.angle) {
      ctx.translate(c.x, c.y);
      ctx.rotate(item.angle);
      ctx.translate(-c.x, -c.y);
    }
    ctx.setLineDash?.([4, 3]);
    ctx.strokeRect(box.x, box.y, box.width, box.height);
    // The stem out to the rotate grip, so it reads as attached rather than loose.
    ctx.beginPath();
    ctx.moveTo(box.x + box.width / 2, box.y);
    ctx.lineTo(box.x + box.width / 2, box.y - ROTATE_OFFSET);
    ctx.stroke();
    ctx.setLineDash?.([]);
    ctx.fillStyle = '#ffffff';
    for (const corner of cornersOf(box)) {
      ctx.fillRect(corner.x - HANDLE / 2, corner.y - HANDLE / 2, HANDLE, HANDLE);
      ctx.strokeRect(corner.x - HANDLE / 2, corner.y - HANDLE / 2, HANDLE, HANDLE);
    }
    const grip = rotateGripOf(box);
    ctx.beginPath();
    ctx.arc(grip.x, grip.y, HANDLE / 2 + 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
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
    // The box being edited is hidden here: its overlay is already showing it,
    // and painting both stacks the same text twice.
    replay(ctx, paintableItems(state, editing ? editing.index : null));
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
    canvas.classList.toggle('texting', tool === TEXT);
    const fillable = isFillable(tool);
    fillButton.disabled = !fillable;
    fillButton.classList.toggle('active', fill && fillable);
    fillButton.setAttribute('aria-pressed', String(fill && fillable));
    fillSwatch.style.background = fill && fillable ? color : 'transparent';
    fillSwatch.style.borderColor = color;
    syncSize();
    syncTextBar();
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

  // Handles are grabbed in the item's own frame — the same inverse rotation the
  // hit test uses — so they stay grabbable once a shape has been turned.
  function rotateGripAt(x, y) {
    const item = state.items[selected];
    if (!item) return false;
    const local = toLocalPoint(item, x, y);
    const grip = rotateGripOf(boxOf(item));
    return Math.abs(local.x - grip.x) <= HANDLE_GRAB && Math.abs(local.y - grip.y) <= HANDLE_GRAB;
  }

  function handleAt(x, y) {
    if (selected == null || !state.items[selected]) return null;
    const local = toLocalPoint(state.items[selected], x, y);
    ({ x, y } = local);
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
      if (selected != null && rotateGripAt(x, y)) {
        const item = state.items[selected];
        beginTransform(state, selected);
        const c = centerOf(item);
        drag = {
          mode: 'rotate',
          cx: c.x,
          cy: c.y,
          // Rotate relative to where the grip was grabbed, so the shape does not
          // jump to meet the pointer on the first move.
          grabbed: Math.atan2(y - c.y, x - c.x) - (item.angle || 0),
        };
        return;
      }
      const corner = handleAt(x, y);
      if (corner) {
        beginTransform(state, selected);
        drag = { mode: 'resize', corner, box: { ...boxOf(state.items[selected]) } };
        return;
      }
      const index = itemAt(state, x, y);
      if (index < 0) { selectItem(null); drag = null; return; }
      selectItem(index);
      beginTransform(state, index);
      const box = boxOf(state.items[index]);
      drag = { mode: 'move', offsetX: x - box.x, offsetY: y - box.y };
      return;
    }

    if (tool === TEXT) {
      // A click places the box; the overlay takes over from here, so there is no
      // canvas drag to track.
      drag = null;
      openTextBox(x, y);
      return;
    }

    selected = null;
    if (isFreehandTool(tool)) {
      beginStroke(state, { x, y, color, width: effectiveWidth(tool, width), mode: tool });
    } else if (isShapeTool(tool)) {
      beginShape(state, { tool, x, y, color, width, fill });
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
    } else if (drag.mode === 'rotate') {
      let angle = Math.atan2(y - drag.cy, x - drag.cx) - drag.grabbed;
      if (shiftHeld) angle = Math.round(angle / ROTATE_SNAP) * ROTATE_SNAP;
      setAngle(state, selected, angle);
    } else if (drag.mode === 'resize') {
      // Resize in the item's frame, so dragging a corner of a rotated shape
      // stretches along its own axes instead of the screen's.
      const local = toLocalPoint(state.items[selected], x, y);
      applyTransform(state, resizeBox(drag.box, drag.corner, local.x, local.y, shiftHeld));
    }
    invalidate();
  });

  function finishDrag(event) {
    // Release the capture FIRST, and whether or not a drag is under way. The
    // Text tool and a click on empty canvas both return from pointerdown without
    // setting `drag`, so gating the release on it left the canvas holding the
    // pointer for good — and a canvas with pointer capture swallows every later
    // click, including the one meant to put the caret in the text box it just
    // opened. That reads as the editor losing focus the moment you touch it.
    if (event?.pointerId != null && canvas.hasPointerCapture?.(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
    if (!drag) return;
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

  // Double-click a text box to edit it again, the way every canvas editor works.
  canvas.addEventListener('dblclick', (event) => {
    const { x, y } = pointAt(event);
    const index = itemAt(state, x, y);
    const item = state.items[index];
    if (!item || item.kind !== TEXT) return;
    event.preventDefault();
    setTool(TEXT);
    beginTransform(state, index); // editing is undoable as one step
    editing = { index, created: false };
    selected = null;
    textSize = item.size;
    placeEditor(item);
    invalidate();
  });

  /* ---------------------------------------------------------------- text */

  // Open the overlay over a text box. The textarea is styled to match exactly
  // what replay() will paint, so committing is not a visible jump.
  function placeEditor(item) {
    textEditor.hidden = false;
    textEditor.style.left = `${item.x}px`;
    textEditor.style.top = `${item.y}px`;
    textEditor.style.width = `${item.width}px`;
    textEditor.value = item.text || '';
    applyEditorFont(item);
    textEditor.focus();
    textEditor.select?.();
  }

  // The overlay wears exactly the font replay() will paint with, so bolding
  // while typing shows the real result rather than a preview of it.
  function applyEditorFont(item) {
    textEditor.style.font = textFontCss(item);
    textEditor.style.lineHeight = String(LINE_HEIGHT);
    textEditor.style.color = item.color;
    textEditor.style.textDecoration = item.underline ? 'underline' : 'none';
    // Wear the fill too, so typing over a photo looks like the result. Without
    // one the editor keeps its faint wash, which is what makes the caret
    // findable against a busy picture.
    textEditor.style.background = item.background || 'rgba(255, 255, 255, 0.72)';
    autoGrow();
  }

  function autoGrow() {
    textEditor.style.height = 'auto';
    const size = Number.parseFloat(textEditor.style.fontSize) || textSize;
    textEditor.style.height = `${Math.max(textEditor.scrollHeight || size * LINE_HEIGHT, size * LINE_HEIGHT)}px`;
  }

  // Restyle the box being typed into, or just remember the choice for the next
  // one — Paint's toolbar behaves the same way with no caret placed.
  function applyTextStyle(patch) {
    Object.assign(textStyle, patch);
    if (editing) {
      const item = styleText(state, editing.index, patch);
      if (item) applyEditorFont(item);
    }
    syncTextBar();
    invalidate();
  }

  function syncTextBar() {
    const active = tool === TEXT || !!editing;
    textBar.hidden = !active;
    fontSelect.value = textStyle.font;
    textSizeSelect.value = String(textSize);
    textColorRow.sync();
    textBgRow.sync();
    for (const [el, on] of [
      [boldButton, textStyle.bold], [italicButton, textStyle.italic], [underlineButton, textStyle.underline],
    ]) {
      el.classList.toggle('active', on);
      el.setAttribute('aria-pressed', String(on));
    }
  }

  // `input` fires while the OS picker is open, so the box being typed in
  // recolours live rather than only once the dialog is dismissed.


  fontSelect.addEventListener('change', () => { applyTextStyle({ font: fontSelect.value }); resumeEditing(); });
  // Size is deliberately NOT folded into `textStyle`: that object is spread over
  // every new box, and a stale size in it would silently outrank textSize.
  textSizeSelect.addEventListener('change', () => {
    const next = Number(textSizeSelect.value);
    if (!Number.isFinite(next)) return;
    textSize = next;
    if (editing) {
      const item = styleText(state, editing.index, { size: next });
      if (item) applyEditorFont(item);
    }
    invalidate();
    resumeEditing();
  });
  boldButton.addEventListener('click', () => { applyTextStyle({ bold: !textStyle.bold }); resumeEditing(); });
  italicButton.addEventListener('click', () => { applyTextStyle({ italic: !textStyle.italic }); resumeEditing(); });
  underlineButton.addEventListener('click', () => { applyTextStyle({ underline: !textStyle.underline }); resumeEditing(); });
  // The toolbar must not steal the caret out of the box being typed into.
  for (const el of [boldButton, italicButton, underlineButton]) {
    el.addEventListener('mousedown', (event) => event.preventDefault());
  }
  textEditor.addEventListener('input', autoGrow);

  function openTextBox(x, y) {
    commitTextBox();
    const width = Math.max(60, Math.min(TEXT_BOX_WIDTH, cssWidth - x - 8));
    const index = addText(state, {
      x, y, width, height: textSize * LINE_HEIGHT, ...textStyle, color: textColor, size: textSize,
    });
    editing = { index, created: true };
    selected = null;
    placeEditor(state.items[index]);
    invalidate();
  }

  // Commit whatever is in the overlay. A box left empty leaves nothing behind,
  // but HOW it is dropped depends on where it came from:
  //   * a box just created — rewind the insert, so Ctrl+Z never lands on a step
  //     that appears to do nothing;
  //   * an existing box the user emptied — that is a deletion they asked for, and
  //     it stays on the undo stack so Ctrl+Z brings the text back.
  function commitTextBox() {
    if (!editing) return;
    const { index, created } = editing;
    editing = null;
    textEditor.hidden = true;
    const kept = setText(state, index, textEditor.value, textEditor.scrollHeight || undefined);
    if (!kept) {
      if (created) {
        undo(state);
        state.future.length = 0; // and no phantom redo of the empty box
      } else {
        removeItem(state, index);
      }
    }
    textEditor.value = '';
    invalidate();
  }

  // Reaching for the text toolbar must not end the box being typed in. The
  // colour picker and both selects take focus when clicked, and committing on
  // that blur closed the box before the choice was even made — leaving the user
  // to dismiss the picker and click back into the canvas, by which point the
  // box was gone. B/I/U can preventDefault on mousedown to keep the caret, but
  // a <select> and a colour input cannot: that would stop them opening at all.
  let holdEditor = false;
  textBar.addEventListener('pointerdown', () => { holdEditor = true; });
  textBar.addEventListener('focusin', () => { holdEditor = true; });
  // Capture, so a click anywhere else clears the hold BEFORE the canvas handler
  // runs and decides what to do with the open box.
  const releaseHold = (event) => { if (!textBar.contains(event.target)) holdEditor = false; };
  document.addEventListener('pointerdown', releaseHold, true);

  // Hand the caret back once the control is finished with it, so typing simply
  // continues. `change` rather than `input`: the colour picker fires `input`
  // continuously while it is open, and refocusing then would fight the dialog.
  function resumeEditing() {
    holdEditor = false;
    if (editing) textEditor.focus();
  }

  textEditor.addEventListener('blur', () => { if (!holdEditor) commitTextBox(); });
  textEditor.addEventListener('keydown', (event) => {
    // Escape commits rather than discards: the text is the work, and Ctrl+Z is
    // right there if it was a mistake.
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); canvas.focus(); }
  });

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
    commitTextBox(); // switching tools finishes the text you were typing
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
      customInput.value = color;
      invalidate();
    });
  }

  // "Edit colors": anything off the grid. `input` fires while the OS picker is
  // open, so the swatch preview tracks the choice live.
  customInput.addEventListener('input', () => {
    color = customInput.value;
    for (const other of colorButtons) other.classList.remove('active');
    if (tool === ERASE || tool === SELECT) setTool(PEN);
    invalidate();
  });

  sizeInput.addEventListener('input', () => {
    const next = Number(sizeInput.value);
    if (!Number.isFinite(next)) return;
    width = next;
    invalidate();
  });

  fillButton.addEventListener('click', () => {
    fill = !fill;
    // Turning Fill on while holding a tool that cannot fill is a request to draw
    // a filled shape, so move to the nearest one rather than silently doing nothing.
    if (fill && !isFillable(tool)) setTool(RECT);
    invalidate();
  });

  imageButton.addEventListener('click', () => imageInput.click());
  imageInput.addEventListener('change', async () => {
    const file = imageInput.files?.[0];
    imageInput.value = ''; // so re-picking the same file fires change again
    if (file) await placeImageFile(file);
  });
  // The selection follows the item to its new slot; dropping it here would leave
  // the handles sitting on whichever object slid into the vacated index.
  function reorder(move) {
    if (selected == null || !state.items[selected]) return;
    commitTextBox();
    selected = move(state, selected);
    invalidate();
  }
  frontButton.addEventListener('click', () => reorder(bringToFront));
  backButton.addEventListener('click', () => reorder(sendToBack));

  undoButton.addEventListener('click', () => { selected = null; undo(state); invalidate(); });
  redoButton.addEventListener('click', () => { selected = null; redo(state); invalidate(); });
  clearButton.addEventListener('click', () => { selected = null; clear(state); invalidate(); });

  function close() {
    editing = null; // teardown, not a commit: the panel is going away
    document.removeEventListener('keydown', onKeydown);
    document.removeEventListener('paste', onPaste);
    document.removeEventListener('pointerdown', releaseHold, true);
    if (frame) cancelRaf(frame);
    backdrop.remove();
    previouslyFocused?.focus?.();
  }

  // One route for every dismissal — ×, Cancel, Escape, backdrop click — so real
  // work can never vanish to a stray keypress. An inline row, not window.confirm:
  // a blocking browser modal is out of place inside an extension page.
  function requestClose() {
    commitTextBox(); // so "is there work here?" counts what was just typed
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
    // While a text box is open the textarea owns the keyboard: Backspace must
    // delete a character, not the box, and Ctrl+Z must undo typing, not strokes.
    if (editing) return;
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
    commitTextBox(); // never export a half-typed box
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
  return { close, canvas, saveButton, dialog, placeImageFile, state, textEditor, sizeInput };
}
