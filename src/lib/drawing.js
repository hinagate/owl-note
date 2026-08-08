// src/lib/drawing.js
// The sketchpad's model, kept free of the DOM the way src/lib/format.js is: a
// drawing is plain data, history is two stacks of snapshots, and `replay` paints
// items onto any 2D context. src/app/draw-panel.js owns the canvas and the
// pointer; this file owns what a drawing IS — so history, geometry, and the
// eraser are unit-testable without a real canvas.
//
// An item is one of:
//   { kind: 'stroke',  color, width, mode, points: [{x,y}] }   freehand + eraser
//   { kind: <shape>,   color, width, fill, x0, y0, x1, y1 }    drag-drawn shapes
//   { kind: 'image',   src, el, x, y, width, height }          a pasted photo
//   { kind: 'text',    text, color, size, x, y, width, height } a text box
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
export const TRIANGLE = 'triangle';
export const RIGHT_TRIANGLE = 'right-triangle';
export const DIAMOND = 'diamond';
export const PENTAGON = 'pentagon';
export const HEXAGON = 'hexagon';
export const STAR = 'star';
export const SELECT = 'select';
export const IMAGE = 'image';
export const TEXT = 'text';

// Every polygon is stored as vertices in a 0–1 box, so one path routine serves
// them all and a shape stretches with its bounding box like Paint's do. Regular
// polygons are generated rather than typed out, which keeps them exactly regular
// while still filling the box edge to edge.
function regularPolygon(sides, rotation = -Math.PI / 2) {
  const points = Array.from({ length: sides }, (_, i) => {
    const angle = rotation + (i * 2 * Math.PI) / sides;
    return [Math.cos(angle), Math.sin(angle)];
  });
  return normalizePolygon(points);
}

function starPolygon(points = 5, innerRatio = 0.382) { // 0.382 is the regular pentagram's waist
  const vertices = [];
  for (let i = 0; i < points * 2; i++) {
    const angle = -Math.PI / 2 + (i * Math.PI) / points;
    const radius = i % 2 === 0 ? 1 : innerRatio;
    vertices.push([Math.cos(angle) * radius, Math.sin(angle) * radius]);
  }
  return normalizePolygon(vertices);
}

// Rescale to exactly fill the unit box, so a pentagon dragged into a wide box
// spans it rather than floating in the middle of its circumscribed circle.
function normalizePolygon(points) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const minX = Math.min(...xs); const spanX = Math.max(...xs) - minX;
  const minY = Math.min(...ys); const spanY = Math.max(...ys) - minY;
  return points.map(([x, y]) => [spanX ? (x - minX) / spanX : 0.5, spanY ? (y - minY) / spanY : 0.5]);
}

export const POLYGONS = {
  [TRIANGLE]: [[0.5, 0], [1, 1], [0, 1]],
  [RIGHT_TRIANGLE]: [[0, 0], [0, 1], [1, 1]],
  [DIAMOND]: [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]],
  [PENTAGON]: regularPolygon(5),
  [HEXAGON]: regularPolygon(6),
  [STAR]: starPolygon(5),
};

// Tools that are drawn by dragging a bounding box from an anchor.
export const SHAPE_TOOLS = [
  LINE, ARROW, RECT, ROUND_RECT, ELLIPSE,
  TRIANGLE, RIGHT_TRIANGLE, DIAMOND, PENTAGON, HEXAGON, STAR,
];
export function isShapeTool(tool) { return SHAPE_TOOLS.includes(tool); }
// Freehand tools: they record points rather than a box.
export function isFreehandTool(tool) { return tool === PEN || tool === HIGHLIGHT || tool === ERASE; }
// Shapes that enclose an area, and so can be filled. A line and an arrow cannot.
export function isFillable(kind) { return isShapeTool(kind) && kind !== LINE && kind !== ARROW; }

const ROUND_RECT_RADIUS = 22;
// Matches the app's UI stack so a text box looks like the rest of the product.
export const TEXT_FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
export const LINE_HEIGHT = 1.25;
// Breathing room around a text box's fill, so the words are not flush to its edge.
export const TEXT_BG_PAD = 4;
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

