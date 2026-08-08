// Covers the Paint-style additions to the sketchpad: the image button, the
// wider shape set, fill, select/move/resize on anything, the size slider and
// the text tool. The original draw-panel.test.js keeps the pre-existing
// behaviour honest; this file is the new surface.
import { describe, it, expect, beforeEach } from 'vitest';
import { showDrawPanel } from '../src/app/draw-panel.js';

beforeEach(() => {
  document.body.innerHTML = '';
  HTMLCanvasElement.prototype.getContext = () => null; // jsdom has no 2D context
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
function click(el) { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
function pickTool(id) { click(document.querySelector(`.draw-tool[data-tool="${id}"]`)); }
function draw(canvas, points) {
  pointer(canvas, 'pointerdown', points[0][0], points[0][1]);
  for (const [x, y] of points.slice(1)) pointer(canvas, 'pointermove', x, y);
  const last = points[points.length - 1];
  pointer(canvas, 'pointerup', last[0], last[1]);
}
function setSize(panel, value) {
  panel.sizeInput.value = String(value);
  panel.sizeInput.dispatchEvent(new Event('input', { bubbles: true }));
}
function typeInto(editor, text) {
  editor.value = text;
  editor.dispatchEvent(new Event('input', { bubbles: true }));
}
const flush = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };
const fakeLoadImage = async () => ({ naturalWidth: 400, naturalHeight: 200, width: 400, height: 200 });
const okExport = async () => new Blob(['png'], { type: 'image/png' });

describe('image button', () => {
  // Pasting worked before this button existed, but nothing on screen said so.
  it('offers a visible control that opens a file picker', () => {
    showDrawPanel({});
    const button = document.querySelector('.draw-image');
    const input = document.querySelector('.draw-image-input');
    expect(button).toBeTruthy();
    expect(input.type).toBe('file');
    expect(input.accept).toBe('image/*');

    let opened = false;
    input.click = () => { opened = true; };
    click(button);
    expect(opened).toBe(true);
  });

  it('places the chosen file and selects it, exactly as a paste does', async () => {
    const panel = showDrawPanel({ loadImage: fakeLoadImage });
    const input = document.querySelector('.draw-image-input');
    Object.defineProperty(input, 'files', { value: [new Blob(['x'], { type: 'image/png' })] });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(panel.state.items).toHaveLength(1);
    expect(panel.state.items[0].kind).toBe('image');
    expect(document.querySelector('.draw-tool-select').classList.contains('active')).toBe(true);
  });
});

describe('shapes and fill', () => {
  it('draws each Paint-style shape the toolbar offers', () => {
    for (const kind of ['triangle', 'right-triangle', 'diamond', 'pentagon', 'hexagon', 'star']) {
      const panel = showDrawPanel({});
      pickTool(kind);
      draw(panel.canvas, [[10, 10], [60, 50]]);
      expect(panel.state.items[0].kind, kind).toBe(kind);
    }
  });

  it('records fill on the shape when the toggle is on', () => {
    const panel = showDrawPanel({});
    pickTool('rect');
    click(document.querySelector('.draw-fill'));
    draw(panel.canvas, [[10, 10], [60, 50]]);
    expect(panel.state.items[0].fill).toBe(true);
  });

  it('leaves a shape hollow by default', () => {
    const panel = showDrawPanel({});
    pickTool('ellipse');
    draw(panel.canvas, [[10, 10], [60, 50]]);
    expect(panel.state.items[0].fill).toBe(false);
  });

  it('disables the fill toggle for tools that enclose no area', () => {
    showDrawPanel({});
    const fill = document.querySelector('.draw-fill');
    pickTool('rect');
    expect(fill.disabled).toBe(false);
    pickTool('line');
    expect(fill.disabled).toBe(true);
    pickTool('pen');
    expect(fill.disabled).toBe(true);
  });

  // Pressing Fill while holding a non-filling tool is a request to draw a filled
  // shape, so it moves to one rather than appearing to do nothing.
  it('switches to a fillable tool when Fill is turned on', () => {
    showDrawPanel({});
    pickTool('pen');
    click(document.querySelector('.draw-fill'));
    expect(document.querySelector('.draw-tool-rect').classList.contains('active')).toBe(true);
  });
});

describe('select, move and resize anything', () => {
  it('selects and moves a shape, not only a photo', () => {
    const panel = showDrawPanel({});
    pickTool('rect');
    draw(panel.canvas, [[20, 20], [80, 60]]);
    pickTool('select');
    pointer(panel.canvas, 'pointerdown', 40, 40);
    pointer(panel.canvas, 'pointermove', 60, 70);
    pointer(panel.canvas, 'pointerup', 60, 70);
    const item = panel.state.items[0];
    expect(Math.min(item.x0, item.x1)).toBe(40); // moved by +20
    expect(Math.min(item.y0, item.y1)).toBe(50); // moved by +30
  });

  it('selects and moves a pen stroke', () => {
    const panel = showDrawPanel({});
    draw(panel.canvas, [[10, 10], [40, 40]]);
    pickTool('select');
    pointer(panel.canvas, 'pointerdown', 20, 20);
    pointer(panel.canvas, 'pointermove', 30, 20);
    pointer(panel.canvas, 'pointerup', 30, 20);
    expect(panel.state.items[0].points[0]).toEqual({ x: 20, y: 10 });
  });

  it('moves a highlighter stroke, but never an eraser stroke', () => {
    const panel = showDrawPanel({});
    pickTool('highlight');
    draw(panel.canvas, [[10, 10], [40, 40]]);
    pickTool('erase');
    draw(panel.canvas, [[60, 60], [90, 90]]);
    pickTool('select');

    pointer(panel.canvas, 'pointerdown', 20, 20);
    pointer(panel.canvas, 'pointermove', 25, 20);
    pointer(panel.canvas, 'pointerup', 25, 20);
    expect(panel.state.items[0].points[0]).toEqual({ x: 15, y: 10 });

    // An eraser stroke is a hole in the ink, not an object: there is nothing
    // meaningful to drag, so clicking one selects nothing.
    pointer(panel.canvas, 'pointerdown', 75, 75);
    pointer(panel.canvas, 'pointerup', 75, 75);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    expect(panel.state.items).toHaveLength(2);
  });

  it('moves a single-click dot, which has a zero-size box', () => {
    const panel = showDrawPanel({});
    pointer(panel.canvas, 'pointerdown', 30, 30);
    pointer(panel.canvas, 'pointerup', 30, 30);
    pickTool('select');
    pointer(panel.canvas, 'pointerdown', 30, 30);
    pointer(panel.canvas, 'pointermove', 45, 45);
    pointer(panel.canvas, 'pointerup', 45, 45);
    expect(panel.state.items[0].points).toEqual([{ x: 45, y: 45 }]);
  });

  it('resizes a shape from a corner handle', () => {
    const panel = showDrawPanel({});
    pickTool('rect');
    draw(panel.canvas, [[20, 20], [60, 60]]);
    pickTool('select');
    pointer(panel.canvas, 'pointerdown', 40, 40); // select it
    pointer(panel.canvas, 'pointerup', 40, 40);
    pointer(panel.canvas, 'pointerdown', 60, 60); // grab the SE handle
    pointer(panel.canvas, 'pointermove', 120, 100);
    pointer(panel.canvas, 'pointerup', 120, 100);
    const item = panel.state.items[0];
    expect(Math.abs(item.x1 - item.x0)).toBe(100);
    expect(Math.abs(item.y1 - item.y0)).toBe(80);
  });

  it('deletes whatever is selected, not just photos', () => {
    const panel = showDrawPanel({});
    pickTool('ellipse');
    draw(panel.canvas, [[20, 20], [80, 60]]);
    pickTool('select');
    pointer(panel.canvas, 'pointerdown', 40, 40);
    pointer(panel.canvas, 'pointerup', 40, 40);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    expect(panel.state.items).toHaveLength(0);
  });

  it('treats a whole drag as one undo step', () => {
    const panel = showDrawPanel({});
    pickTool('rect');
    draw(panel.canvas, [[20, 20], [80, 60]]);
    pickTool('select');
    pointer(panel.canvas, 'pointerdown', 40, 40);
    for (let i = 1; i <= 5; i++) pointer(panel.canvas, 'pointermove', 40 + i * 4, 40);
    pointer(panel.canvas, 'pointerup', 60, 40);
    click(document.querySelector('.draw-undo'));
    const item = panel.state.items[0];
    expect(Math.min(item.x0, item.x1)).toBe(20);
  });
});

describe('text tool', () => {
  it('opens an overlay editor where the canvas was clicked', () => {
    const panel = showDrawPanel({});
    pickTool('text');
    pointer(panel.canvas, 'pointerdown', 30, 45);
    expect(panel.textEditor.hidden).toBe(false);
    expect(panel.textEditor.style.left).toBe('30px');
    expect(panel.textEditor.style.top).toBe('45px');
  });

  it('commits the typed text as an item on blur', () => {
    const panel = showDrawPanel({});
    pickTool('text');
    pointer(panel.canvas, 'pointerdown', 10, 10);
    typeInto(panel.textEditor, 'hello owl');
    panel.textEditor.dispatchEvent(new Event('blur'));
    expect(panel.textEditor.hidden).toBe(true);
    expect(panel.state.items).toHaveLength(1);
    expect(panel.state.items[0]).toMatchObject({ kind: 'text', text: 'hello owl' });
  });

  // An abandoned click must not leave an invisible box behind, nor an undo step
  // that appears to do nothing.
  it('leaves nothing behind when the box is left empty', () => {
    const panel = showDrawPanel({});
    pickTool('text');
    pointer(panel.canvas, 'pointerdown', 10, 10);
    panel.textEditor.dispatchEvent(new Event('blur'));
    expect(panel.state.items).toHaveLength(0);
    expect(document.querySelector('.draw-undo').disabled).toBe(true);
    expect(panel.saveButton.disabled).toBe(true);
  });

  // Font size belongs next to the font, the way Paint has it — not folded into
  // the stroke slider, where nobody would think to look for it.
  it('sets the font size from the text bar', () => {
    const panel = showDrawPanel({});
    pickTool('text');
    const select = document.querySelector('.draw-text-size');
    expect(select).toBeTruthy();
    select.value = '48';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    pointer(panel.canvas, 'pointerdown', 10, 10);
    typeInto(panel.textEditor, 'big');
    panel.textEditor.dispatchEvent(new Event('blur'));
    expect(panel.state.items[0].size).toBe(48);
  });

  it('resizes the box being typed in, not only the next one', () => {
    const panel = showDrawPanel({});
    pickTool('text');
    pointer(panel.canvas, 'pointerdown', 10, 10);
    typeInto(panel.textEditor, 'grow me');
    const select = document.querySelector('.draw-text-size');
    select.value = '36';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(panel.textEditor.style.font).toContain('36px');
    panel.textEditor.dispatchEvent(new Event('blur'));
    expect(panel.state.items[0].size).toBe(36);
  });

  // The stroke slider is the stroke's, and says nothing about text.
  it('leaves the stroke width alone and hides it for the Text tool', () => {
    const panel = showDrawPanel({});
    setSize(panel, 6);
    pickTool('text');
    expect(panel.sizeInput.value).toBe('6'); // unchanged, not hijacked
    expect(document.querySelector('.draw-size').hidden).toBe(true);
    pickTool('pen');
    expect(document.querySelector('.draw-size').hidden).toBe(false);
    draw(panel.canvas, [[0, 0], [10, 10]]);
    expect(panel.state.items[0].width).toBe(6);
  });

  it('lets the keyboard reach the textarea instead of the canvas shortcuts', () => {
    const panel = showDrawPanel({});
    pickTool('text');
    pointer(panel.canvas, 'pointerdown', 10, 10);
    typeInto(panel.textEditor, 'draft');
    // Backspace would otherwise delete an item out from under the caret.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
    expect(panel.state.items).toHaveLength(1);
  });

  it('commits an open box before exporting', async () => {
    let saved = null;
    const panel = showDrawPanel({ exportBlob: okExport, onSave: (file) => { saved = file; } });
    pickTool('text');
    pointer(panel.canvas, 'pointerdown', 10, 10);
    typeInto(panel.textEditor, 'ship it');
    click(panel.saveButton);
    await flush();
    expect(saved).toBeTruthy();
  });

  it('reopens a committed box on double-click', () => {
    const panel = showDrawPanel({});
    pickTool('text');
    pointer(panel.canvas, 'pointerdown', 10, 10);
    typeInto(panel.textEditor, 'edit me');
    panel.textEditor.dispatchEvent(new Event('blur'));

    panel.canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 20, clientY: 20 }));
    expect(panel.textEditor.hidden).toBe(false);
    expect(panel.textEditor.value).toBe('edit me');
  });
});

