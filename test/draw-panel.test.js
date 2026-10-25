import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { showDrawPanel, photoOutputType, photoFileName } from '../src/app/draw-panel.js';

beforeEach(() => {
  document.body.innerHTML = '';
  // jsdom has no 2D context and logs a "Not implemented" trace for every call.
  // Returning null is exactly what it does after that log, so the panel takes
  // its real no-context path — this only silences the noise.
  HTMLCanvasElement.prototype.getContext = () => null;
  // jsdom's FileReader cannot read a Blob to a data: URI here; the panel only
  // needs the string to hand to loadImage, which tests stub anyway.
  globalThis.FileReader = class {
    readAsDataURL() { this.result = 'data:image/png;base64,AA'; this.onload?.(); }
  };
});

// jsdom has no PointerEvent; a MouseEvent carries every field the panel reads.
function pointer(el, type, x, y, opts = {}) {
  const ev = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, shiftKey: !!opts.shift });
  Object.defineProperty(ev, 'pointerId', { value: 1, configurable: true });
  el.dispatchEvent(ev);
  return ev;
}

function pickTool(id) {
  click(document.querySelector(`.draw-tool[data-tool="${id}"]`));
}

// A clipboard paste carrying one image, shaped the way the panel reads it.
function pasteImage(type = 'image/png') {
  const ev = new Event('paste', { bubbles: true, cancelable: true });
  ev.clipboardData = { items: [{ type, getAsFile: () => new Blob(['x'], { type }) }] };
  document.dispatchEvent(ev);
  return ev;
}

