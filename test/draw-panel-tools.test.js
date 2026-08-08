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

describe('text color is its own control', () => {
  const setTextColor = (hex) => click(document.querySelector(`.draw-text-color-row [data-preset="${hex}"]`));

  it('offers preset text colours in the text bar', () => {
    showDrawPanel({});
    expect(document.querySelectorAll('.draw-text-color-row .draw-preset').length).toBeGreaterThan(5);
    expect(document.querySelector('.draw-text-color-row input[type="color"]')).toBeNull();
  });

  it('colors the text with it', () => {
    const panel = showDrawPanel({});
    pickTool('text');
    setTextColor('#ed1c24');
    pointer(panel.canvas, 'pointerdown', 10, 10);
    typeInto(panel.textEditor, 'red words');
    panel.textEditor.dispatchEvent(new Event('blur'));
    expect(panel.state.items[0].color).toBe('#ed1c24');
  });

  it('recolors the box being typed in', () => {
    const panel = showDrawPanel({});
    pickTool('text');
    pointer(panel.canvas, 'pointerdown', 10, 10);
    typeInto(panel.textEditor, 'watch me');
    setTextColor('#22b14c');
    expect(panel.textEditor.style.color).toBeTruthy();
    panel.textEditor.dispatchEvent(new Event('blur'));
    expect(panel.state.items[0].color).toBe('#22b14c');
  });

  // Picking a shape colour to draw an arrow must not silently restyle the
  // caption typed next — that is the whole reason text has its own control.
  it('is independent of the shape palette in both directions', () => {
    const panel = showDrawPanel({});
    setTextColor('#3f48cc');
    click(document.querySelector('.draw-color[data-color="#ed1c24"]')); // shape red
    pickTool('text');
    pointer(panel.canvas, 'pointerdown', 10, 10);
    typeInto(panel.textEditor, 'still blue');
    panel.textEditor.dispatchEvent(new Event('blur'));
    expect(panel.state.items[0].color).toBe('#3f48cc');

    pickTool('rect');
    draw(panel.canvas, [[40, 40], [90, 80]]);
    expect(panel.state.items[1].color).toBe('#ed1c24'); // shape kept its own
  });
});

// The reported sequence: start typing, reach for a text-bar control, and the
// blur that focus change causes would commit the box — so by the time the
// colour was chosen there was no box left to apply it to, and dismissing the
// picker meant clicking the canvas, which lost the selection too.
describe('the text bar does not close the box being typed in', () => {
  function openAndType(panel, text = 'keep me open') {
    pickTool('text');
    pointer(panel.canvas, 'pointerdown', 10, 10);
    typeInto(panel.textEditor, text);
  }
  // Focusing a control fires blur on the textarea; jsdom needs it dispatched.
  function focusControl(el) {
    el.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    panelBlur();
  }
  let currentEditor = null;
  function panelBlur() { currentEditor.dispatchEvent(new Event('blur')); }

  // Preset swatches preventDefault on mousedown so the caret never leaves at
  // all; this pins that, and that the colour still lands on the open box.
  it('survives picking a colour preset, and applies it', () => {
    const panel = showDrawPanel({});
    currentEditor = panel.textEditor;
    openAndType(panel);
    click(document.querySelector('.draw-text-color-row [data-preset="#a349a4"]'));
    expect(panel.textEditor.hidden).toBe(false); // still open

    panel.textEditor.dispatchEvent(new Event('blur'));
    expect(panel.state.items).toHaveLength(1);
    expect(panel.state.items[0]).toMatchObject({ text: 'keep me open', color: '#a349a4' });
  });

  it('survives the font and size selects', () => {
    const panel = showDrawPanel({});
    currentEditor = panel.textEditor;
    openAndType(panel, 'styled');
    const size = document.querySelector('.draw-text-size');
    focusControl(size);
    expect(panel.textEditor.hidden).toBe(false);
    size.value = '48';
    size.dispatchEvent(new Event('change', { bubbles: true }));

    const font = document.querySelector('.draw-font');
    focusControl(font);
    font.value = 'serif';
    font.dispatchEvent(new Event('change', { bubbles: true }));

    panel.textEditor.dispatchEvent(new Event('blur'));
    expect(panel.state.items[0]).toMatchObject({ text: 'styled', size: 48, font: 'serif' });
  });

  // The hold must not leak: clicking away still finishes the box.
  it('still commits when the click lands outside the text bar', () => {
    const panel = showDrawPanel({});
    currentEditor = panel.textEditor;
    openAndType(panel, 'done now');
    focusControl(document.querySelector('.draw-text-size')); // a select DOES take focus
    expect(panel.textEditor.hidden).toBe(false);

    document.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); // elsewhere
    panel.textEditor.dispatchEvent(new Event('blur'));
    expect(panel.textEditor.hidden).toBe(true);
    expect(panel.state.items[0].text).toBe('done now');
  });
});

