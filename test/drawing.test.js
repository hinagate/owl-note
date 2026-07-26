import { describe, it, expect } from 'vitest';
import {
  createSketch, beginStroke, extendStroke, endStroke,
  undo, redo, clear, isEmpty, canUndo, canRedo, replay, PEN, ERASE,
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
    expect(s.strokes).toHaveLength(1);
    expect(s.strokes[0]).toMatchObject({ color: '#d93025', width: 8, mode: PEN });
    expect(s.strokes[0].points).toEqual([{ x: 1, y: 2 }, { x: 3, y: 4 }]);
    expect(isEmpty(s)).toBe(false);
  });

  it('keeps a single-point stroke, so a click leaves a dot', () => {
    const s = createSketch();
    stroke(s, [[5, 5]]);
    expect(s.strokes[0].points).toHaveLength(1);
  });

  it('ignores duplicate samples and points after the stroke ends', () => {
    const s = createSketch();
    beginStroke(s, { x: 0, y: 0 });
    extendStroke(s, { x: 0, y: 0 });
    extendStroke(s, { x: 1, y: 1 });
    endStroke(s);
    extendStroke(s, { x: 9, y: 9 });
    expect(s.strokes[0].points).toEqual([{ x: 0, y: 0 }, { x: 1, y: 1 }]);
  });

  it('undoes and redoes one stroke at a time', () => {
    const s = createSketch();
    stroke(s, [[0, 0]]);
    stroke(s, [[1, 1]]);
    undo(s);
    expect(s.strokes).toHaveLength(1);
    redo(s);
    expect(s.strokes).toHaveLength(2);
  });

  it('undo and redo are no-ops at the ends of history', () => {
    const s = createSketch();
    expect(undo(s).strokes).toHaveLength(0);
    stroke(s, [[0, 0]]);
    expect(redo(s).strokes).toHaveLength(1);
  });

  it('discards the redo stack when a new stroke branches off an undo', () => {
    const s = createSketch();
    stroke(s, [[0, 0]]);
    undo(s);
    stroke(s, [[2, 2]]);
    expect(canRedo(s)).toBe(false);
    expect(s.strokes).toHaveLength(1);
    expect(s.strokes[0].points[0]).toEqual({ x: 2, y: 2 });
  });

  it('restores everything cleared in a single undo', () => {
    const s = createSketch();
    stroke(s, [[0, 0]]);
    stroke(s, [[1, 1]]);
    clear(s);
    expect(isEmpty(s)).toBe(true);
    undo(s);
    expect(s.strokes).toHaveLength(2);
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
    replay(ctx, s.strokes);
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
    replay(ctx, s.strokes);
    expect(ctx.calls).toContainEqual(['arc', 7, 8, 3, 0, Math.PI * 2]);
    expect(ctx.calls.map((c) => c[0])).toContain('fill');
  });

  it('composites eraser strokes with destination-out', () => {
    const ctx = fakeCtx();
    const s = createSketch();
    stroke(s, [[0, 0], [5, 5]], { mode: ERASE });
    replay(ctx, s.strokes);
    expect(ctx.calls).toContainEqual(['set:globalCompositeOperation', 'destination-out']);
  });

  it('replay tolerates a missing context', () => {
    const s = createSketch();
    stroke(s, [[0, 0], [1, 1]]);
    expect(() => replay(null, s.strokes)).not.toThrow();
  });
});
