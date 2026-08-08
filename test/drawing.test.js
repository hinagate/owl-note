import { describe, it, expect } from 'vitest';
import {
  createSketch, beginStroke, extendStroke, straightenStroke, endStroke,
  beginShape, updateShape, endShape, visibleItems,
  addImage, imageAt, beginTransform, applyTransform, endTransform, removeItem,
  squareBox, snapAngle, arrowHead, compositeFor, boxOf, isShapeTool, isFreehandTool,
  undo, redo, clear, isEmpty, canUndo, canRedo, replay,
  itemAt, addText, setText, wrapText, isFillable, POLYGONS,
  PEN, HIGHLIGHT, ERASE, LINE, ARROW, RECT, ROUND_RECT, ELLIPSE, IMAGE,
} from '../src/lib/drawing.js';

function stroke(state, points, opts = {}) {
  beginStroke(state, { x: points[0][0], y: points[0][1], ...opts });
  for (const [x, y] of points.slice(1)) extendStroke(state, { x, y });
  return endStroke(state);
}

// Records every call and property set, so replay can be asserted without a real canvas.
function fakeCtx() {
  const calls = [];
  const props = {};
  return new Proxy({}, {
    get(_, key) {
      if (key === 'calls') return calls;
      if (key === 'props') return props;
      return (...args) => calls.push([key, ...args]);
    },
    set(_, key, value) {
      calls.push([`set:${key}`, value]);
      props[key] = value;
      return true;
    },
  });
}

describe('drawing model', () => {
  it('starts empty', () => {
    const s = createSketch();
    expect(isEmpty(s)).toBe(true);
    expect(canUndo(s)).toBe(false);
    expect(canRedo(s)).toBe(false);
  });

  it('records a stroke with its points and style', () => {
    const s = createSketch();
    stroke(s, [[1, 2], [3, 4]], { color: '#d93025', width: 8, mode: PEN });
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ color: '#d93025', width: 8, mode: PEN });
    expect(s.items[0].points).toEqual([{ x: 1, y: 2 }, { x: 3, y: 4 }]);
    expect(isEmpty(s)).toBe(false);
  });

  it('keeps a single-point stroke, so a click leaves a dot', () => {
    const s = createSketch();
    stroke(s, [[5, 5]]);
    expect(s.items[0].points).toHaveLength(1);
  });

  it('ignores duplicate samples and points after the stroke ends', () => {
    const s = createSketch();
    beginStroke(s, { x: 0, y: 0 });
    extendStroke(s, { x: 0, y: 0 });
    extendStroke(s, { x: 1, y: 1 });
    endStroke(s);
    extendStroke(s, { x: 9, y: 9 });
    expect(s.items[0].points).toEqual([{ x: 0, y: 0 }, { x: 1, y: 1 }]);
  });

  it('undoes and redoes one stroke at a time', () => {
    const s = createSketch();
    stroke(s, [[0, 0]]);
    stroke(s, [[1, 1]]);
    undo(s);
    expect(s.items).toHaveLength(1);
    redo(s);
    expect(s.items).toHaveLength(2);
  });

  it('undo and redo are no-ops at the ends of history', () => {
    const s = createSketch();
    expect(undo(s).items).toHaveLength(0);
    stroke(s, [[0, 0]]);
    expect(redo(s).items).toHaveLength(1);
  });

  it('discards the redo stack when a new stroke branches off an undo', () => {
    const s = createSketch();
    stroke(s, [[0, 0]]);
    undo(s);
    stroke(s, [[2, 2]]);
    expect(canRedo(s)).toBe(false);
    expect(s.items).toHaveLength(1);
    expect(s.items[0].points[0]).toEqual({ x: 2, y: 2 });
  });

  it('restores everything cleared in a single undo', () => {
    const s = createSketch();
    stroke(s, [[0, 0]]);
    stroke(s, [[1, 1]]);
    clear(s);
    expect(isEmpty(s)).toBe(true);
    undo(s);
    expect(s.items).toHaveLength(2);
  });

  it('does not record history for clearing an empty sketch', () => {
    const s = createSketch();
    clear(s);
    expect(canUndo(s)).toBe(false);
  });

  it('replays a multi-point stroke as a path', () => {
    const ctx = fakeCtx();
    const s = createSketch();
    stroke(s, [[0, 0], [10, 10]], { color: '#1a73e8', width: 4 });
    replay(ctx, visibleItems(s));
    const names = ctx.calls.map((c) => c[0]);
    expect(names).toContain('beginPath');
    expect(ctx.calls).toContainEqual(['moveTo', 0, 0]);
    expect(ctx.calls).toContainEqual(['lineTo', 10, 10]);
    expect(names).toContain('stroke');
    expect(ctx.props.strokeStyle).toBe('#1a73e8');
    expect(ctx.props.lineWidth).toBe(4);
    expect(ctx.props.lineCap).toBe('round');
  });

  it('replays a single-point stroke as a filled dot', () => {
    const ctx = fakeCtx();
    const s = createSketch();
    stroke(s, [[7, 8]], { width: 6 });
    replay(ctx, visibleItems(s));
    expect(ctx.calls).toContainEqual(['arc', 7, 8, 3, 0, Math.PI * 2]);
    expect(ctx.calls.map((c) => c[0])).toContain('fill');
  });

  it('composites eraser strokes with destination-out', () => {
    const ctx = fakeCtx();
    const s = createSketch();
    stroke(s, [[0, 0], [5, 5]], { mode: ERASE });
    replay(ctx, visibleItems(s));
    expect(ctx.calls).toContainEqual(['set:globalCompositeOperation', 'destination-out']);
  });

  it('replay tolerates a missing context', () => {
    const s = createSketch();
    stroke(s, [[0, 0], [1, 1]]);
    expect(() => replay(null, s.items)).not.toThrow();
  });
});