function click(el) {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function draw(canvas, points, opts = {}) {
  pointer(canvas, 'pointerdown', points[0][0], points[0][1], opts);
  for (const [x, y] of points.slice(1)) pointer(canvas, 'pointermove', x, y, opts);
  const last = points[points.length - 1];
  pointer(canvas, 'pointerup', last[0], last[1], opts);
}

// jsdom decodes nothing; the panel takes loadImage as an option for exactly this.
const fakeLoadImage = async () => ({ naturalWidth: 400, naturalHeight: 200, width: 400, height: 200 });

const okExport = async () => new Blob(['png'], { type: 'image/png' });

describe('draw panel', () => {
  it('mounts a modal dialog with a canvas', () => {
    showDrawPanel({});
    const dialog = document.querySelector('.draw-dialog');
    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.querySelector('canvas.draw-canvas')).toBeTruthy();
  });

  it('opens with Save, Undo, and Redo disabled', () => {
    const { saveButton } = showDrawPanel({});
    expect(saveButton.disabled).toBe(true);
    expect(document.querySelector('.draw-undo').disabled).toBe(true);
    expect(document.querySelector('.draw-redo').disabled).toBe(true);
  });

  it('replaces an already-open panel instead of stacking two', () => {
    showDrawPanel({});
    showDrawPanel({});
    expect(document.querySelectorAll('.draw-backdrop')).toHaveLength(1);
  });

  it('records a stroke from a pointer drag and enables Save', () => {
    const { canvas, saveButton } = showDrawPanel({});
    draw(canvas, [[10, 10], [20, 20], [30, 30]]);
    expect(saveButton.disabled).toBe(false);
    expect(document.querySelector('.draw-undo').disabled).toBe(false);
  });

  it('ignores a pointermove that arrives without a pointerdown', () => {
    const { canvas, saveButton } = showDrawPanel({});
    pointer(canvas, 'pointermove', 10, 10);
    expect(saveButton.disabled).toBe(true);
  });

  it('selects tools, colors, and the stroke size', () => {
    showDrawPanel({});
    const eraser = document.querySelector('.draw-tool-erase');
    click(eraser);
    expect(eraser.classList.contains('active')).toBe(true);
    expect(document.querySelector('.draw-tool-pen').classList.contains('active')).toBe(false);

    const red = document.querySelector('.draw-color[data-color="#ed1c24"]');
    click(red);
    expect(red.classList.contains('active')).toBe(true);

    const size = document.querySelector('.draw-size-range');
    size.value = '8';
    size.dispatchEvent(new Event('input', { bubbles: true }));
    expect(document.querySelector('.draw-size-value').textContent).toBe('8');
  });

  it('undo re-disables Save once the canvas is empty again', () => {
    const { canvas, saveButton } = showDrawPanel({});
    draw(canvas, [[1, 1], [2, 2]]);
    click(document.querySelector('.draw-undo'));
    expect(saveButton.disabled).toBe(true);
    expect(document.querySelector('.draw-redo').disabled).toBe(false);
  });

  it('Ctrl+Z undoes and Ctrl+Shift+Z redoes', () => {
    const { canvas, saveButton } = showDrawPanel({});
    draw(canvas, [[1, 1], [2, 2]]);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    expect(saveButton.disabled).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true, bubbles: true }));
    expect(saveButton.disabled).toBe(false);
  });

  it('saves a PNG File named for the moment it was drawn, then closes', async () => {
    const onSave = vi.fn();
    const { canvas, saveButton } = showDrawPanel({
      onSave,
      exportBlob: okExport,
      now: () => new Date(2026, 6, 26, 14, 30, 12),
    });
    draw(canvas, [[1, 1], [2, 2]]);
    click(saveButton);
    await vi.waitFor(() => expect(onSave).toHaveBeenCalled());
    const file = onSave.mock.calls[0][0];
    expect(file.name).toBe('drawing-20260726-143012.png');
    expect(file.type).toBe('image/png');
    expect(document.querySelector('.draw-backdrop')).toBeNull();
  });

  it('keeps the panel and the strokes when the export fails', async () => {
    const onSave = vi.fn();
    const { canvas, saveButton } = showDrawPanel({
      onSave,
      exportBlob: async () => { throw new Error('no toBlob'); },
    });
    draw(canvas, [[1, 1], [2, 2]]);
    click(saveButton);
    await vi.waitFor(() => expect(document.querySelector('.draw-status').textContent).toMatch(/could not export/i));
    expect(onSave).not.toHaveBeenCalled();
    expect(document.querySelector('.draw-backdrop')).toBeTruthy();
    expect(saveButton.disabled).toBe(false);
  });

  it('closes immediately on Escape when nothing is drawn', () => {
    showDrawPanel({});
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.draw-backdrop')).toBeNull();
  });

  it('asks before discarding real work, and can be kept', () => {
    const { canvas } = showDrawPanel({});
    draw(canvas, [[1, 1], [2, 2]]);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.draw-backdrop')).toBeTruthy();
    const confirmRow = document.querySelector('.draw-confirm');
    expect(confirmRow.hidden).toBe(false);

    click(document.querySelector('.draw-keep'));
    expect(confirmRow.hidden).toBe(true);
    expect(document.querySelector('.draw-backdrop')).toBeTruthy();
  });

  it('discards on confirmation', () => {
    const { canvas } = showDrawPanel({});
    draw(canvas, [[1, 1], [2, 2]]);
    click(document.querySelector('.draw-cancel'));
    click(document.querySelector('.draw-discard'));
    expect(document.querySelector('.draw-backdrop')).toBeNull();
  });

  // Only the save row OR the discard row is ever shown, via the `hidden`
  // attribute. But `.share-link-dialog footer` sets display:flex, which outranks
  // the UA stylesheet's [hidden] rule — so hiding silently did nothing and the
  // panel rendered four buttons. jsdom applies no external stylesheet, so this
  // has to be asserted against the CSS text itself.
  it('has a CSS rule that actually hides a hidden footer', () => {
    const css = readFileSync('src/app/app.css', 'utf8'); // repo-relative, as the docx tests read fixtures
    expect(css).toMatch(/\.draw-dialog footer\[hidden\]\s*\{[^}]*display:\s*none/);
  });

  it('shows exactly one footer row at a time', () => {
    const { canvas } = showDrawPanel({});
    const rows = () => [...document.querySelectorAll('.draw-dialog footer')];
    expect(rows().filter((r) => !r.hidden)).toHaveLength(1);

    draw(canvas, [[1, 1], [2, 2]]);
    click(document.querySelector('.draw-cancel'));
    const visible = rows().filter((r) => !r.hidden);
    expect(visible).toHaveLength(1);
    expect(visible[0].classList.contains('draw-confirm')).toBe(true);

    click(document.querySelector('.draw-keep'));
    expect(rows().filter((r) => !r.hidden)).toHaveLength(1);
    expect(rows().filter((r) => !r.hidden)[0].classList.contains('draw-confirm')).toBe(false);
  });

  it('restores focus to whatever was focused before it opened', () => {
    const before = document.createElement('button');
    document.body.appendChild(before);
    before.focus();
    const { close } = showDrawPanel({});
    close();
    expect(document.activeElement).toBe(before);
  });

  it('stops listening for keys once closed', () => {
    const { close } = showDrawPanel({});
    close();
    expect(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))).not.toThrow();
    expect(document.querySelector('.draw-backdrop')).toBeNull();
  });
});