// jsdom has no pointer capture at all, which is exactly why this bug shipped:
// the panel called setPointerCapture on every pointerdown but only released it
// when a drag had been started. The Text tool and a click on empty canvas both
// return without one, so the canvas kept the pointer for good — and a captured
// canvas swallows every later click, including the one meant to put the caret
// in the text box it had just opened.
function trackPointerCapture(canvas) {
  const held = new Set();
  canvas.setPointerCapture = (id) => held.add(id);
  canvas.releasePointerCapture = (id) => held.delete(id);
  canvas.hasPointerCapture = (id) => held.has(id);
  return held;
}

describe('the canvas never keeps the pointer captured', () => {
  it('releases it after placing a text box', () => {
    const panel = showDrawPanel({});
    const held = trackPointerCapture(panel.canvas);
    pickTool('text');
    pointer(panel.canvas, 'pointerdown', 20, 20);
    pointer(panel.canvas, 'pointerup', 20, 20);
    expect(held.size).toBe(0);
  });

  it('releases it after clicking empty canvas with Select', () => {
    const panel = showDrawPanel({});
    const held = trackPointerCapture(panel.canvas);
    pickTool('select');
    pointer(panel.canvas, 'pointerdown', 400, 300); // nothing there
    pointer(panel.canvas, 'pointerup', 400, 300);
    expect(held.size).toBe(0);
  });

  it('still releases it after a real drag', () => {
    const panel = showDrawPanel({});
    const held = trackPointerCapture(panel.canvas);
    pickTool('rect');
    draw(panel.canvas, [[10, 10], [60, 50]]);
    expect(held.size).toBe(0);
    expect(panel.state.items).toHaveLength(1); // and the drag still worked
  });

  it('reopens a committed text box for editing from the Select tool', () => {
    const panel = showDrawPanel({});
    trackPointerCapture(panel.canvas);
    pickTool('text');
    pointer(panel.canvas, 'pointerdown', 20, 20);
    typeInto(panel.textEditor, 'first pass');
    panel.textEditor.dispatchEvent(new Event('blur'));

    pickTool('select');
    pointer(panel.canvas, 'pointerdown', 30, 30);
    pointer(panel.canvas, 'pointerup', 30, 30);
    panel.canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 30, clientY: 30 }));
    expect(panel.textEditor.hidden).toBe(false);
    expect(panel.textEditor.value).toBe('first pass');

    typeInto(panel.textEditor, 'second pass');
    panel.textEditor.dispatchEvent(new Event('blur'));
    expect(panel.state.items).toHaveLength(1); // edited, not duplicated
    expect(panel.state.items[0].text).toBe('second pass');
  });
});

// jsdom hands back no 2D context, so nothing in this suite had ever checked what
// actually gets PAINTED. A recording context makes the doubled-text bug visible:
// while a box is open for editing, its overlay is already showing the text, and
// replay was drawing the same item underneath it as well.
function recordingContext() {
  const calls = [];
  const ctx = new Proxy({ calls }, {
    get(target, prop) {
      if (prop === 'calls') return calls;
      if (prop === 'measureText') return (s) => ({ width: String(s).length * 8 });
      return (...args) => { calls.push([prop, ...args]); };
    },
    set() { return true; },
  });
  return ctx;
}
const painted = (ctx) => ctx.calls.filter((c) => c[0] === 'fillText').map((c) => c[1]);
const nextFrame = () => new Promise((resolve) => setTimeout(resolve, 24));

describe('the canvas does not paint the box being edited', () => {
  it('draws committed text, but not while its editor is open over it', async () => {
    const ctx = recordingContext();
    HTMLCanvasElement.prototype.getContext = () => ctx;
    const panel = showDrawPanel({});

    pickTool('text');
    pointer(panel.canvas, 'pointerdown', 20, 20);
    typeInto(panel.textEditor, 'ghosted');
    panel.textEditor.dispatchEvent(new Event('blur'));
    await nextFrame();
    expect(painted(ctx)).toContain('ghosted'); // committed: the canvas owns it

    ctx.calls.length = 0;
    pickTool('select');
    pointer(panel.canvas, 'pointerdown', 30, 30);
    pointer(panel.canvas, 'pointerup', 30, 30);
    panel.canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 30, clientY: 30 }));
    await nextFrame();
    // Re-opened: the overlay is the picture now, so the canvas must stay clear
    // of it or the same words render twice, offset by the editor's border.
    expect(painted(ctx)).not.toContain('ghosted');

    ctx.calls.length = 0;
    panel.textEditor.dispatchEvent(new Event('blur'));
    await nextFrame();
    expect(painted(ctx)).toContain('ghosted'); // handed back on commit
  });

  it('keeps painting every other item while one is being edited', async () => {
    const ctx = recordingContext();
    HTMLCanvasElement.prototype.getContext = () => ctx;
    const panel = showDrawPanel({});

    pickTool('text');
    pointer(panel.canvas, 'pointerdown', 20, 20);
    typeInto(panel.textEditor, 'first');
    panel.textEditor.dispatchEvent(new Event('blur'));
    pointer(panel.canvas, 'pointerdown', 20, 120);
    typeInto(panel.textEditor, 'second');
    panel.textEditor.dispatchEvent(new Event('blur'));

    ctx.calls.length = 0;
    panel.canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 25, clientY: 25 }));
    await nextFrame();
    const drawn = painted(ctx);
    expect(drawn).not.toContain('first');  // the one being edited
    expect(drawn).toContain('second');     // its neighbour is untouched
  });
});