function shape(state, tool, [x0, y0], [x1, y1], opts = {}) {
  beginShape(state, { tool, x: x0, y: y0, ...opts });
  updateShape(state, { x: x1, y: y1, constrain: opts.constrain });
  return endShape(state);
}

describe('shape tools', () => {
  it('recognises exactly the drag-drawn tools', () => {
    for (const t of [LINE, ARROW, RECT, ROUND_RECT, ELLIPSE]) expect(isShapeTool(t)).toBe(true);
    for (const t of [PEN, HIGHLIGHT, ERASE, 'select']) expect(isShapeTool(t)).toBe(false);
    for (const t of [PEN, HIGHLIGHT, ERASE]) expect(isFreehandTool(t)).toBe(true);
    for (const t of [LINE, ARROW, RECT, 'select']) expect(isFreehandTool(t)).toBe(false);
  });

  it('keeps a dragged shape out of history until the drag ends', () => {
    const s = createSketch();
    beginShape(s, { tool: RECT, x: 0, y: 0 });
    updateShape(s, { x: 40, y: 30 });
    expect(s.items).toHaveLength(0);          // nothing committed yet
    expect(visibleItems(s)).toHaveLength(1);  // but it is on screen
    endShape(s);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ kind: RECT, x0: 0, y0: 0, x1: 40, y1: 30 });
  });

  it('drops a click that never became a shape, leaving no undo step', () => {
    const s = createSketch();
    shape(s, ELLIPSE, [10, 10], [11, 10]); // under the 2px threshold
    expect(s.items).toHaveLength(0);
    expect(canUndo(s)).toBe(false);
    expect(visibleItems(s)).toHaveLength(0); // draft cleared too
  });

  it('undoes a finished shape in one step', () => {
    const s = createSketch();
    shape(s, LINE, [0, 0], [50, 50]);
    expect(s.items).toHaveLength(1);
    undo(s);
    expect(s.items).toHaveLength(0);
  });

  it('normalises a right-to-left drag into a positive box', () => {
    const s = createSketch();
    shape(s, RECT, [80, 60], [20, 10]);
    expect(boxOf(s.items[0])).toEqual({ x: 20, y: 10, width: 60, height: 50 });
  });

  it('draws each shape kind with its own canvas path', () => {
    const cases = [
      [LINE, 'lineTo'],
      [RECT, 'rect'],
      [ROUND_RECT, 'arcTo'],
      [ELLIPSE, 'ellipse'],
      [ARROW, 'lineTo'],
    ];
    for (const [tool, expectedCall] of cases) {
      const s = createSketch();
      shape(s, tool, [0, 0], [40, 40]);
      const ctx = fakeCtx();
      replay(ctx, s.items);
      expect(ctx.calls.map((c) => c[0])).toContain(expectedCall);
    }
  });
});

