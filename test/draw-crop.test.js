// Crop, in the sketchpad and over a photo — above all the page-long capture that
// "Capture entire page" opens here, which never fits on screen and so is the
// case every part of the tool has to work for.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { showDrawPanel, drawingToBlob } from '../src/app/draw-panel.js';
import {
  createSketch, beginStroke, extendStroke, endStroke, addImage,
  undo, redo, clear, isEmpty, replay, itemAt, inkBand, bringToFront, sendToBack,
  setCrop, cropOf, marksOf, hasMarks, cropRect, resizeCropRect, moveCropRect, cropHandleAt,
  CROP, MIN_CROP,
} from '../src/lib/drawing.js';

function stroke(state, points, opts = {}) {
  beginStroke(state, { x: points[0][0], y: points[0][1], ...opts });
  for (const [x, y] of points.slice(1)) extendStroke(state, { x, y });
  return endStroke(state);
}

describe('a crop in the drawing model', () => {
  it('is one undo step, and comes back with redo', () => {
    const state = createSketch();
    stroke(state, [[10, 10], [50, 50]]);
    setCrop(state, { x: 5, y: 5, width: 100, height: 80 });
    expect(cropOf(state.items)).toEqual({ x: 5, y: 5, width: 100, height: 80 });
    undo(state);
    expect(cropOf(state.items)).toBeNull();
    expect(state.items).toHaveLength(1); // the stroke is untouched
    redo(state);
    expect(cropOf(state.items)).toEqual({ x: 5, y: 5, width: 100, height: 80 });
  });

  it('replaces the crop before it rather than stacking a second one', () => {
    const state = createSketch();
    setCrop(state, { x: 0, y: 0, width: 100, height: 100 });
    setCrop(state, { x: 10, y: 10, width: 50, height: 50 });
    expect(state.items.filter((item) => item.kind === CROP)).toHaveLength(1);
    expect(cropOf(state.items)).toEqual({ x: 10, y: 10, width: 50, height: 50 });
  });

  it('takes no undo step when nothing would change', () => {
    const state = createSketch();
    setCrop(state, null);
    expect(state.past).toHaveLength(0);
    setCrop(state, { x: 1, y: 2, width: 30, height: 40 });
    setCrop(state, { x: 1, y: 2, width: 30, height: 40 });
    expect(state.past).toHaveLength(1);
  });

  it('is removed by a null crop, which brings the whole picture back', () => {
    const state = createSketch();
    stroke(state, [[10, 10], [50, 50]]);
    setCrop(state, { x: 0, y: 0, width: 40, height: 40 });
    setCrop(state, null);
    expect(cropOf(state.items)).toBeNull();
    expect(state.items).toHaveLength(1);
  });

  it('is not a mark: it paints nothing, cannot be picked, and needs no ink layer', () => {
    const state = createSketch();
    setCrop(state, { x: 0, y: 0, width: 200, height: 200 });
    const calls = [];
    const ctx = new Proxy({}, { get: (_, key) => (...args) => calls.push([key, ...args]), set: () => true });
    replay(ctx, state.items);
    expect(calls).toEqual([]);
    expect(itemAt(state, 100, 100)).toBe(-1);
    expect(inkBand(state.items, 1000)).toBeNull();
    expect(hasMarks(state)).toBe(false);
    expect(marksOf(state.items)).toEqual([]);
    expect(isEmpty(state)).toBe(false); // but it IS a change worth saving
  });

  it('survives Clear, which wipes the marks and leaves the page as it is', () => {
    const state = createSketch();
    stroke(state, [[10, 10], [50, 50]]);
    setCrop(state, { x: 0, y: 0, width: 40, height: 40 });
    clear(state);
    expect(hasMarks(state)).toBe(false);
    expect(cropOf(state.items)).toEqual({ x: 0, y: 0, width: 40, height: 40 });
    const steps = state.past.length;
    clear(state); // nothing left to clear: no empty undo step
    expect(state.past).toHaveLength(steps);
  });

  it('does not count as an object above or below when reordering', () => {
    const state = createSketch();
    addImage(state, { src: 'a', x: 0, y: 0, width: 10, height: 10 });
    setCrop(state, { x: 0, y: 0, width: 40, height: 40 }); // items: [image, crop]
    const steps = state.past.length;
    expect(bringToFront(state, 0)).toBe(0); // already the top mark
    expect(sendToBack(state, 0)).toBe(0);
    expect(state.past).toHaveLength(steps);
  });
});