describe('color palette', () => {
  // Five accent colors is a note-taking strip, not a drawing palette.
  it('offers Paint’s full two-row swatch grid', () => {
    showDrawPanel({});
    expect(document.querySelectorAll('.draw-color')).toHaveLength(20);
    expect(document.querySelector('.draw-palette')).toBeTruthy();
    for (const hex of ['#000000', '#ffffff', '#ed1c24', '#22b14c', '#a349a4']) {
      expect(document.querySelector(`.draw-color[data-color="${hex}"]`), hex).toBeTruthy();
    }
  });

  it('draws with a swatch that is picked', () => {
    const panel = showDrawPanel({});
    click(document.querySelector('.draw-color[data-color="#22b14c"]'));
    draw(panel.canvas, [[0, 0], [10, 10]]);
    expect(panel.state.items[0].color).toBe('#22b14c');
  });

  // The only control that can reach a color off the grid.
  it('draws with a custom color from the picker', () => {
    const panel = showDrawPanel({});
    const input = document.querySelector('.draw-custom-color input');
    expect(input.type).toBe('color');
    input.value = '#123456';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    draw(panel.canvas, [[0, 0], [10, 10]]);
    expect(panel.state.items[0].color).toBe('#123456');
  });
});

describe('text formatting', () => {
  function openBox(panel, x = 10, y = 10) {
    pickTool('text');
    pointer(panel.canvas, 'pointerdown', x, y);
  }
  function commit(panel) { panel.textEditor.dispatchEvent(new Event('blur')); }

  it('shows the text toolbar only while the Text tool is live', () => {
    showDrawPanel({});
    const bar = document.querySelector('.draw-text-bar');
    expect(bar.hidden).toBe(true);
    pickTool('text');
    expect(bar.hidden).toBe(false);
    pickTool('pen');
    expect(bar.hidden).toBe(true);
  });

  it('records bold, italic and underline on the box being typed', () => {
    const panel = showDrawPanel({});
    openBox(panel);
    click(document.querySelector('.draw-bold'));
    click(document.querySelector('.draw-underline'));
    typeInto(panel.textEditor, 'styled');
    commit(panel);
    expect(panel.state.items[0]).toMatchObject({ text: 'styled', bold: true, underline: true, italic: false });
  });

  it('restyles the box live rather than only the next one', () => {
    const panel = showDrawPanel({});
    openBox(panel);
    typeInto(panel.textEditor, 'watch me');
    click(document.querySelector('.draw-italic'));
    expect(panel.textEditor.style.font).toContain('italic');
    commit(panel);
    expect(panel.state.items[0].italic).toBe(true);
  });

  it('changes the font family', () => {
    const panel = showDrawPanel({});
    openBox(panel);
    const select = document.querySelector('.draw-font');
    select.value = 'mono';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    typeInto(panel.textEditor, 'code');
    commit(panel);
    expect(panel.state.items[0].font).toBe('mono');
  });

  // Paint keeps the toolbar state between boxes; so does this.
  it('carries the styling to the next box', () => {
    const panel = showDrawPanel({});
    openBox(panel);
    click(document.querySelector('.draw-bold'));
    typeInto(panel.textEditor, 'first');
    commit(panel);
    openBox(panel, 60, 60);
    typeInto(panel.textEditor, 'second');
    commit(panel);
    expect(panel.state.items[1].bold).toBe(true);
  });
});

