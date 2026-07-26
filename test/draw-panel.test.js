import { describe, it, expect, beforeEach, vi } from 'vitest';
import { showDrawPanel } from '../src/app/draw-panel.js';

beforeEach(() => {
  document.body.innerHTML = '';
  // jsdom has no 2D context and logs a "Not implemented" trace for every call.
  // Returning null is exactly what it does after that log, so the panel takes
  // its real no-context path — this only silences the noise.
  HTMLCanvasElement.prototype.getContext = () => null;
});

// jsdom has no PointerEvent; a MouseEvent carries every field the panel reads.
function pointer(el, type, x, y) {
  const ev = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(ev, 'pointerId', { value: 1, configurable: true });
  el.dispatchEvent(ev);
  return ev;
}

function click(el) {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function draw(canvas, points) {
  pointer(canvas, 'pointerdown', points[0][0], points[0][1]);
  for (const [x, y] of points.slice(1)) pointer(canvas, 'pointermove', x, y);
  const last = points[points.length - 1];
  pointer(canvas, 'pointerup', last[0], last[1]);
}

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

  it('selects tools, colors, and widths', () => {
    showDrawPanel({});
    const eraser = document.querySelector('.draw-tool-erase');
    click(eraser);
    expect(eraser.classList.contains('active')).toBe(true);
    expect(document.querySelector('.draw-tool-pen').classList.contains('active')).toBe(false);

    const red = document.querySelector('.draw-color[data-color="#d93025"]');
    click(red);
    expect(red.classList.contains('active')).toBe(true);

    const thick = document.querySelector('.draw-width[data-width="8"]');
    click(thick);
    expect(thick.classList.contains('active')).toBe(true);
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