describe('draw panel shape tools', () => {
  it('offers every shape tool in the toolbar', () => {
    showDrawPanel({});
    for (const id of ['select', 'pen', 'highlight', 'erase', 'line', 'arrow', 'rect', 'round-rect', 'ellipse']) {
      expect(document.querySelector(`.draw-tool[data-tool="${id}"]`)).toBeTruthy();
    }
  });

  it('drags out a shape of the chosen kind', () => {
    const { canvas, state } = showDrawPanel({});
    pickTool('ellipse');
    draw(canvas, [[10, 10], [60, 40]]);
    expect(state.items).toHaveLength(1);
    expect(state.items[0].kind).toBe('ellipse');
  });

  it('leaves nothing behind when a shape click never drags', () => {
    const { canvas, saveButton, state } = showDrawPanel({});
    pickTool('rect');
    draw(canvas, [[20, 20]]);
    expect(state.items).toHaveLength(0);
    expect(saveButton.disabled).toBe(true);
  });

  it('squares a rectangle when Shift is held', () => {
    const { canvas, state } = showDrawPanel({});
    pickTool('rect');
    draw(canvas, [[0, 0], [80, 15]], { shift: true });
    const item = state.items[0];
    expect(Math.abs(item.x1 - item.x0)).toBe(Math.abs(item.y1 - item.y0));
  });

  it('snaps a line to 45° when Shift is held', () => {
    const { canvas, state } = showDrawPanel({});
    pickTool('line');
    draw(canvas, [[0, 0], [90, 7]], { shift: true });
    expect(state.items[0].y1).toBeCloseTo(0, 5);
  });

  it('draws a straight pen stroke while Shift is held', () => {
    const { canvas, state } = showDrawPanel({});
    pointer(canvas, 'pointerdown', 0, 0);
    pointer(canvas, 'pointermove', 20, 35);
    pointer(canvas, 'pointermove', 60, 3, { shift: true });
    pointer(canvas, 'pointerup', 60, 3, { shift: true });
    expect(state.items[0].points).toHaveLength(2);
  });

  it('has no polygon tool', () => {
    showDrawPanel({});
    expect(document.querySelector('.draw-tool[data-tool="polygon"]')).toBeNull();
    expect(document.querySelector('.draw-sides')).toBeNull();
  });

  it('drags out an arrow, snapping its angle with Shift', () => {
    const { canvas, state } = showDrawPanel({});
    pickTool('arrow');
    draw(canvas, [[0, 0], [80, 6]], { shift: true });
    expect(state.items[0].kind).toBe('arrow');
    expect(state.items[0].y1).toBeCloseTo(0, 5);
  });
});