describe('crop frame geometry', () => {
  it('takes any two corners and stays inside the drawing', () => {
    expect(cropRect(300, 200, 100, 50, 960, 560)).toEqual({ x: 100, y: 50, width: 200, height: 150 });
    expect(cropRect(-40, -10, 2000, 9999, 960, 560)).toEqual({ x: 0, y: 0, width: 960, height: 560 });
  });

  it('moves one edge from a side and two from a corner', () => {
    const box = { x: 100, y: 100, width: 200, height: 100 };
    expect(resizeCropRect(box, 's', 0, 400, 960, 560)).toEqual({ x: 100, y: 100, width: 200, height: 300 });
    expect(resizeCropRect(box, 'w', 40, 0, 960, 560)).toEqual({ x: 40, y: 100, width: 260, height: 100 });
    expect(resizeCropRect(box, 'ne', 500, 20, 960, 560)).toEqual({ x: 100, y: 20, width: 400, height: 180 });
  });

  it('stops an edge short of its opposite, and at the edge of the drawing', () => {
    const box = { x: 100, y: 100, width: 200, height: 100 };
    expect(resizeCropRect(box, 's', 0, -500, 960, 560).height).toBe(MIN_CROP);
    expect(resizeCropRect(box, 'e', 5000, 0, 960, 560)).toEqual({ x: 100, y: 100, width: 860, height: 100 });
  });

  it('slides without leaving the drawing or changing size', () => {
    const box = { x: 100, y: 100, width: 200, height: 100 };
    expect(moveCropRect(box, -50, 9999, 960, 560)).toEqual({ x: 0, y: 460, width: 200, height: 100 });
  });

  it('finds corners, sides — anywhere along them — the inside, and nothing outside', () => {
    const box = { x: 100, y: 100, width: 200, height: 4000 };
    expect(cropHandleAt(box, 102, 98, 12)).toBe('nw');
    expect(cropHandleAt(box, 300, 4100, 12)).toBe('se');
    expect(cropHandleAt(box, 104, 2500, 12)).toBe('w'); // far from the side's middle grip
    expect(cropHandleAt(box, 200, 4095, 12)).toBe('s');
    expect(cropHandleAt(box, 200, 2000, 12)).toBe('move');
    expect(cropHandleAt(box, 400, 2000, 12)).toBeNull();
    expect(cropHandleAt(null, 0, 0, 12)).toBeNull();
  });
});

/* ------------------------------------------------------------------ panel */

beforeEach(() => {
  document.body.innerHTML = '';
  HTMLCanvasElement.prototype.getContext = () => null; // jsdom has no 2D context
});

// jsdom has no PointerEvent; a MouseEvent carries every field the panel reads.
function pointer(el, type, x, y, opts = {}) {
  const ev = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, shiftKey: !!opts.shift });
  Object.defineProperty(ev, 'pointerId', { value: 1, configurable: true });
  el.dispatchEvent(ev);
  return ev;
}
function click(el) { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
function pickTool(id) { click(document.querySelector(`.draw-tool[data-tool="${id}"]`)); }
function drag(canvas, points, opts = {}) {
  pointer(canvas, 'pointerdown', points[0][0], points[0][1], opts);
  for (const [x, y] of points.slice(1)) pointer(canvas, 'pointermove', x, y, opts);
  const last = points[points.length - 1];
  pointer(canvas, 'pointerup', last[0], last[1], opts);
}
function key(name, opts = {}) {
  const ev = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...opts });
  document.dispatchEvent(ev);
  return ev;
}
const wheel = (el, deltaY, opts = {}) => {
  const ev = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true, ...opts });
  el.dispatchEvent(ev);
  return ev;
};
const info = () => document.querySelector('.draw-crop-info').textContent;
const activeTool = () => document.querySelector('.draw-tool.active').dataset.tool;
const nextFrame = () => new Promise((resolve) => setTimeout(resolve, 24));
const okExport = () => vi.fn(async (items, w, h, scale, options) => new Blob(['x'], { type: options?.type || 'image/png' }));