// What to paint while an overlay editor is open over one of the items. The
// overlay IS that item's picture for as long as it is being edited, so painting
// the item underneath it too shows the same text twice — offset by the editor's
// border and metrics, which reads as a doubled or blurred layer.
//
// The draft is appended last, so item indices line up with state.items.
export function paintableItems(state, hiddenIndex = null) {
  const items = visibleItems(state);
  if (hiddenIndex == null) return items;
  return items.filter((_, i) => i !== hiddenIndex);
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
export function beginShape(state, { tool, x, y, color = '#202124', width = 4, fill = false } = {}) {
  state.draft = { kind: tool, color, width, fill: fill && isFillable(tool), x0: x, y0: y, x1: x, y1: y };
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

// Normalized bounding box of any item, since a drag may run right-to-left.
export function boxOf(item) {
  if (item.kind === IMAGE || item.kind === TEXT) {
    return { x: item.x, y: item.y, width: item.width, height: item.height };
  }
  if (item.kind === 'stroke') {
    const points = item.points || [];
    if (!points.length) return { x: 0, y: 0, width: 0, height: 0 };
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
  }
  return {
    x: Math.min(item.x0, item.x1),
    y: Math.min(item.y0, item.y1),
    width: Math.abs(item.x1 - item.x0),
    height: Math.abs(item.y1 - item.y0),
  };
}

/* ---------------------------------------------------------------- rotation */

// Rotation is stored as an angle on the item and applied at paint time about the
// box centre; the geometry underneath stays axis-aligned. That keeps move and
// resize working in the item's own frame — the alternative, baking the rotation
// into the coordinates, makes every later resize shear the shape.
export function centerOf(item) {
  const box = boxOf(item);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

export function rotatePoint(x, y, cx, cy, angle) {
  if (!angle) return { x, y };
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = x - cx;
  const dy = y - cy;
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
}

// Bring a page point into the item's unrotated frame, so every hit test and
// resize can keep working on a plain axis-aligned box.
export function toLocalPoint(item, x, y) {
  const c = centerOf(item);
  return rotatePoint(x, y, c.x, c.y, -(item.angle || 0));
}

export function setAngle(state, index, angle) {
  const item = state.items[index];
  if (!item) return state;
  item.angle = normalizeAngle(angle);
  return state;
}

export function normalizeAngle(angle) {
  const full = Math.PI * 2;
  const value = Number(angle) || 0;
  return ((value % full) + full) % full;
}

// Move/stretch an item into `box`. Each kind stores its geometry differently, so
// this is the single place that knows how to map one into a new frame — which is
// what lets Select work on anything rather than only on photos.
export function setBox(item, box) {
  const width = Math.max(1, box.width);
  const height = Math.max(1, box.height);
  if (item.kind === IMAGE || item.kind === TEXT) {
    item.x = box.x; item.y = box.y; item.width = width; item.height = height;
    return item;
  }
  if (item.kind === 'stroke') {
    // Scale the recorded points from their old frame into the new one. A stroke
    // drawn as a straight horizontal line has zero height, so guard the divide
    // and translate instead of stretching in that axis.
    const from = boxOf(item);
    const scaleX = from.width ? width / from.width : 1;
    const scaleY = from.height ? height / from.height : 1;
    item.points = (item.points || []).map((p) => ({
      x: box.x + (p.x - from.x) * scaleX,
      y: box.y + (p.y - from.y) * scaleY,
    }));
    return item;
  }
  // A shape keeps its drag direction, so an arrow still points where it pointed.
  const flipX = item.x1 < item.x0;
  const flipY = item.y1 < item.y0;
  item.x0 = flipX ? box.x + width : box.x;
  item.x1 = flipX ? box.x : box.x + width;
  item.y0 = flipY ? box.y + height : box.y;
  item.y1 = flipY ? box.y : box.y + height;
  return item;
}

/* ------------------------------------------------------------------ images */

export function addImage(state, { src, el, x, y, width, height }) {
  commit(state, [...state.items, { kind: IMAGE, src, el, x, y, width, height }]);
  return state.items.length - 1;
}

// Topmost item whose bounding box contains the point, or -1. Everything drawn is
// selectable — a photo you pasted, a shape, a pen stroke, a text box — because
// adjusting a photo usually means adjusting what was drawn over it too.
//
// Hit-testing is by bounding box, like Paint's rectangular select: honest about
// what the handles will actually move, and cheap. Eraser strokes are skipped:
// they are holes in the ink, and there is nothing meaningful to drag.
export function itemAt(state, x, y, pad = 0) {
  for (let i = state.items.length - 1; i >= 0; i--) {
    const item = state.items[i];
    if (item.mode === ERASE) continue;
    const box = boxOf(item);
    // Test in the item's own frame, so a rotated shape is grabbed where it looks
    // rather than where its unrotated box happens to sit.
    const local = toLocalPoint(item, x, y);
    // A thick stroke paints outside its point bounds by half its width, and a
    // hairline shape would otherwise be almost impossible to hit at all.
    //
    // Only for items whose `width` means LINE width. On an image or a text box
    // it is the box's own width, and treating it as ink gave a 260px-wide
    // caption a 130px grab halo on every side — enough to swallow clicks meant
    // for something else entirely.
    const inked = item.kind === 'stroke' || isShapeTool(item.kind);
    const slack = pad + (inked ? (item.width || 0) / 2 : 0);
    if (local.x >= box.x - slack && local.x <= box.x + box.width + slack
      && local.y >= box.y - slack && local.y <= box.y + box.height + slack) return i;
  }
  return -1;
}

// Kept as the photo-only lookup: pasting still selects the photo it just placed.
export function imageAt(state, x, y) {
  for (let i = state.items.length - 1; i >= 0; i--) {
    const item = state.items[i];
    if (item.kind !== IMAGE) continue;
    if (x >= item.x && x <= item.x + item.width && y >= item.y && y <= item.y + item.height) return i;
  }
  return -1;
}

/* -------------------------------------------------------------------- text */

// Paint's text toolbar, as data: the family plus the three toggles it offers.
// Kept on the item rather than on the tool so two boxes can differ.
export const TEXT_FONTS = [
  { id: 'sans', name: 'Sans', stack: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
  { id: 'serif', name: 'Serif', stack: 'Georgia, "Times New Roman", serif' },
  { id: 'mono', name: 'Mono', stack: 'ui-monospace, "Cascadia Mono", Consolas, monospace' },
  { id: 'hand', name: 'Handwriting', stack: '"Segoe Script", "Bradley Hand", cursive' },
];

export function fontStack(id) {
  return (TEXT_FONTS.find((f) => f.id === id) || TEXT_FONTS[0]).stack;
}

// The CSS shorthand a text item paints with — shared by the canvas and by the
// panel's overlay textarea, so what you type looks like what gets drawn.
export function textFontCss(item) {
  const size = item.size || 24;
  return `${item.italic ? 'italic ' : ''}${item.bold ? '700 ' : '400 '}${size}px ${fontStack(item.font)}`;
}

// A text box is committed empty and filled in by the panel's overlay editor, so
// `addText` returns the index the caller needs to address it while editing.
export function addText(state, {
  x, y, width, height, color = '#202124', size = 24, text = '',
  font = 'sans', bold = false, italic = false, underline = false, background = null,
}) {
  commit(state, [...state.items, {
    kind: TEXT, text, color, size, x, y, width, height, font, bold, italic, underline, background,
  }]);
  return state.items.length - 1;
}

// Restyle a text box in place while it is being edited. Returns the item so the
// panel can re-measure the overlay against the new font.
export function styleText(state, index, patch) {
  const item = state.items[index];
  if (!item || item.kind !== TEXT) return null;
  Object.assign(item, patch);
  return item;
}

// Replace a text box's content in place. Returns false when the text is blank,
// which is the panel's signal to drop the item rather than leave an empty box.
export function setText(state, index, text, height) {
  const item = state.items[index];
  if (!item || item.kind !== TEXT) return false;
  item.text = text;
  if (height != null) item.height = Math.max(1, height);
  return text.trim().length > 0;
}

// Greedy word wrap. `measure` is injected so the model stays free of a canvas —
// the panel passes ctx.measureText, tests pass a plain character count.
export function wrapText(text, maxWidth, measure) {
  const lines = [];
  for (const paragraph of String(text ?? '').split('\n')) {
    if (!paragraph) { lines.push(''); continue; }
    let line = '';
    for (const word of paragraph.split(/(\s+)/)) {
      if (!word) continue;
      const candidate = line + word;
      if (line && measure(candidate) > maxWidth) {
        lines.push(line.trimEnd());
        line = word.trimStart();
      } else {
        line = candidate;
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

// Take ONE history snapshot for a whole move/resize drag, then mutate a private
// clone. Without this, every pointermove would push an undo step.
export function beginTransform(state, index) {
  const item = state.items[index];
  if (!item) return state;
  const next = state.items.slice();
  // Clone the arrays a transform rewrites, or dragging would reach back through
  // the snapshot in `past` and corrupt the undo step we just took.
  next[index] = { ...item };
  if (item.points) next[index].points = item.points.map((p) => ({ ...p }));
  commit(state, next);
  state.transform = index;
  return state;
}

// `box` may be partial — a move supplies only x/y — so missing edges keep their
// current value rather than collapsing the item.
export function applyTransform(state, box) {
  const index = state.transform;
  if (index == null) return state;
  const item = state.items[index];
  if (!item) return state;
  const current = boxOf(item);
  setBox(item, {
    x: box.x != null ? box.x : current.x,
    y: box.y != null ? box.y : current.y,
    width: box.width != null ? Math.max(8, box.width) : current.width,
    height: box.height != null ? Math.max(8, box.height) : current.height,
  });
  return state;
}

export function endTransform(state) {
  state.transform = null;
  return state;
}

/* --------------------------------------------------------------- z-order */

// Paint order IS stacking order: `items` is drawn front-to-back by index, so
// moving an item within the array is what "bring to front" and "send to back"
// mean. Returns the item's NEW index so the caller can keep the selection on it
// — the alternative, leaving `selected` pointing at whatever slid into the old
// slot, silently reselects a different object.
export function bringToFront(state, index) {
  const item = state.items[index];
  if (!item || index === state.items.length - 1) return index; // already on top
  const next = state.items.filter((_, i) => i !== index);
  next.push(item);
  commit(state, next);
  return next.length - 1;
}

export function sendToBack(state, index) {
  const item = state.items[index];
  if (!item || index === 0) return index; // already at the back
  const next = state.items.filter((_, i) => i !== index);
  next.unshift(item);
  commit(state, next);
  return 0;
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

function polygonPath(ctx, points, x, y, w, h) {
  points.forEach(([px, py], i) => {
    const cx = x + px * w;
    const cy = y + py * h;
    if (i === 0) ctx.moveTo(cx, cy); else ctx.lineTo(cx, cy);
  });
  ctx.closePath();
}

function drawText(ctx, item) {
  if (!item.text) return;
  const size = item.size || 24;
  ctx.fillStyle = item.color;
  ctx.textBaseline = 'top';
  ctx.font = textFontCss(item);
  // Fall back to an estimate whenever the context cannot give a usable width.
  // Guarding on `typeof measureText === 'function'` alone was not enough: a
  // context that returns no metrics yields NaN, which then silently swallowed
  // the background plate and would have put NaN into fillRect.
  const measure = (s) => {
    const metric = typeof ctx.measureText === 'function' ? ctx.measureText(s)?.width : undefined;
    return Number.isFinite(metric) ? metric : String(s).length * size * 0.5;
  };
  const lines = wrapText(item.text, Math.max(1, item.width), measure);
  // A solid fill behind the words. Text dropped straight onto a photo or a map is
  // often unreadable whatever colour it is, and this is the fix people reach for.
  // Sized to the longest line rather than the box, so a short caption does not
  // paint a full-width slab across the picture.
  if (item.background) {
    const widest = lines.reduce((max, line) => Math.max(max, line ? measure(line) : 0), 0);
    if (widest > 0) {
      ctx.fillStyle = item.background;
      ctx.fillRect(
        item.x - TEXT_BG_PAD,
        item.y - TEXT_BG_PAD,
        widest + TEXT_BG_PAD * 2,
        lines.length * size * LINE_HEIGHT + TEXT_BG_PAD * 2,
      );
      ctx.fillStyle = item.color; // fillRect just took the fill for itself
    }
  }
  lines.forEach((line, i) => {
    const y = item.y + i * size * LINE_HEIGHT;
    ctx.fillText(line, item.x, y);
    // Canvas has no text-decoration, so an underline is a rule drawn under the
    // measured run — which is also why it has to follow the same wrapping.
    if (item.underline && line) {
      const width = measure(line);
      const offset = y + size * 1.08;
      ctx.fillRect(item.x, offset, width, Math.max(1, Math.round(size / 14)));
    }
  });
}

function drawShape(ctx, item) {
  const { x, y, width: w, height: h } = boxOf(item);
  ctx.beginPath();
  ctx.strokeStyle = item.color;
  ctx.lineWidth = item.width;
  const polygon = POLYGONS[item.kind];
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
  } else if (polygon) {
    polygonPath(ctx, polygon, x, y, w, h);
  }
  // Fill first so the outline sits on top and the shape keeps its full width;
  // filling after would paint over the inner half of the stroke.
  if (item.fill && isFillable(item.kind)) {
    ctx.fillStyle = item.color;
    ctx.fill();
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
    // Rotate about the item's centre, then draw it in its own unrotated frame.
    if (item.angle) {
      const c = centerOf(item);
      ctx.translate(c.x, c.y);
      ctx.rotate(item.angle);
      ctx.translate(-c.x, -c.y);
    }
    if (item.mode === HIGHLIGHT) {
      ctx.globalAlpha = HIGHLIGHT_ALPHA;
      ctx.lineCap = 'butt'; // a real highlighter has a flat chisel tip
    }
    if (item.kind === IMAGE) {
      if (item.el) ctx.drawImage(item.el, item.x, item.y, item.width, item.height);
    } else if (item.kind === TEXT) {
      drawText(ctx, item);
    } else if (item.kind === 'stroke') {
      drawStroke(ctx, item);
    } else {
      drawShape(ctx, item);
    }
    ctx.restore();
  }
}