describe('shift constraints', () => {
  it('squares a box, keeping the drag direction', () => {
    expect(squareBox(0, 0, 40, 10)).toEqual({ x0: 0, y0: 0, x1: 40, y1: 40 });
    expect(squareBox(0, 0, -40, 10)).toEqual({ x0: 0, y0: 0, x1: -40, y1: 40 });
    expect(squareBox(0, 0, 5, -50)).toEqual({ x0: 0, y0: 0, x1: 50, y1: -50 });
  });

  it('snaps a line to the nearest 45 degrees at the drag length', () => {
    const flat = snapAngle(0, 0, 100, 8); // nearly horizontal
    expect(flat.x1).toBeCloseTo(Math.hypot(100, 8), 5);
    expect(flat.y1).toBeCloseTo(0, 5);

    const diagonal = snapAngle(0, 0, 50, 44); // nearly 45°
    expect(diagonal.x1).toBeCloseTo(diagonal.y1, 5);
  });

  it('applies the square constraint to a box tool but the angle snap to a line', () => {
    const box = createSketch();
    shape(box, RECT, [0, 0], [60, 12], { constrain: true });
    expect(boxOf(box.items[0])).toMatchObject({ width: 60, height: 60 });

    const line = createSketch();
    shape(line, LINE, [0, 0], [60, 4], { constrain: true });
    expect(line.items[0].y1).toBeCloseTo(0, 5);
  });

  it('collapses a freehand stroke to a straight line while Shift is held', () => {
    const s = createSketch();
    beginStroke(s, { x: 0, y: 0 });
    extendStroke(s, { x: 5, y: 30 });
    extendStroke(s, { x: 9, y: 44 });
    expect(s.items[0].points).toHaveLength(3);
    straightenStroke(s, { x: 80, y: 6, constrain: true });
    const points = s.items[0].points;
    expect(points).toHaveLength(2);
    expect(points[0]).toEqual({ x: 0, y: 0 });
    expect(points[1].y).toBeCloseTo(0, 5); // snapped to horizontal
  });

  it('snaps an arrow like a line, since both are directional', () => {
    const s = createSketch();
    shape(s, ARROW, [0, 0], [70, 6], { constrain: true });
    expect(s.items[0].y1).toBeCloseTo(0, 5);
  });
});

describe('arrow and highlighter', () => {
  it('puts two barbs behind the arrow tip, angled back along the shaft', () => {
    const barbs = arrowHead(0, 0, 100, 0, 4);
    expect(barbs).toHaveLength(2);
    for (const barb of barbs) expect(barb.x).toBeLessThan(100); // behind the tip
    expect(barbs[0].y).toBeCloseTo(-barbs[1].y, 5);             // symmetric
  });

  it('never lets the arrowhead outgrow a short arrow', () => {
    const short = arrowHead(0, 0, 6, 0, 8);
    for (const barb of short) expect(barb.x).toBeGreaterThanOrEqual(-0.001);
  });

  it('draws the arrow shaft plus its head in one path', () => {
    const s = createSketch();
    shape(s, ARROW, [0, 0], [60, 0]);
    const ctx = fakeCtx();
    replay(ctx, s.items);
    const lineTos = ctx.calls.filter((c) => c[0] === 'lineTo');
    expect(lineTos).toHaveLength(3); // shaft + two barbs
  });

  it('picks a compositing mode per ink type', () => {
    expect(compositeFor(ERASE)).toBe('destination-out');
    expect(compositeFor(HIGHLIGHT)).toBe('multiply');
    expect(compositeFor(PEN)).toBe('source-over');
  });

  it('draws highlighter ink translucent, multiplied, with a flat tip', () => {
    const ctx = fakeCtx();
    const s = createSketch();
    stroke(s, [[0, 0], [50, 0]], { mode: HIGHLIGHT });
    replay(ctx, s.items);
    expect(ctx.calls).toContainEqual(['set:globalCompositeOperation', 'multiply']);
    expect(ctx.props.globalAlpha).toBeLessThan(1);
    expect(ctx.props.lineCap).toBe('butt');
  });

  it('does not leak highlighter alpha or cap onto the next stroke', () => {
    const s = createSketch();
    stroke(s, [[0, 0], [10, 0]], { mode: HIGHLIGHT });
    stroke(s, [[0, 10], [10, 10]], { mode: PEN });
    const ctx = fakeCtx();
    replay(ctx, s.items);
    // Every item is wrapped in its own save/restore, so state cannot carry over.
    const saves = ctx.calls.filter((c) => c[0] === 'save').length;
    const restores = ctx.calls.filter((c) => c[0] === 'restore').length;
    expect(saves).toBe(2);
    expect(restores).toBe(2);
  });
});

