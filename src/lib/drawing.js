// src/lib/drawing.js
// The sketchpad's model, kept free of the DOM the way src/lib/format.js is: a
// drawing is plain data, history is two stacks of snapshots, and `replay` paints
// items onto any 2D context. src/app/draw-panel.js owns the canvas and the
// pointer; this file owns what a drawing IS — so history, geometry, and the
// eraser are unit-testable without a real canvas.
//
// An item is one of:
//   { kind: 'stroke',  color, width, mode, points: [{x,y}] }   freehand + eraser
//   { kind: <shape>,   color, width, sides, x0, y0, x1, y1 }   drag-drawn shapes
//   { kind: 'image',   src, el, x, y, width, height }          a pasted photo
// `el` is the decoded HTMLImageElement. It is the one non-plain field, because
// canvas cannot draw bytes — only a decoded image.

export const PEN = 'pen';
export const HIGHLIGHT = 'highlight';
export const ERASE = 'erase';
export const LINE = 'line';
export const ARROW = 'arrow';
export const RECT = 'rect';
export const ROUND_RECT = 'round-rect';
export const ELLIPSE = 'ellipse';
export const SELECT = 'select';
export const IMAGE = 'image';

// Tools that are drawn by dragging a bounding box from an anchor.
export const SHAPE_TOOLS = [LINE, ARROW, RECT, ROUND_RECT, ELLIPSE];
export function isShapeTool(tool) { return SHAPE_TOOLS.includes(tool); }
// Freehand tools: they record points rather than a box.
export function isFreehandTool(tool) { return tool === PEN || tool === HIGHLIGHT || tool === ERASE; }

const ROUND_RECT_RADIUS = 22;
// Highlighter ink is translucent so text and photos read through it, and it
// multiplies so overlapping passes deepen the way a real marker does.
export const HIGHLIGHT_ALPHA = 0.32;

export function createSketch() {
  // `items` is replaced, never mutated in place, except for the points of the
  // stroke being drawn and the box of the item being transformed — neither of
  // which any snapshot in `past` can reach (see beginTransform).
  return { items: [], past: [], future: [], open: false, draft: null, transform: null };
}

function commit(state, next) {
  state.past.push(state.items);
  state.future.length = 0;
  state.items = next;
  return state;
}

// What the panel should paint: the committed items plus the shape being dragged
// out right now. The draft is deliberately outside history — an abandoned drag
// must not leave an undo step behind.
export function visibleItems(state) {
  return state.draft ? [...state.items, state.draft] : state.items;
}

/* ---------------------------------------------------------------- freehand */

// Begin a stroke at (x, y). Branching off an undo discards the abandoned future,
// the same rule every editor's history follows.
export function beginStroke(state, { x, y, color = '#202124', width = 4, mode = PEN } = {}) {
  commit(state, [...state.items, { kind: 'stroke', color, width, mode, points: [{ x, y }] }]);
  state.open = true;
  return state;
}

// Add a point to the stroke in progress. Ignored when no stroke is open, so a
// pointermove that arrives after pointerup cannot extend a finished stroke.
export function extendStroke(state, { x, y } = {}) {
  if (!state.open) return state;
  const stroke = state.items[state.items.length - 1];
  if (!stroke || stroke.kind !== 'stroke') return state;
  const last = stroke.points[stroke.points.length - 1];
  if (last && last.x === x && last.y === y) return state; // a still pointer emits repeats
  stroke.points.push({ x, y });
  return state;
}

// Shift while drawing freehand: collapse the stroke to a straight line from its
// anchor to the pointer, angle-snapped like the Line tool. Releasing Shift
// resumes freehand from that line's end.
export function straightenStroke(state, { x, y, constrain = false } = {}) {
  if (!state.open) return state;
  const stroke = state.items[state.items.length - 1];
  if (!stroke || stroke.kind !== 'stroke') return state;
  const anchor = stroke.points[0];
  const end = constrain ? snapAngle(anchor.x, anchor.y, x, y) : { x1: x, y1: y };
  stroke.points = [anchor, { x: end.x1, y: end.y1 }];
  return state;
}

export function endStroke(state) {
  state.open = false;
  return state;
}

/* ------------------------------------------------------------------ shapes */