describe('crop in the sketchpad (Draw)', () => {
  it('offers a Crop tool, whose bar takes the hint row while it is the tool', () => {
    showDrawPanel({});
    const bar = document.querySelector('.draw-crop-bar');
    const hint = document.querySelector('.draw-hint');
    expect(bar.parentElement).toBe(hint.parentElement);
    expect(bar.hidden).toBe(true);
    pickTool('crop');
    expect(bar.hidden).toBe(false);
    expect(hint.hidden).toBe(true);
    expect(info()).toMatch(/drag over the part/i);
    expect(document.querySelector('.draw-crop-apply').disabled).toBe(true);
    pickTool('pen');
    expect(bar.hidden).toBe(true);
    expect(hint.hidden).toBe(false);
  });

  it('frames a part by dragging and crops to it on Enter, back in the tool before', () => {
    const { canvas, state } = showDrawPanel({});
    drag(canvas, [[10, 10], [400, 300]]); // a pen stroke
    pickTool('crop');
    drag(canvas, [[100, 50], [300, 250]]);
    expect(info()).toMatch(/^200 × 200 px/);
    expect(cropOf(state.items)).toBeNull(); // only a proposal so far
    const ev = key('Enter');
    expect(ev.defaultPrevented).toBe(true);
    expect(cropOf(state.items)).toEqual({ x: 100, y: 50, width: 200, height: 200 });
    expect(activeTool()).toBe('pen');
  });

  it('saves only the cropped part, and hands the export marks without the crop', async () => {
    const exportBlob = okExport();
    const onSave = vi.fn();
    const { canvas } = showDrawPanel({ exportBlob, onSave });
    drag(canvas, [[10, 10], [400, 300]]);
    pickTool('crop');
    drag(canvas, [[100, 50], [300, 250]]);
    click(document.querySelector('.draw-crop-apply'));
    click(document.querySelector('.draw-save'));
    await vi.waitFor(() => expect(onSave).toHaveBeenCalled());
    const [items, width, height, , options] = exportBlob.mock.calls[0];
    expect(items.map((item) => item.kind)).toEqual(['stroke']);
    expect([width, height]).toEqual([960, 560]);
    expect(options).toEqual({ crop: { x: 100, y: 50, width: 200, height: 200 } });
  });

  it('Save takes a frame that is still on screen as the crop', async () => {
    const exportBlob = okExport();
    const onSave = vi.fn();
    const { canvas } = showDrawPanel({ exportBlob, onSave });
    drag(canvas, [[10, 10], [400, 300]]);
    pickTool('crop');
    drag(canvas, [[100, 50], [300, 250]]);
    click(document.querySelector('.draw-save'));
    await vi.waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(exportBlob.mock.calls[0][4]).toEqual({ crop: { x: 100, y: 50, width: 200, height: 200 } });
  });

  it('Escape backs out of cropping without cropping, and without closing', () => {
    const { canvas, state } = showDrawPanel({});
    drag(canvas, [[10, 10], [400, 300]]);
    pickTool('crop');
    drag(canvas, [[100, 50], [300, 250]]);
    key('Escape');
    expect(activeTool()).toBe('pen');
    expect(cropOf(state.items)).toBeNull();
    expect(document.querySelector('.draw-backdrop')).toBeTruthy();
    expect(document.querySelector('.draw-confirm').hidden).toBe(true);
  });

  it('a frame left behind by switching tools is not applied', () => {
    const { canvas, state } = showDrawPanel({});
    pickTool('crop');
    drag(canvas, [[100, 50], [300, 250]]);
    pickTool('pen');
    expect(cropOf(state.items)).toBeNull();
    pickTool('crop');
    expect(info()).toMatch(/drag over the part/i);
  });

  it('a click, or a sliver, leaves no frame', () => {
    const { canvas } = showDrawPanel({});
    pickTool('crop');
    drag(canvas, [[100, 50]]);
    expect(info()).toMatch(/drag over the part/i);
    drag(canvas, [[100, 50], [103, 300]]);
    expect(info()).toMatch(/drag over the part/i);
    expect(document.querySelector('.draw-crop-apply').disabled).toBe(true);
  });

  it('applies on a double-click inside the frame', () => {
    const { canvas, state } = showDrawPanel({});
    pickTool('crop');
    drag(canvas, [[100, 50], [300, 250]]);
    canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: 200, clientY: 150 }));
    expect(cropOf(state.items)).toEqual({ x: 100, y: 50, width: 200, height: 200 });
  });

  it('moves the frame from inside and resizes it from a side or a corner', () => {
    const { canvas, state } = showDrawPanel({});
    pickTool('crop');
    drag(canvas, [[100, 100], [300, 200]]);
    drag(canvas, [[200, 150], [250, 170]]);      // inside: move by (50, 20)
    drag(canvas, [[250, 220], [250, 320]]);      // bottom side: 100 taller
    drag(canvas, [[150, 120], [120, 100]]);      // top-left corner: out by (30, 20)
    key('Enter');
    expect(cropOf(state.items)).toEqual({ x: 120, y: 100, width: 230, height: 220 });
  });

  it('squares the frame while Shift is held', () => {
    const { canvas, state } = showDrawPanel({});
    pickTool('crop');
    drag(canvas, [[100, 100], [300, 180]], { shift: true });
    key('Enter');
    expect(cropOf(state.items)).toEqual({ x: 100, y: 100, width: 200, height: 200 });
  });

  it('Undo brings the whole picture back, and Redo crops it again', () => {
    const { canvas, state } = showDrawPanel({});
    pickTool('crop');
    drag(canvas, [[100, 50], [300, 250]]);
    key('Enter');
    key('z', { ctrlKey: true });
    expect(cropOf(state.items)).toBeNull();
    key('z', { ctrlKey: true, shiftKey: true });
    expect(cropOf(state.items)).toEqual({ x: 100, y: 50, width: 200, height: 200 });
  });

  it('reopens on the crop already made, and "Show all" removes it', () => {
    const { canvas, state } = showDrawPanel({});
    pickTool('crop');
    expect(document.querySelector('.draw-crop-reset').hidden).toBe(true);
    drag(canvas, [[100, 50], [300, 250]]);
    key('Enter');
    pickTool('crop');
    expect(info()).toMatch(/^200 × 200 px/);
    const reset = document.querySelector('.draw-crop-reset');
    expect(reset.hidden).toBe(false);
    click(reset);
    expect(cropOf(state.items)).toBeNull();
    expect(info()).toMatch(/drag over the part/i);
    expect(activeTool()).toBe('crop');
  });

  it('a frame around everything is no crop, and undoes one that was there', () => {
    const { canvas, state } = showDrawPanel({});
    pickTool('crop');
    drag(canvas, [[100, 50], [300, 250]]);
    key('Enter');
    pickTool('crop');
    drag(canvas, [[-20, -20], [2000, 2000]]);
    key('Enter');
    expect(cropOf(state.items)).toBeNull();
    expect(isEmpty(state)).toBe(true);
  });

  it('a cropped page with nothing on it still has nothing to save or to ask about', () => {
    const { canvas, saveButton } = showDrawPanel({});
    pickTool('crop');
    drag(canvas, [[100, 50], [300, 250]]);
    key('Enter');
    expect(saveButton.disabled).toBe(true);
    expect(document.querySelector('.draw-clear').disabled).toBe(true);
    key('Escape');
    expect(document.querySelector('.draw-backdrop')).toBeNull(); // closed without a confirm
  });

  it('Clear keeps the crop', () => {
    const { canvas, state } = showDrawPanel({});
    drag(canvas, [[10, 10], [400, 300]]);
    pickTool('crop');
    drag(canvas, [[100, 50], [300, 250]]);
    key('Enter');
    click(document.querySelector('.draw-clear'));
    expect(hasMarks(state)).toBe(false);
    expect(cropOf(state.items)).toEqual({ x: 100, y: 50, width: 200, height: 200 });
  });

  it('Enter on another focused button is left to that button', () => {
    const { canvas, state } = showDrawPanel({});
    pickTool('crop');
    drag(canvas, [[100, 50], [300, 250]]);
    const cancel = document.querySelector('.draw-cancel');
    cancel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(cropOf(state.items)).toBeNull();
    // …but on the Crop tool's own button, where the click that picked it left the focus, it crops.
    document.querySelector('.draw-tool-crop')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(cropOf(state.items)).toEqual({ x: 100, y: 50, width: 200, height: 200 });
  });

  it('shows the cropped page clipped, on the grey that marks what is not saved', async () => {
    const { canvas } = showDrawPanel({});
    pickTool('crop');
    drag(canvas, [[100, 50], [300, 250]]);
    key('Enter');
    await nextFrame();
    expect(canvas.style.clipPath).toBe('inset(50px 660px 310px 100px)');
    expect(document.querySelector('.draw-surface').classList.contains('cropped')).toBe(true);
    pickTool('crop'); // the Crop tool shows everything again, to drag the frame back out
    await nextFrame();
    expect(canvas.style.clipPath).toBe('');
    const css = readFileSync('src/app/app.css', 'utf8');
    expect(css).toMatch(/\.draw-surface\.cropped\s*\{[^}]*background/);
    expect(css).toMatch(/\.draw-crop-bar\[hidden\][^{]*\{\s*display:\s*none/);
  });
});