describe('pasted images', () => {
  const fakeImg = { width: 100, height: 50 };

  function withImage() {
    const s = createSketch();
    const index = addImage(s, { src: 'data:image/png;base64,AA', el: fakeImg, x: 10, y: 20, width: 100, height: 50 });
    return { s, index };
  }

  it('adds an image as an item and reports its index', () => {
    const { s, index } = withImage();
    expect(index).toBe(0);
    expect(s.items[0]).toMatchObject({ kind: IMAGE, x: 10, y: 20, width: 100, height: 50 });
    expect(isEmpty(s)).toBe(false);
  });

  it('hit-tests only inside the image, topmost first', () => {
    const { s } = withImage();
    expect(imageAt(s, 50, 40)).toBe(0);
    expect(imageAt(s, 5, 40)).toBe(-1);   // left of it
    expect(imageAt(s, 50, 200)).toBe(-1); // below it
    addImage(s, { src: 'x', el: fakeImg, x: 0, y: 0, width: 200, height: 200 });
    expect(imageAt(s, 50, 40)).toBe(1);   // the newer image wins
  });

  it('takes one history step for a whole move, and undo restores the original box', () => {
    const { s, index } = withImage();
    const before = s.past.length;
    beginTransform(s, index);
    applyTransform(s, { x: 60, y: 70 });
    applyTransform(s, { x: 90, y: 95 });
    endTransform(s);
    expect(s.past.length).toBe(before + 1); // ONE step, not one per move
    expect(s.items[0]).toMatchObject({ x: 90, y: 95 });
    undo(s);
    expect(s.items[0]).toMatchObject({ x: 10, y: 20 });
  });

  it('resizes without letting an image collapse to nothing', () => {
    const { s, index } = withImage();
    beginTransform(s, index);
    applyTransform(s, { width: 1, height: 1 });
    expect(s.items[0].width).toBeGreaterThanOrEqual(8);
    expect(s.items[0].height).toBeGreaterThanOrEqual(8);
  });

  it('ignores a transform when nothing is being transformed', () => {
    const { s } = withImage();
    applyTransform(s, { x: 999 });
    expect(s.items[0].x).toBe(10);
  });

  it('removes a selected image, undoably', () => {
    const { s, index } = withImage();
    removeItem(s, index);
    expect(s.items).toHaveLength(0);
    undo(s);
    expect(s.items).toHaveLength(1);
  });

  it('draws the image at its box', () => {
    const { s } = withImage();
    const ctx = fakeCtx();
    replay(ctx, s.items);
    expect(ctx.calls).toContainEqual(['drawImage', fakeImg, 10, 20, 100, 50]);
  });

  it('skips an image whose bytes never decoded', () => {
    const s = createSketch();
    addImage(s, { src: 'broken', el: null, x: 0, y: 0, width: 10, height: 10 });
    const ctx = fakeCtx();
    expect(() => replay(ctx, s.items)).not.toThrow();
    expect(ctx.calls.map((c) => c[0])).not.toContain('drawImage');
  });
});