// Shapes live in `state.draft` until the drag ends, so a click that produces a
// zero-size shape leaves neither an item nor an undo step.
export function beginShape(state, { tool, x, y, color = '#202124', width = 4 } = {}) {
  state.draft = { kind: tool, color, width, x0: x, y0: y, x1: x, y1: y };
  state.open = true;
  return state;
}

export function updateShape(state, { x, y, constrain = false } = {}) {
  const draft = state.draft;
  if (!draft) return state;
  // Line and arrow are directional, so Shift snaps their angle; the box tools
  // have no direction, so Shift makes them square instead.
  const directional = draft.kind === LINE || draft.kind === ARROW;
  const box = constrain
    ? (directional ? snapAngle(draft.x0, draft.y0, x, y) : squareBox(draft.x0, draft.y0, x, y))
    : { x1: x, y1: y };
  draft.x1 = box.x1;
  draft.y1 = box.y1;
  return state;
}

// Commit the draft, unless the drag never went anywhere (a stray click).
export function endShape(state) {
  const draft = state.draft;
  state.draft = null;
  state.open = false;
  if (!draft) return state;
  if (Math.abs(draft.x1 - draft.x0) < 2 && Math.abs(draft.y1 - draft.y0) < 2) return state;
  return commit(state, [...state.items, draft]);
}

/* ------------------------------------------------------------ constraints */

// Shift on a box tool: force equal width and height, keeping the drag's
// direction so the shape still grows toward the pointer.
export function squareBox(x0, y0, x1, y1) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const size = Math.max(Math.abs(dx), Math.abs(dy));
  return { x0, y0, x1: x0 + (dx < 0 ? -size : size), y1: y0 + (dy < 0 ? -size : size) };
}

// Shift on the Line tool: snap to the nearest 45°, preserving the drag length.
export function snapAngle(x0, y0, x1, y1) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const length = Math.hypot(dx, dy);
  const step = Math.PI / 4;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x0, y0, x1: x0 + length * Math.cos(angle), y1: y0 + length * Math.sin(angle) };
}

// Normalized bounding box of a shape item, since a drag may run right-to-left.
export function boxOf(item) {
  if (item.kind === IMAGE) return { x: item.x, y: item.y, width: item.width, height: item.height };
  return {
    x: Math.min(item.x0, item.x1),
    y: Math.min(item.y0, item.y1),
    width: Math.abs(item.x1 - item.x0),
    height: Math.abs(item.y1 - item.y0),
  };
}

/* ------------------------------------------------------------------ images */

export function addImage(state, { src, el, x, y, width, height }) {
  commit(state, [...state.items, { kind: IMAGE, src, el, x, y, width, height }]);
  return state.items.length - 1;
}

// Topmost image containing the point, or -1. Images are the only selectable
// item: their bounds are a rectangle, so hit-testing stays honest and cheap.
export function imageAt(state, x, y) {
  for (let i = state.items.length - 1; i >= 0; i--) {
    const item = state.items[i];
    if (item.kind !== IMAGE) continue;
    if (x >= item.x && x <= item.x + item.width && y >= item.y && y <= item.y + item.height) return i;
  }
  return -1;
}

// Take ONE history snapshot for a whole move/resize drag, then mutate a private
// clone. Without this, every pointermove would push an undo step.
export function beginTransform(state, index) {
  const item = state.items[index];
  if (!item) return state;
  const next = state.items.slice();
  next[index] = { ...item };
  commit(state, next);
  state.transform = index;
  return state;
}

export function applyTransform(state, box) {
  const index = state.transform;
  if (index == null) return state;
  const item = state.items[index];
  if (!item) return state;
  if (box.x != null) item.x = box.x;
  if (box.y != null) item.y = box.y;
  if (box.width != null) item.width = Math.max(8, box.width);
  if (box.height != null) item.height = Math.max(8, box.height);
  return state;
}

export function endTransform(state) {
  state.transform = null;
  return state;
}

export function removeItem(state, index) {
  if (index == null || !state.items[index]) return state;
  return commit(state, state.items.filter((_, i) => i !== index));
}

/* ----------------------------------------------------------------- history */

export function undo(state) {
  if (!state.past.length) return state;
  state.future.push(state.items);
  state.items = state.past.pop();
  return state;
}

