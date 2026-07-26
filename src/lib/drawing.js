// src/lib/drawing.js
// The sketchpad's model, kept free of the DOM the way src/lib/format.js is: a
// drawing is plain data, history is two stacks of snapshots, and `replay` paints
// strokes onto any 2D context. src/app/draw-panel.js owns the canvas and the
// pointer; this file owns what a drawing IS — so undo, redo, and the eraser are
// unit-testable without a real canvas.

export const PEN = 'pen';
export const ERASE = 'erase';

export function createSketch() {
  // `strokes` is replaced, never mutated in place, except for the points of the
  // stroke currently being drawn — which no snapshot in `past` can reach.
  return { strokes: [], past: [], future: [], open: false };
}

function commit(state, next) {
  state.past.push(state.strokes);
  state.future.length = 0;
  state.strokes = next;
  return state;
}

// Begin a stroke at (x, y). Branching off an undo discards the abandoned future,
// the same rule every editor's history follows.
export function beginStroke(state, { x, y, color = '#202124', width = 4, mode = PEN } = {}) {
  commit(state, [...state.strokes, { color, width, mode, points: [{ x, y }] }]);
  state.open = true;
  return state;
}

// Add a point to the stroke in progress. Ignored when no stroke is open, so a
// pointermove that arrives after pointerup cannot extend a finished stroke.
export function extendStroke(state, { x, y } = {}) {
  if (!state.open) return state;
  const stroke = state.strokes[state.strokes.length - 1];
  if (!stroke) return state;
  const last = stroke.points[stroke.points.length - 1];
  if (last && last.x === x && last.y === y) return state; // a still pointer emits repeats
  stroke.points.push({ x, y });
  return state;
}

export function endStroke(state) {
  state.open = false;
  return state;
}

export function undo(state) {
  if (!state.past.length) return state;
  state.future.push(state.strokes);
  state.strokes = state.past.pop();
  return state;
}

export function redo(state) {
  if (!state.future.length) return state;
  state.past.push(state.strokes);
  state.strokes = state.future.pop();
  return state;
}

// Undoable in one step — that is the whole reason history stores snapshots
// rather than individual strokes.
export function clear(state) {
  return state.strokes.length ? commit(state, []) : state;
}

export function isEmpty(state) { return state.strokes.length === 0; }
export function canUndo(state) { return state.past.length > 0; }
export function canRedo(state) { return state.future.length > 0; }

// Paint strokes onto a 2D context, in order. Eraser strokes composite with
// 'destination-out' so they cut back to transparency instead of painting a
// color — which is why the export flattens onto white on a SECOND canvas
// (see draw-panel.js): erasing directly over a white fill would punch holes
// straight through it.
export function replay(ctx, strokes) {
  if (!ctx) return; // no 2D context (jsdom) — recording strokes still works
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const stroke of strokes || []) {
    const points = stroke && stroke.points;
    if (!points || !points.length) continue;
    ctx.globalCompositeOperation = stroke.mode === ERASE ? 'destination-out' : 'source-over';
    if (points.length === 1) {
      // Chrome renders nothing for a zero-length line, so a click's dot has to
      // be drawn as an explicit filled circle of the stroke's width.
      ctx.beginPath();
      ctx.fillStyle = stroke.color;
      ctx.arc(points[0].x, points[0].y, stroke.width / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.beginPath();
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.width;
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.stroke();
  }
  ctx.restore();
}