describe('Paint-style shapes', () => {
  it('offers the basic shape set beyond line and arrow', () => {
    for (const kind of ['triangle', 'right-triangle', 'diamond', 'pentagon', 'hexagon', 'star']) {
      expect(isShapeTool(kind)).toBe(true);
    }
  });

  it('normalizes every polygon to fill its box edge to edge', () => {
    for (const [kind, points] of Object.entries(POLYGONS)) {
      const xs = points.map((p) => p[0]);
      const ys = points.map((p) => p[1]);
      expect(Math.min(...xs), kind).toBeCloseTo(0, 6);
      expect(Math.max(...xs), kind).toBeCloseTo(1, 6);
      expect(Math.min(...ys), kind).toBeCloseTo(0, 6);
      expect(Math.max(...ys), kind).toBeCloseTo(1, 6);
    }
  });

  it('gives the star ten alternating vertices and the polygons their side count', () => {
    expect(POLYGONS.star).toHaveLength(10);
    expect(POLYGONS.pentagon).toHaveLength(5);
    expect(POLYGONS.hexagon).toHaveLength(6);
  });

  // Fill is meaningless without an enclosed area, and the toolbar disables it
  // for those tools rather than letting the flag lie.
  it('only lets enclosing shapes be filled', () => {
    expect(isFillable('rect')).toBe(true);
    expect(isFillable('star')).toBe(true);
    expect(isFillable('line')).toBe(false);
    expect(isFillable('arrow')).toBe(false);
    expect(isFillable('pen')).toBe(false);
  });

  it('records the fill flag on the shape it belongs to, never on a line', () => {
    const filled = createSketch();
    beginShape(filled, { tool: 'ellipse', x: 0, y: 0, fill: true });
    expect(filled.draft.fill).toBe(true);

    const line = createSketch();
    beginShape(line, { tool: 'line', x: 0, y: 0, fill: true });
    expect(line.draft.fill).toBe(false);
  });
});

describe('selecting and transforming any item', () => {
  function sketchWith(item) {
    const state = createSketch();
    state.items = [item];
    return state;
  }

  it('hit-tests shapes and strokes, not just photos', () => {
    const shape = sketchWith({ kind: 'rect', color: '#000', width: 4, x0: 10, y0: 10, x1: 60, y1: 40 });
    expect(itemAt(shape, 30, 20)).toBe(0);
    expect(itemAt(shape, 200, 200)).toBe(-1);

    const stroke = sketchWith({ kind: 'stroke', color: '#000', width: 4, points: [{ x: 5, y: 5 }, { x: 25, y: 30 }] });
    expect(itemAt(stroke, 15, 20)).toBe(0);
  });

  it('picks the topmost item when they overlap', () => {
    const state = createSketch();
    state.items = [
      { kind: 'rect', width: 2, x0: 0, y0: 0, x1: 100, y1: 100 },
      { kind: 'rect', width: 2, x0: 10, y0: 10, x1: 50, y1: 50 },
    ];
    expect(itemAt(state, 20, 20)).toBe(1);
  });

  it('ignores eraser strokes, which are holes rather than objects', () => {
    const state = sketchWith({ kind: 'stroke', mode: 'erase', width: 10, points: [{ x: 5, y: 5 }, { x: 20, y: 20 }] });
    expect(itemAt(state, 10, 10)).toBe(-1);
  });

  it('moves a shape without flipping the direction it was drawn in', () => {
    const state = sketchWith({ kind: 'arrow', width: 4, x0: 80, y0: 80, x1: 20, y1: 20 }); // drawn right-to-left
    beginTransform(state, 0);
    applyTransform(state, { x: 100, y: 100 });
    const item = state.items[0];
    expect(boxOf(item)).toMatchObject({ x: 100, y: 100, width: 60, height: 60 });
    expect(item.x0).toBeGreaterThan(item.x1); // still points the same way
  });

  it('scales a stroke’s points into the new box', () => {
    const state = sketchWith({ kind: 'stroke', width: 2, points: [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 0 }] });
    beginTransform(state, 0);
    applyTransform(state, { x: 0, y: 0, width: 40, height: 20 });
    expect(state.items[0].points).toEqual([{ x: 0, y: 0 }, { x: 20, y: 20 }, { x: 40, y: 0 }]);
  });

  it('does not reach back through the undo snapshot when a stroke is dragged', () => {
    const state = sketchWith({ kind: 'stroke', width: 2, points: [{ x: 0, y: 0 }, { x: 10, y: 10 }] });
    const before = JSON.stringify(state.items[0].points);
    beginTransform(state, 0);
    applyTransform(state, { x: 50, y: 50 });
    endTransform(state);
    undo(state);
    expect(JSON.stringify(state.items[0].points)).toBe(before);
  });
});

