import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderEditor } from '../src/app/editor.js';
import { installFakeChrome } from './helpers/fake-chrome.js';

beforeEach(() => { installFakeChrome(); document.body.innerHTML = '<div id="root"></div>'; });

function pointer(el, type, x, y) {
  const ev = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(ev, 'pointerId', { value: 1, configurable: true });
  el.dispatchEvent(ev);
}

function click(el) {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

describe('editor drawing button', () => {
  it('shows a Draw button in the action bar', () => {
    renderEditor(document.getElementById('root'), {});
    const btn = document.querySelector('.insert-drawing');
    expect(btn).toBeTruthy();
    expect(btn.textContent).toContain('Draw');
  });

  it('opens the drawing panel when clicked', () => {
    HTMLCanvasElement.prototype.getContext = () => null; // jsdom has no 2D context
    renderEditor(document.getElementById('root'), {});
    click(document.querySelector('.insert-drawing'));
    expect(document.querySelector('.draw-dialog')).toBeTruthy();
  });

  it('inserts the saved drawing as an owl-img reference with its attachment', async () => {
    // jsdom rasterizes nothing: getContext('2d') is null and toBlob does not
    // exist, so drawingToPngBlob would fail at its first line. Stub the canvas
    // surface for this test only — everything above it is the real code path.
    const noop = () => {};
    const realGetContext = HTMLCanvasElement.prototype.getContext;
    const realToBlob = HTMLCanvasElement.prototype.toBlob;
    const realFileReader = globalThis.FileReader;
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    HTMLCanvasElement.prototype.getContext = () => ({
      save: noop, restore: noop, scale: noop, clearRect: noop, beginPath: noop,
      moveTo: noop, lineTo: noop, stroke: noop, arc: noop, fill: noop,
      fillRect: noop, drawImage: noop,
    });
    HTMLCanvasElement.prototype.toBlob = (cb) => cb(new Blob(['png'], { type: 'image/png' }));
    globalThis.FileReader = class { readAsDataURL() { this.result = png; this.onload?.(); } };

    try {
      const onSave = vi.fn();
      renderEditor(document.getElementById('root'), { body: 'notes', onSave });

      click(document.querySelector('.insert-drawing'));
      const canvas = document.querySelector('.draw-canvas');
      pointer(canvas, 'pointerdown', 5, 5);
      pointer(canvas, 'pointermove', 25, 25);
      pointer(canvas, 'pointerup', 25, 25);

      click(document.querySelector('.draw-save'));
      await vi.waitFor(() => expect(document.querySelector('.note-body').value).toMatch(/owl-img:/));

      click(document.querySelector('.save'));
      await vi.waitFor(() => expect(onSave).toHaveBeenCalled());
      const saved = onSave.mock.calls.at(-1)[0];
      expect(saved.body).toMatch(/!\[drawing-\d{8}-\d{6}\.png\]\(owl-img:[A-Za-z0-9]+\)/);
      expect(saved.attachments).toHaveLength(1);
      expect(saved.attachments[0].dataUri).toBe(png);
    } finally {
      HTMLCanvasElement.prototype.getContext = realGetContext;
      HTMLCanvasElement.prototype.toBlob = realToBlob;
      globalThis.FileReader = realFileReader;
    }
  });
});