// The hint used to say "Select (↖)" long after the Select button had become a
// dashed box, so it named a tool by a symbol that was nowhere on screen.
describe('the hint under the toolbar', () => {
  const css = readFileSync('src/app/app.css', 'utf8');

  it('names Crop and Select in words, each with its own button’s icon', () => {
    showDrawPanel({});
    const hint = document.querySelector('.draw-hint');
    expect(hint.textContent).toMatch(/Crop\s+keeps just a part · Select\s+moves or resizes what you drew/);
    expect(hint.textContent).not.toMatch(/[↖⌗]/);
    for (const name of ['crop', 'select']) {
      expect(hint.querySelector(`.draw-hint-icon.draw-hint-${name}`).getAttribute('aria-hidden')).toBe('true');
      // One drawing for the button and for the hint, so the two cannot drift apart again.
      expect(css).toMatch(new RegExp(`\\.draw-tool-${name}::before,\\s*\\.draw-hint-${name}::before\\s*\\{`));
    }
  });

  it('says how to get around a photo, and still names the tools', async () => {
    await showDrawPanel({
      photo: { src: 'data:image/jpeg;base64,AA', name: 'p.jpg', mime: 'image/jpeg' },
      loadImage: async () => ({ naturalWidth: 1280, naturalHeight: 12000 }),
    }).ready;
    const hint = document.querySelector('.draw-hint');
    expect(hint.textContent).toMatch(/^Scroll to move around · Ctrl\+scroll to zoom/);
    expect(hint.querySelectorAll('.draw-hint-icon')).toHaveLength(2);
  });
});