export function redo(state) {
  if (!state.future.length) return state;
  state.past.push(state.items);
  state.items = state.future.pop();
  return state;
}

// Undoable in one step — that is the whole reason history stores snapshots
// rather than individual items.
export function clear(state) {
  return state.items.length ? commit(state, []) : state;
}

export function isEmpty(state) { return state.items.length === 0; }
export function canUndo(state) { return state.past.length > 0; }
export function canRedo(state) { return state.future.length > 0; }

/* ------------------------------------------------------------------ render */

function roundRectPath(ctx, x, y, w, h, radius) {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawStroke(ctx, item) {
  const points = item.points || [];
  if (!points.length) return;
  if (points.length === 1) {
    // Chrome renders nothing for a zero-length line, so a click's dot has to be
    // drawn as an explicit filled circle of the stroke's width.
    ctx.beginPath();
    ctx.fillStyle = item.color;
    ctx.arc(points[0].x, points[0].y, item.width / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.strokeStyle = item.color;
  ctx.lineWidth = item.width;
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.stroke();
}

// The two barbs of an arrowhead at (x1,y1), pointing back along the shaft. The
// head grows with the stroke but never outruns a short arrow, so a tiny drag
// still looks like an arrow rather than a blot.
export function arrowHead(x0, y0, x1, y1, width) {
  const angle = Math.atan2(y1 - y0, x1 - x0);
  const spread = Math.PI / 7;
  const length = Math.min(Math.hypot(x1 - x0, y1 - y0), 10 + width * 3);
  return [
    { x: x1 - length * Math.cos(angle - spread), y: y1 - length * Math.sin(angle - spread) },
    { x: x1 - length * Math.cos(angle + spread), y: y1 - length * Math.sin(angle + spread) },
  ];
}

function drawShape(ctx, item) {
  const { x, y, width: w, height: h } = boxOf(item);
  ctx.beginPath();
  ctx.strokeStyle = item.color;
  ctx.lineWidth = item.width;
  if (item.kind === LINE) {
    ctx.moveTo(item.x0, item.y0);
    ctx.lineTo(item.x1, item.y1);
  } else if (item.kind === ARROW) {
    ctx.moveTo(item.x0, item.y0);
    ctx.lineTo(item.x1, item.y1);
    for (const barb of arrowHead(item.x0, item.y0, item.x1, item.y1, item.width)) {
      ctx.moveTo(item.x1, item.y1);
      ctx.lineTo(barb.x, barb.y);
    }
  } else if (item.kind === RECT) {
    ctx.rect(x, y, w, h);
  } else if (item.kind === ROUND_RECT) {
    roundRectPath(ctx, x, y, w, h, ROUND_RECT_RADIUS);
  } else if (item.kind === ELLIPSE) {
    ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  }
  ctx.stroke();
}

// How an item's ink combines with what is already on the layer.
export function compositeFor(mode) {
  if (mode === ERASE) return 'destination-out'; // cut back to transparency
  if (mode === HIGHLIGHT) return 'multiply';    // deepen where passes overlap
  return 'source-over';
}

// Paint items onto a 2D context, in order. Eraser strokes composite with
// 'destination-out' so they cut back to transparency instead of painting a
// color — which is why the export flattens onto white on a SECOND canvas
// (see draw-panel.js): erasing directly over a white fill would punch holes
// straight through it.
//
// Selection handles are NOT drawn here: this is exactly what gets exported, and
// the panel paints its own chrome on top afterwards.
export function replay(ctx, items) {
  if (!ctx) return; // no 2D context (jsdom) — recording items still works
  for (const item of items || []) {
    if (!item) continue;
    // save/restore per item, so one highlighter stroke's alpha and flat cap
    // cannot leak onto whatever is drawn after it.
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalCompositeOperation = compositeFor(item.mode);
    if (item.mode === HIGHLIGHT) {
      ctx.globalAlpha = HIGHLIGHT_ALPHA;
      ctx.lineCap = 'butt'; // a real highlighter has a flat chisel tip
    }
    if (item.kind === IMAGE) {
      if (item.el) ctx.drawImage(item.el, item.x, item.y, item.width, item.height);
    } else if (item.kind === 'stroke') {
      drawStroke(ctx, item);
    } else {
      drawShape(ctx, item);
    }
    ctx.restore();
  }
}