// Stacking order decides whether a caption sits over a photo or under it, and
// it is the Select tool's job: these act on whatever is selected.
describe('bring to front and send to back', () => {
  function twoShapes(panel) {
    pickTool('rect');
    draw(panel.canvas, [[20, 20], [120, 120]]);   // index 0
    pickTool('ellipse');
    draw(panel.canvas, [[40, 40], [140, 140]]);   // index 1, on top
  }
  const selectAt = (panel, x, y) => {
    pickTool('select');
    pointer(panel.canvas, 'pointerdown', x, y);
    pointer(panel.canvas, 'pointerup', x, y);
  };
  const kinds = (panel) => panel.state.items.map((i) => i.kind);

  it('is disabled until something is selected', () => {
    const panel = showDrawPanel({});
    twoShapes(panel);
    expect(document.querySelector('.draw-front').disabled).toBe(true);
    selectAt(panel, 130, 130); // only the ellipse reaches here
    expect(document.querySelector('.draw-front').disabled).toBe(false);
    expect(document.querySelector('.draw-back').disabled).toBe(false);
  });

  it('sends the selected object behind the others', () => {
    const panel = showDrawPanel({});
    twoShapes(panel);
    expect(kinds(panel)).toEqual(['rect', 'ellipse']);
    selectAt(panel, 130, 130);
    click(document.querySelector('.draw-back'));
    expect(kinds(panel)).toEqual(['ellipse', 'rect']);
  });

  it('brings the selected object above the others', () => {
    const panel = showDrawPanel({});
    twoShapes(panel);
    selectAt(panel, 25, 25); // the rect, which the ellipse does not cover
    click(document.querySelector('.draw-front'));
    expect(kinds(panel)).toEqual(['ellipse', 'rect']);
  });

  // Dropping the selection here would leave the handles on whichever object
  // slid into the vacated slot.
  it('keeps the selection on the object that moved', () => {
    const panel = showDrawPanel({});
    twoShapes(panel);
    selectAt(panel, 130, 130);
    click(document.querySelector('.draw-back'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    expect(kinds(panel)).toEqual(['rect']); // the ellipse went, not the rect
  });

  it('is one undo step', () => {
    const panel = showDrawPanel({});
    twoShapes(panel);
    selectAt(panel, 130, 130);
    click(document.querySelector('.draw-back'));
    click(document.querySelector('.draw-undo'));
    expect(kinds(panel)).toEqual(['rect', 'ellipse']);
  });

  it('does nothing when the object is already where it is asked to go', () => {
    const panel = showDrawPanel({});
    twoShapes(panel);
    selectAt(panel, 130, 130);           // the ellipse, already on top
    click(document.querySelector('.draw-front'));
    expect(kinds(panel)).toEqual(['rect', 'ellipse']);
    expect(document.querySelector('.draw-undo').disabled).toBe(false);
    click(document.querySelector('.draw-undo'));
    expect(kinds(panel)).toEqual(['rect', 'ellipse']); // no wasted history step
  });
});

// Text dropped on a photo or a map is often unreadable whatever colour it is;
// a colour filled behind the words is the fix. Preset swatches, not an OS dialog.
describe('fill behind text', () => {
  const openBox = (panel) => { pickTool('text'); pointer(panel.canvas, 'pointerdown', 20, 20); };
  const commit = (panel) => panel.textEditor.dispatchEvent(new Event('blur'));
  const pickFill = (hex) => click(document.querySelector(`.draw-text-bg-row [data-preset="${hex}"]`));

  it('offers presets rather than a colour dialog', () => {
    showDrawPanel({});
    expect(document.querySelectorAll('.draw-text-bg-row .draw-preset').length).toBeGreaterThan(5);
    expect(document.querySelector('.draw-text-bg-row input[type="color"]')).toBeNull();
  });

  it('is off until a preset is picked', () => {
    const panel = showDrawPanel({});
    openBox(panel);
    typeInto(panel.textEditor, 'plain');
    commit(panel);
    expect(panel.state.items[0].background).toBeNull();
  });

  it('fills behind the words with the preset picked', () => {
    const panel = showDrawPanel({});
    openBox(panel);
    pickFill('#fff200');
    typeInto(panel.textEditor, 'over a map');
    commit(panel);
    expect(panel.state.items[0].background).toBe('#fff200');
  });

  // Without a "None" the only way back from a fill applied by mistake is undo.
  it('clears the fill again with None', () => {
    const panel = showDrawPanel({});
    openBox(panel);
    pickFill('#fff200');
    click(document.querySelector('.draw-text-bg-row [data-preset="none"]'));
    typeInto(panel.textEditor, 'plain again');
    commit(panel);
    expect(panel.state.items[0].background).toBeNull();
  });

  it('shows the fill in the editor while typing', () => {
    const panel = showDrawPanel({});
    openBox(panel);
    pickFill('#ffffff');
    expect(panel.textEditor.style.background).toContain('rgb(255, 255, 255)');
  });
});