describe('crop over a page-long capture (Edit photo)', () => {
  // 1280 × 12000 on the 960 × 560 fallback canvas: fitted to the width, so the
  // drawing is 960 × 9000 and one drawing unit is 4/3 of a photo pixel.
  const el = { naturalWidth: 1280, naturalHeight: 12000 };
  const tall = { src: 'data:image/jpeg;base64,AA', name: 'Tall page.jpg', mime: 'image/jpeg' };
  const open = async (extra = {}) => {
    const panel = showDrawPanel({ photo: tall, loadImage: async () => el, ...extra });
    await panel.ready;
    return panel;
  };

  it('saves a crop with no marks: the photo changed, so Save has work to do', async () => {
    const exportBlob = okExport();
    const onSave = vi.fn();
    const { canvas } = await open({ exportBlob, onSave });
    pickTool('crop');
    drag(canvas, [[120, 60], [720, 360]]);
    expect(info()).toMatch(/^800 × 400 px/); // the photo's own pixels, not the screen's
    key('Enter');
    click(document.querySelector('.draw-save'));
    await vi.waitFor(() => expect(onSave).toHaveBeenCalled());
    const [items, width, height, scale, options] = exportBlob.mock.calls[0];
    expect(items).toEqual([]);
    expect([width, height]).toEqual([960, 9000]);
    expect(scale).toBeCloseTo(1280 / 960);
    expect(options).toEqual({ background: el, type: 'image/jpeg', crop: { x: 120, y: 60, width: 600, height: 300 } });
    expect(onSave.mock.calls[0][0].name).toBe('Tall page.jpg');
  });

  it('asks before discarding a crop', async () => {
    const { canvas } = await open();
    pickTool('crop');
    drag(canvas, [[120, 60], [720, 360]]);
    key('Enter');
    click(document.querySelector('.draw-cancel'));
    expect(document.querySelector('.draw-confirm').hidden).toBe(false);
  });

  it('stretches a frame in mid-drag as the wheel scrolls the page under it', async () => {
    const { canvas, state, view } = await open();
    pickTool('crop');
    pointer(canvas, 'pointerdown', 100, 100);
    pointer(canvas, 'pointermove', 300, 300);
    wheel(document.querySelector('.draw-surface'), 1000);
    expect(view.y).toBe(-1000);
    pointer(canvas, 'pointerup', 300, 300);
    key('Enter');
    expect(cropOf(state.items)).toEqual({ x: 100, y: 100, width: 200, height: 1200 });
  });

  it('scrolls by itself when a frame is dragged to the bottom edge, and stops on release', async () => {
    const { canvas, state, view } = await open();
    pickTool('crop');
    pointer(canvas, 'pointerdown', 100, 100);
    pointer(canvas, 'pointermove', 300, 620); // past the bottom of the 560-tall window
    await vi.waitFor(() => expect(view.y).toBeLessThan(-200), { timeout: 5000 }); // frames can come slowly beside other tests
    pointer(canvas, 'pointerup', 300, 620);
    const stopped = view.y;
    await nextFrame();
    await nextFrame();
    expect(view.y).toBe(stopped);
    key('Enter');
    const crop = cropOf(state.items);
    expect(crop.y).toBe(100);
    expect(crop.height).toBeCloseTo(620 - stopped - 100); // taller than the window
    expect(crop.height).toBeGreaterThan(560);
  });

  it('does not scroll up for a drag that only starts near the top edge', async () => {
    const { canvas, view } = await open();
    wheel(document.querySelector('.draw-surface'), 2000);
    pickTool('crop');
    pointer(canvas, 'pointerdown', 100, 10);
    pointer(canvas, 'pointermove', 300, 30);
    await nextFrame();
    await nextFrame();
    expect(view.y).toBe(-2000);
    pointer(canvas, 'pointerup', 300, 30);
  });

  it('grows a frame from its bottom side, grabbed far from the middle grip', async () => {
    const { canvas, state } = await open();
    pickTool('crop');
    drag(canvas, [[100, 100], [800, 300]]);
    wheel(document.querySelector('.draw-surface'), 200);
    // The bottom side is at y 300 − 200 = 100 on screen now; take it near its left end.
    drag(canvas, [[130, 100], [130, 500]]);
    key('Enter');
    expect(cropOf(state.items)).toEqual({ x: 100, y: 100, width: 700, height: 600 });
  });

  it('frames the view on what is kept, and hides the rest of the photo', async () => {
    const { canvas, state, view } = await open();
    wheel(document.querySelector('.draw-surface'), 3000);
    pickTool('crop');
    drag(canvas, [[180, 80], [780, 480]]); // 600 × 400 of the drawing, at y 3080
    key('Enter');
    expect(cropOf(state.items)).toEqual({ x: 180, y: 3080, width: 600, height: 400 });
    // Smaller than the window both ways, so it is centred in it.
    expect(view.x).toBe((960 - 600) / 2 - 180);
    expect(view.y).toBe((560 - 400) / 2 - 3080);
    await nextFrame();
    expect(document.querySelector('.draw-photo').style.clipPath).toBe('inset(3080px 180px 5520px 180px)');
    expect(document.querySelector('.draw-scrollbar.vertical').hidden).toBe(true);
    // A mark lands where the pointer is on the cropped photo.
    drag(canvas, [[200, 100], [220, 100]]);
    expect(marksOf(state.items)[0].points[0]).toEqual({ x: 200 - view.x, y: 100 - view.y });
  });

  it('keeps a crop taller than the window scrollable, within the crop only', async () => {
    const { canvas, view } = await open();
    pickTool('crop');
    pointer(canvas, 'pointerdown', 0, 100);
    pointer(canvas, 'pointermove', 960, 300);
    wheel(document.querySelector('.draw-surface'), 2000);
    pointer(canvas, 'pointerup', 960, 300);
    expect(view.y).toBe(-2000);
    key('Enter'); // rows 100 … 2300 of the drawing
    expect(view.y).toBe(-100); // shown from the top of what is kept, not where the drag ended
    key('End');
    key('Home');
    expect(view.y).toBe(-100);
    key('End');
    expect(view.y).toBe(560 - 2300);
    await nextFrame();
    expect(document.querySelector('.draw-scrollbar.vertical').hidden).toBe(false);
  });
});