describe('text boxes', () => {
  it('adds a text box and reports blank content so the panel can drop it', () => {
    const state = createSketch();
    const index = addText(state, { x: 5, y: 5, width: 100, height: 30 });
    expect(setText(state, index, '   ')).toBe(false);
    expect(setText(state, index, 'hello')).toBe(true);
    expect(state.items[index]).toMatchObject({ kind: 'text', text: 'hello', x: 5, y: 5 });
  });

  it('wraps greedily at the box width and keeps explicit line breaks', () => {
    const measure = (s) => s.length * 10; // 10px per character
    expect(wrapText('aaa bbb ccc', 70, measure)).toEqual(['aaa bbb', 'ccc']);
    expect(wrapText('one\ntwo', 1000, measure)).toEqual(['one', 'two']);
  });

  it('moves and resizes like any other item', () => {
    const state = createSketch();
    addText(state, { x: 0, y: 0, width: 100, height: 30, text: 'hi' });
    beginTransform(state, 0);
    applyTransform(state, { x: 20, y: 40, width: 200, height: 60 });
    expect(boxOf(state.items[0])).toEqual({ x: 20, y: 40, width: 200, height: 60 });
  });
});

// `width` means LINE width on a stroke or shape, but BOX width on an image or a
// text box. Treating the latter as ink gave a wide caption a grab halo half its
// own width on every side, letting it swallow clicks meant for its neighbours.
describe('hit-test slack only applies to line width', () => {
  it('does not give a wide text box a halo', () => {
    const state = createSketch();
    addText(state, { x: 20, y: 120, width: 260, height: 30, text: 'wide caption' });
    expect(itemAt(state, 30, 130)).toBe(0);   // inside
    expect(itemAt(state, 30, 25)).toBe(-1);   // 95px above it: not a hit
    expect(itemAt(state, 30, 200)).toBe(-1);  // and not below
  });

  it('does not give a large image a halo', () => {
    const state = createSketch();
    addImage(state, { src: 'x', el: null, x: 200, y: 200, width: 300, height: 200 });
    expect(itemAt(state, 250, 250)).toBe(0);
    expect(itemAt(state, 60, 250)).toBe(-1);  // well clear to the left
  });

  it('still gives a thick stroke the slack it paints with', () => {
    const state = createSketch();
    state.items = [{ kind: 'stroke', width: 24, points: [{ x: 50, y: 50 }, { x: 90, y: 50 }] }];
    expect(itemAt(state, 70, 58)).toBe(0);   // within half the 24px nib
    expect(itemAt(state, 70, 90)).toBe(-1);  // beyond it
  });

  it('picks the box actually clicked when two sit apart', () => {
    const state = createSketch();
    addText(state, { x: 20, y: 20, width: 260, height: 30, text: 'first' });
    addText(state, { x: 20, y: 120, width: 260, height: 30, text: 'second' });
    expect(itemAt(state, 25, 25)).toBe(0);
    expect(itemAt(state, 25, 125)).toBe(1);
  });
});

describe('fill behind text rendering', () => {
  const rects = (ctx) => ctx.calls.filter((c) => c[0] === 'fillRect');

  it('paints a fill behind the text, sized to the longest line', () => {
    const state = createSketch();
    addText(state, { x: 40, y: 60, width: 200, height: 30, text: 'over a map', size: 20, background: '#ffffff' });
    const ctx = fakeCtx();
    replay(ctx, state.items);
    expect(rects(ctx).length).toBeGreaterThan(0);
    const [, x, y] = rects(ctx)[0];
    expect(x).toBeLessThan(40); // padded outwards from the text origin
    expect(y).toBeLessThan(60);
  });

  it('paints nothing when the fill is off', () => {
    const state = createSketch();
    addText(state, { x: 40, y: 60, width: 200, height: 30, text: 'plain', size: 20 });
    const ctx = fakeCtx();
    replay(ctx, state.items);
    expect(rects(ctx)).toHaveLength(0);
  });

  // fillRect consumes fillStyle, so the words would inherit the fill colour and
  // vanish into it.
  it('restores the text colour after filling', () => {
    const state = createSketch();
    addText(state, { x: 0, y: 0, width: 200, height: 30, text: 'hi', size: 20, color: '#ed1c24', background: '#ffffff' });
    const ctx = fakeCtx();
    replay(ctx, state.items);
    const styles = ctx.calls.filter((c) => c[0] === 'set:fillStyle').map((c) => c[1]);
    expect(styles[styles.length - 1]).toBe('#ed1c24');
  });
});