describe('rotation', () => {
  function selectFirst(panel, x, y) {
    pickTool('select');
    pointer(panel.canvas, 'pointerdown', x, y);
    pointer(panel.canvas, 'pointerup', x, y);
  }

  it('rotates the selected object by dragging the grip', () => {
    const panel = showDrawPanel({});
    pickTool('rect');
    draw(panel.canvas, [[20, 20], [120, 120]]); // centre (70,70), grip at (70, -2)
    selectFirst(panel, 70, 70);
    pointer(panel.canvas, 'pointerdown', 70, -2);
    pointer(panel.canvas, 'pointermove', 142, 70); // straight right of centre
    pointer(panel.canvas, 'pointerup', 142, 70);
    expect(panel.state.items[0].angle).toBeCloseTo(Math.PI / 2, 2);
  });

  it('snaps to 15 degrees with Shift held', () => {
    const panel = showDrawPanel({});
    pickTool('rect');
    draw(panel.canvas, [[20, 20], [120, 120]]);
    selectFirst(panel, 70, 70);
    pointer(panel.canvas, 'pointerdown', 70, -2);
    pointer(panel.canvas, 'pointermove', 140, 66, { shift: true });
    pointer(panel.canvas, 'pointerup', 140, 66, { shift: true });
    const step = Math.PI / 12;
    expect(panel.state.items[0].angle / step).toBeCloseTo(Math.round(panel.state.items[0].angle / step), 6);
  });

  it('is one undo step for the whole rotation drag', () => {
    const panel = showDrawPanel({});
    pickTool('rect');
    draw(panel.canvas, [[20, 20], [120, 120]]);
    selectFirst(panel, 70, 70);
    pointer(panel.canvas, 'pointerdown', 70, -2);
    for (let i = 1; i <= 6; i++) pointer(panel.canvas, 'pointermove', 70 + i * 10, 0);
    pointer(panel.canvas, 'pointerup', 130, 0);
    click(document.querySelector('.draw-undo'));
    expect(panel.state.items[0].angle || 0).toBe(0);
  });

  // A rotated shape must be grabbable where it looks, not where its unrotated
  // box happens to sit.
  it('hit-tests a rotated object in its own frame', () => {
    const panel = showDrawPanel({});
    pickTool('rect');
    draw(panel.canvas, [[20, 60], [220, 100]]); // a wide, short bar
    selectFirst(panel, 120, 80);
    pointer(panel.canvas, 'pointerdown', 120, 38); // the grip
    pointer(panel.canvas, 'pointermove', 120 + 42, 80, { shift: true }); // quarter turn
    pointer(panel.canvas, 'pointerup', 120 + 42, 80, { shift: true });

    pickTool('select');
    // Now upright: inside the rotated bar, but OUTSIDE its unrotated box.
    pointer(panel.canvas, 'pointerdown', 120, 20);
    pointer(panel.canvas, 'pointerup', 120, 20);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    expect(panel.state.items).toHaveLength(0);
  });
});