// The width is dragged on one slider now, not picked from three presets.
function setSize(value) {
  const input = document.querySelector('.draw-size-range');
  input.value = String(value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('draw panel brush sizing', () => {
  it('lays down the width dragged on the slider', () => {
    const { canvas, state } = showDrawPanel({});
    setSize(8);
    draw(canvas, [[0, 0], [10, 10]]);
    expect(state.items[0].width).toBe(8);
  });

  it('offers the full continuous range, not three steps', () => {
    showDrawPanel({});
    const input = document.querySelector('.draw-size-range');
    expect(input.type).toBe('range');
    expect(Number(input.min)).toBe(1);
    expect(Number(input.max)).toBe(40);
    setSize(17); // a value no preset button ever offered
    const { canvas, state } = showDrawPanel({});
    setSize(17);
    draw(canvas, [[0, 0], [10, 10]]);
    expect(state.items[0].width).toBe(17);
  });

  it('scales the eraser and the highlighter past the nominal width', () => {
    const eraser = showDrawPanel({});
    pickTool('erase');
    setSize(4);
    draw(eraser.canvas, [[0, 0], [10, 10]]);
    expect(eraser.state.items[0].width).toBe(12); // 4 x 3

    const marker = showDrawPanel({});
    pickTool('highlight');
    setSize(4);
    draw(marker.canvas, [[0, 0], [10, 10]]);
    expect(marker.state.items[0].width).toBe(20); // 4 x 5
    expect(marker.state.items[0].mode).toBe('highlight');
  });

  it('previews the real laid-down width in the slider dot', () => {
    showDrawPanel({});
    const dot = document.querySelector('.draw-size .draw-width-dot');
    setSize(6);
    expect(dot.style.width).toBe('6px');
    pickTool('erase'); // eraser lays down 3x, and the dot must not lie about it
    setSize(6);
    expect(dot.style.width).toBe('18px');
  });

  // The reported bug: changing the size gave no feedback at the pointer. The
  // panel hides the OS cursor for brush tools and paints its own ring instead.
  it('hides the OS cursor only for brush tools, so the ring can stand in', () => {
    const { canvas } = showDrawPanel({});
    expect(canvas.classList.contains('brush')).toBe(true); // pen is the default
    pickTool('highlight');
    expect(canvas.classList.contains('brush')).toBe(true);
    pickTool('erase');
    expect(canvas.classList.contains('brush')).toBe(true);
    pickTool('rect');
    expect(canvas.classList.contains('brush')).toBe(false);
    pickTool('select');
    expect(canvas.classList.contains('brush')).toBe(false);
  });

  it('tracks the pointer without a button held, so the ring can follow it', () => {
    const { canvas, state } = showDrawPanel({});
    pointer(canvas, 'pointermove', 40, 40);
    pointer(canvas, 'pointermove', 90, 70);
    expect(state.items).toHaveLength(0); // hovering must never draw
  });

  it('keeps the size ring out of the exported image', async () => {
    let exported = null;
    const { canvas, saveButton } = showDrawPanel({
      exportBlob: async (items) => { exported = items; return new Blob(['png'], { type: 'image/png' }); },
    });
    draw(canvas, [[0, 0], [10, 10]]);
    pointer(canvas, 'pointermove', 55, 55); // ring is showing
    click(saveButton);
    await vi.waitFor(() => expect(exported).not.toBeNull());
    expect(exported).toHaveLength(1);          // just the stroke
    expect(exported[0].kind).toBe('stroke');
  });
});

describe('draw panel pasted photos', () => {
  it('places a pasted image, fitted and centred, and selects it', async () => {
    const { state } = showDrawPanel({ loadImage: fakeLoadImage });
    pasteImage();
    await vi.waitFor(() => expect(state.items).toHaveLength(1));
    const item = state.items[0];
    expect(item.kind).toBe('image');
    // 400x200 fitted into 60% of the 960x560 fallback canvas keeps its ratio.
    expect(item.width / item.height).toBeCloseTo(2, 5);
    expect(item.width).toBeLessThanOrEqual(960 * 0.6);
    expect(document.querySelector('.draw-tool-select').classList.contains('active')).toBe(true);
  });

  it('enables Save once a photo is pasted, even with no strokes', async () => {
    const { saveButton, state } = showDrawPanel({ loadImage: fakeLoadImage });
    expect(saveButton.disabled).toBe(true);
    pasteImage();
    await vi.waitFor(() => expect(state.items).toHaveLength(1));
    expect(saveButton.disabled).toBe(false);
  });

  it('ignores a paste that carries no image', () => {
    const { state } = showDrawPanel({ loadImage: fakeLoadImage });
    const ev = new Event('paste', { bubbles: true, cancelable: true });
    ev.clipboardData = { items: [{ type: 'text/plain', getAsFile: () => null }] };
    document.dispatchEvent(ev);
    expect(state.items).toHaveLength(0);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('moves a pasted photo by dragging it', async () => {
    const { canvas, state } = showDrawPanel({ loadImage: fakeLoadImage });
    pasteImage();
    await vi.waitFor(() => expect(state.items).toHaveLength(1));
    const before = { ...state.items[0] };
    const midX = before.x + before.width / 2;
    const midY = before.y + before.height / 2;
    draw(canvas, [[midX, midY], [midX + 30, midY + 12]]);
    expect(state.items[0].x).toBe(before.x + 30);
    expect(state.items[0].y).toBe(before.y + 12);
    expect(state.items[0].width).toBe(before.width); // a move must not resize
  });

  it('resizes a pasted photo by dragging a corner handle', async () => {
    const { canvas, state } = showDrawPanel({ loadImage: fakeLoadImage });
    pasteImage();
    await vi.waitFor(() => expect(state.items).toHaveLength(1));
    const before = { ...state.items[0] };
    const seX = before.x + before.width;
    const seY = before.y + before.height;
    draw(canvas, [[seX, seY], [seX - 100, seY - 50]]);
    expect(state.items[0].width).toBeCloseTo(before.width - 100, 5);
    expect(state.items[0].height).toBeCloseTo(before.height - 50, 5);
    expect(state.items[0].x).toBe(before.x); // the opposite corner stays pinned
  });

  it('keeps the photo aspect ratio while resizing with Shift', async () => {
    const { canvas, state } = showDrawPanel({ loadImage: fakeLoadImage });
    pasteImage();
    await vi.waitFor(() => expect(state.items).toHaveLength(1));
    const before = { ...state.items[0] };
    const seX = before.x + before.width;
    const seY = before.y + before.height;
    draw(canvas, [[seX, seY], [seX - 100, seY - 5]], { shift: true });
    const after = state.items[0];
    expect(after.width / after.height).toBeCloseTo(before.width / before.height, 5);
  });

  it('undoes a resize in a single step', async () => {
    const { canvas, state } = showDrawPanel({ loadImage: fakeLoadImage });
    pasteImage();
    await vi.waitFor(() => expect(state.items).toHaveLength(1));
    const before = { ...state.items[0] };
    const seX = before.x + before.width;
    const seY = before.y + before.height;
    draw(canvas, [[seX, seY], [seX - 20, seY - 10], [seX - 60, seY - 30]]);
    click(document.querySelector('.draw-undo'));
    expect(state.items[0].width).toBe(before.width);
    expect(state.items[0].height).toBe(before.height);
  });

  it('deselects on Escape instead of closing the panel', async () => {
    const { state } = showDrawPanel({ loadImage: fakeLoadImage });
    pasteImage();
    await vi.waitFor(() => expect(state.items).toHaveLength(1));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.draw-backdrop')).toBeTruthy();
    // A second Escape, with nothing selected, asks to discard.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.draw-confirm').hidden).toBe(false);
  });

  it('deletes the selected photo with Delete', async () => {
    const { state } = showDrawPanel({ loadImage: fakeLoadImage });
    pasteImage();
    await vi.waitFor(() => expect(state.items).toHaveLength(1));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    expect(state.items).toHaveLength(0);
  });

  it('clicking empty canvas with Select drops the selection without drawing', async () => {
    const { canvas, state } = showDrawPanel({ loadImage: fakeLoadImage });
    pasteImage();
    await vi.waitFor(() => expect(state.items).toHaveLength(1));
    draw(canvas, [[2, 2], [4, 4]]); // Select tool is active after a paste
    expect(state.items).toHaveLength(1); // no stroke was created
  });
});

describe('draw panel over a photo (Edit photo)', () => {
  // jsdom lays nothing out, so the canvas takes the panel's 960 x 560 fallback size.
  const photoOf = (width, height) => async () => ({ naturalWidth: width, naturalHeight: height });
  const tall = { src: 'data:image/jpeg;base64,AA', name: 'Tall page.jpg', mime: 'image/jpeg' };
  const wheel = (el, deltaY, opts = {}) => {
    const ev = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true, ...opts });
    el.dispatchEvent(ev);
    return ev;
  };

  it('opens as "Edit photo", with Save and a zoom bar', async () => {
    const { ready } = showDrawPanel({ photo: tall, loadImage: photoOf(1280, 12000) });
    await ready;
    expect(document.querySelector('#draw-title').textContent).toBe('Edit photo');
    expect(document.querySelector('.draw-save').textContent).toBe('Save');
    expect(document.querySelector('.draw-dialog').classList.contains('draw-photo-mode')).toBe(true);
    expect(document.querySelector('.draw-zoom')).toBeTruthy();
    expect(document.querySelector('.draw-photo').getAttribute('src')).toBe(tall.src);
  });

  it('a blank drawing has neither the photo layer nor the zoom bar', () => {
    showDrawPanel({});
    expect(document.querySelector('.draw-photo')).toBeNull();
    expect(document.querySelector('.draw-zoom')).toBeNull();
    expect(document.querySelector('#draw-title').textContent).toBe('Draw');
  });

  it('takes no ink until the photo has loaded', () => {
    const { canvas, state } = showDrawPanel({ photo: tall, loadImage: () => new Promise(() => {}) });
    draw(canvas, [[10, 10], [40, 40]]);
    expect(state.items).toHaveLength(0);
    expect(document.querySelector('.draw-status').textContent).toMatch(/opening the photo/i);
  });

  it('fits a long capture to the width, contains a photo, and never enlarges one', async () => {
    const size = () => {
      const img = document.querySelector('.draw-photo');
      return [Math.round(parseFloat(img.style.width)), Math.round(parseFloat(img.style.height))];
    };
    await showDrawPanel({ photo: tall, loadImage: photoOf(1280, 12000) }).ready;
    expect(size()).toEqual([960, 9000]);
    await showDrawPanel({ photo: tall, loadImage: photoOf(1600, 1000) }).ready;
    expect(size()).toEqual([896, 560]);
    await showDrawPanel({ photo: tall, loadImage: photoOf(200, 100) }).ready;
    expect(size()).toEqual([200, 100]);
  });

  it('shows a scrollbar for a long capture', async () => {
    await showDrawPanel({ photo: tall, loadImage: photoOf(1280, 12000) }).ready;
    await vi.waitFor(() => expect(document.querySelector('.draw-scrollbar.vertical').hidden).toBe(false));
    expect(document.querySelector('.draw-scrollbar.horizontal').hidden).toBe(true);
  });

  it('scrolls with the wheel, and draws where the pointer is on the scrolled photo', async () => {
    const { canvas, state, ready, view } = showDrawPanel({ photo: tall, loadImage: photoOf(1280, 12000) });
    await ready;
    const ev = wheel(document.querySelector('.draw-surface'), 300);
    expect(ev.defaultPrevented).toBe(true); // the page behind must not scroll instead
    expect(view.y).toBe(-300);
    draw(canvas, [[10, 10], [40, 10]]);
    expect(state.items[0].points[0]).toEqual({ x: 10, y: 310 });
  });

  it('zooms with Ctrl+wheel and the zoom buttons, and Ctrl+0 goes back', async () => {
    const { ready, view } = showDrawPanel({ photo: tall, loadImage: photoOf(1280, 12000) });
    await ready;
    wheel(document.querySelector('.draw-surface'), -100, { ctrlKey: true });
    expect(view.zoom).toBeCloseTo(1.15);
    click(document.querySelector('.draw-zoom-in'));
    expect(view.zoom).toBeCloseTo(1.15 * 1.15);
    await vi.waitFor(() => expect(document.querySelector('.draw-zoom-level').textContent).toBe('132%'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '0', ctrlKey: true, bubbles: true, cancelable: true }));
    expect(view.zoom).toBe(1);
  });

  it('leaves the page keys to the size slider', async () => {
    const { ready, view } = showDrawPanel({ photo: tall, loadImage: photoOf(1280, 12000) });
    await ready;
    const slider = document.querySelector('.draw-size-range');
    slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    expect(view.y).toBe(0);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    expect(view.y).toBe(560 - 9000);
  });

  it('saves the photo at its own size and format, under its own name', async () => {
    const el = { naturalWidth: 1280, naturalHeight: 12000 };
    const exportBlob = vi.fn(async () => new Blob(['jpg'], { type: 'image/jpeg' }));
    const onSave = vi.fn();
    const { canvas, ready } = showDrawPanel({ photo: tall, loadImage: async () => el, exportBlob, onSave });
    await ready;
    draw(canvas, [[10, 10], [40, 40]]);
    click(document.querySelector('.draw-save'));
    await vi.waitFor(() => expect(onSave).toHaveBeenCalled());
    const [items, width, height, scale, options] = exportBlob.mock.calls[0];
    expect(items).toHaveLength(1);
    expect([width, height]).toEqual([960, 9000]);
    expect(scale).toBeCloseTo(1280 / 960);
    expect(options).toEqual({ background: el, type: 'image/jpeg' });
    const file = onSave.mock.calls[0][0];
    expect(file.name).toBe('Tall page.jpg');
    expect(file.type).toBe('image/jpeg');
  });

  it('says so when the photo cannot be opened, and offers nothing to save', async () => {
    const { ready, saveButton } = showDrawPanel({ photo: tall, loadImage: async () => { throw new Error('bad'); } });
    await ready;
    expect(document.querySelector('.draw-status').textContent).toBe('Could not open this photo.');
    expect(saveButton.disabled).toBe(true);
  });

  it('asks before discarding marks on the photo', async () => {
    const { canvas, ready } = showDrawPanel({ photo: tall, loadImage: photoOf(400, 300) });
    await ready;
    draw(canvas, [[300, 200], [320, 220]]);
    click(document.querySelector('.draw-cancel'));
    expect(document.querySelector('.draw-confirm span').textContent).toBe('Discard your changes to this photo?');
    expect(document.querySelector('.draw-keep').textContent).toBe('Keep editing');
  });

  it('a blank drawing ignores the wheel', () => {
    const { view } = showDrawPanel({});
    const ev = wheel(document.querySelector('.draw-surface'), 300);
    expect(ev.defaultPrevented).toBe(false);
    expect(view).toEqual({ zoom: 1, x: 0, y: 0 });
  });
});

describe('photo save format', () => {
  it('keeps JPEG and WebP, and saves anything else as PNG', () => {
    expect(photoOutputType({ mime: 'image/jpeg' })).toBe('image/jpeg');
    expect(photoOutputType({ mime: 'image/jpg' })).toBe('image/jpeg');
    expect(photoOutputType({ src: 'data:image/webp;base64,AA' })).toBe('image/webp');
    expect(photoOutputType({ src: 'data:image/png;base64,AA' })).toBe('image/png');
    expect(photoOutputType({ src: 'data:image/gif;base64,AA' })).toBe('image/png');
    expect(photoOutputType({})).toBe('image/png');
  });

  it('names the file for the photo, with the extension of what it now is', () => {
    expect(photoFileName('Tall page.jpg', 'image/jpeg')).toBe('Tall page.jpg');
    expect(photoFileName('pasted-image.png', 'image/webp')).toBe('pasted-image.webp');
    expect(photoFileName('animation.gif', 'image/png')).toBe('animation.png');
    expect(photoFileName('', 'image/png')).toBe('photo.png');
  });
});