/* ----------------------------------------------------------------- export */

describe('drawingToBlob with a crop', () => {
  const realToBlob = HTMLCanvasElement.prototype.toBlob;
  let canvases;
  beforeEach(() => {
    canvases = [];
    HTMLCanvasElement.prototype.getContext = function getContext() {
      const calls = [];
      const ctx = new Proxy({}, {
        get: (_, name) => (name === 'calls' ? calls : (...args) => { calls.push([name, ...args]); }),
        set: () => true,
      });
      canvases.push({ el: this, calls });
      return ctx;
    };
    HTMLCanvasElement.prototype.toBlob = function toBlob(done, type) { done(new Blob(['x'], { type })); };
  });
  afterEach(() => { HTMLCanvasElement.prototype.toBlob = realToBlob; });

  const photo = { fake: 'decoded photo' };
  const scale = 1280 / 960;

  it('copies exactly the cropped pixels of the photo, without resampling them', async () => {
    const blob = await drawingToBlob([], 960, 9000, scale, {
      background: photo, type: 'image/jpeg', crop: { x: 96, y: 3000, width: 480, height: 300 },
    });
    expect(blob.type).toBe('image/jpeg');
    expect(canvases).toHaveLength(1); // no marks: no ink layer at all
    const [flat] = canvases;
    expect([flat.el.width, flat.el.height]).toEqual([640, 400]);
    expect(flat.calls.find((c) => c[0] === 'drawImage')).toEqual(['drawImage', photo, 128, 4000, 640, 400, 0, 0, 640, 400]);
  });

  it('lays the marks down where they sit inside the crop', async () => {
    const state = createSketch();
    stroke(state, [[200, 3100], [300, 3110]], { width: 4 });
    await drawingToBlob(state.items, 960, 9000, scale, {
      background: photo, type: 'image/jpeg', crop: { x: 96, y: 3000, width: 480, height: 300 },
    });
    const [flat, layer] = canvases;
    // The stroke's band is rows 3076 … 3134 of the drawing: 4101 … 4179 of the photo,
    // which is 101 … 179 of the cropped output.
    expect([layer.el.width, layer.el.height]).toEqual([640, 78]);
    expect(layer.calls[0]).toEqual(['translate', -128, -4101]);
    expect(layer.calls[1]).toEqual(['scale', scale, scale]);
    expect(flat.calls.filter((c) => c[0] === 'drawImage')[1]).toEqual(['drawImage', layer.el, 0, 101]);
  });

  it('skips the ink layer when every mark is outside the crop', async () => {
    const state = createSketch();
    stroke(state, [[200, 8000], [300, 8010]], { width: 4 });
    await drawingToBlob(state.items, 960, 9000, scale, {
      background: photo, crop: { x: 96, y: 3000, width: 480, height: 300 },
    });
    expect(canvases).toHaveLength(1);
  });

  it('crops a drawing too, at the density it is saved at', async () => {
    const state = createSketch();
    stroke(state, [[150, 100], [200, 150]], { width: 4 });
    await drawingToBlob(state.items, 960, 560, 2, { crop: { x: 100, y: 50, width: 200, height: 200 } });
    const [flat, layer] = canvases;
    expect([flat.el.width, flat.el.height]).toEqual([400, 400]);
    expect([layer.el.width, layer.el.height]).toEqual([400, 400]);
    expect(layer.calls[0]).toEqual(['translate', -200, -100]);
  });

  it('is unchanged without a crop: the whole photo, drawn once at its own size', async () => {
    await drawingToBlob([], 960, 9000, scale, { background: photo, type: 'image/jpeg' });
    const [flat] = canvases;
    expect([flat.el.width, flat.el.height]).toEqual([1280, 12000]);
    expect(flat.calls.find((c) => c[0] === 'drawImage')).toEqual(['drawImage', photo, 0, 0, 1280, 12000]);
  });
});
