import { describe, expect, it, vi } from 'vitest';
import {
  CAPTURE_INTERVAL_MS,
  MAX_OUTPUT_HEIGHT,
  MAX_OUTPUT_PIXELS,
  captureCanvasSize,
  captureFullPage,
  captureOffsets,
  createPageCompositor,
  preparePageForCapture,
  suppressPageSelectionHighlight,
  restorePageAfterCapture,
  scrollPageForCapture,
} from '../src/lib/full-page-capture.js';

describe('full-page capture planning', () => {
  it('covers the page top-to-bottom and anchors the last tile at the bottom', () => {
    expect(captureOffsets(2500, 1000)).toEqual([0, 1000, 1500]);
    expect(captureOffsets(800, 1000)).toEqual([0]);
    expect(captureOffsets(3000, 1000)).toEqual([0, 1000, 2000]);
  });

  it('scales extreme pages within safe canvas dimensions and pixel area', () => {
    const size = captureCanvasSize(
      { viewportWidth: 1200, viewportHeight: 800, documentHeight: 80_000 },
      2400,
      1600,
    );
    expect(size.height).toBeLessThanOrEqual(MAX_OUTPUT_HEIGHT);
    expect(size.width * size.height).toBeLessThanOrEqual(MAX_OUTPUT_PIXELS);
    expect(size.scale).toBeLessThan(1);
  });

  it('detects a large internal app scroller when the document is one viewport tall', () => {
    document.body.innerHTML = '<main id="content" style="overflow-y:auto"></main>';
    const main = document.querySelector('#content');
    Object.defineProperties(main, {
      clientHeight: { configurable: true, value: 620 },
      clientWidth: { configurable: true, value: 900 },
      scrollHeight: { configurable: true, value: 3000 },
      scrollWidth: { configurable: true, value: 900 },
    });
    main.getBoundingClientRect = () => ({ left: 60, top: 80, right: 960, bottom: 700, width: 900, height: 620 });
    const originalElementsFromPoint = document.elementsFromPoint;
    const originalScrollTo = globalThis.scrollTo;
    document.elementsFromPoint = () => [];
    globalThis.scrollTo = vi.fn();
    try {
      const meta = preparePageForCapture();
      expect(meta).toMatchObject({
        scrollTarget: 'element',
        documentHeight: 3000,
        viewportWidth: 900,
        viewportHeight: 620,
        captureLeft: 60,
        captureTop: 80,
      });
      restorePageAfterCapture();
    } finally {
      document.elementsFromPoint = originalElementsFromPoint;
      globalThis.scrollTo = originalScrollTo;
      delete globalThis.__owlNoteFullPageCaptureV1;
      document.body.innerHTML = '';
    }
  });

  it('suppresses the painted selection during capture and restores its ranges afterward', () => {
    document.body.innerHTML = '<p id="selected">Keep this selected</p>';
    const range = document.createRange();
    range.selectNodeContents(document.getElementById('selected'));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const originalElementsFromPoint = document.elementsFromPoint;
    const originalScrollTo = globalThis.scrollTo;
    document.elementsFromPoint = () => [];
    globalThis.scrollTo = vi.fn();

    try {
      preparePageForCapture();
      expect(suppressPageSelectionHighlight()).toBe(1);
      expect(selection.rangeCount).toBe(0);

      restorePageAfterCapture();
      expect(selection.rangeCount).toBe(1);
      expect(selection.toString()).toBe('Keep this selected');
    } finally {
      selection.removeAllRanges();
      document.elementsFromPoint = originalElementsFromPoint;
      globalThis.scrollTo = originalScrollTo;
      delete globalThis.__owlNoteFullPageCaptureV1;
      document.body.innerHTML = '';
    }
  });

  it('crops browser screenshots to an internal scroll container before stitching', async () => {
    const drawImage = vi.fn();
    class FakeCanvas {
      constructor(width, height) {
        this.width = width;
        this.height = height;
        FakeCanvas.instance = this;
      }
      getContext() { return { fillStyle: '', fillRect: vi.fn(), drawImage }; }
    }
    const bitmap = { width: 2000, height: 1200, close: vi.fn() };
    await createPageCompositor(
      {
        documentHeight: 1500,
        viewportWidth: 800,
        viewportHeight: 500,
        browserViewportWidth: 1000,
        browserViewportHeight: 600,
        captureLeft: 100,
        captureTop: 50,
        captureWidth: 800,
      },
      'tile',
      { x: 0, y: 0 },
      { decode: async () => bitmap, OffscreenCanvas: FakeCanvas },
    );

    expect(FakeCanvas.instance.width).toBe(1600);
    expect(FakeCanvas.instance.height).toBe(3000);
    expect(drawImage).toHaveBeenCalledWith(bitmap, 200, 100, 1600, 1000, 0, 0, 1600, 1000);
    expect(bitmap.close).toHaveBeenCalled();
  });

  it('scrolls the detected app container instead of window', async () => {
    const target = { isConnected: true, scrollLeft: 0, scrollTop: 0 };
    const originalRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (callback) => callback();
    globalThis.__owlNoteFullPageCaptureV1 = {
      fixed: [],
      nestedScroller: true,
      scrollTarget: target,
    };
    try {
      const position = await scrollPageForCapture(0, 840, false);
      expect(position).toEqual({ x: 0, y: 840 });
      expect(target.scrollTop).toBe(840);
    } finally {
      globalThis.requestAnimationFrame = originalRaf;
      delete globalThis.__owlNoteFullPageCaptureV1;
    }
  });
});

describe('full-page capture orchestration', () => {
  it('scrolls, paces browser captures, stitches each tile, and restores the page', async () => {
    const calls = [];
    let now = 1000;
    const added = [];
    const compositor = {
      add: vi.fn(async (dataUrl, position) => added.push([dataUrl, position])),
      finish: vi.fn(async () => ({ dataUri: 'data:image/jpeg;base64,AQID', mime: 'image/jpeg', width: 1200, height: 2500 })),
    };
    const executeScript = vi.fn(async (options) => {
      calls.push(options);
      if (options.func === preparePageForCapture) {
        return [{ result: { documentWidth: 1200, documentHeight: 2500, viewportWidth: 1200, viewportHeight: 1000 } }];
      }
      if (options.func === scrollPageForCapture) return [{ result: { x: 0, y: options.args[1] } }];
      if (options.func === restorePageAfterCapture) return [{ result: undefined }];
      throw new Error('unexpected injection');
    });
    const captureVisibleTab = vi.fn(async () => `data:image/jpeg;base64,tile${captureVisibleTab.mock.calls.length}`);
    const sleep = vi.fn(async (ms) => { now += ms; });
    const createCompositor = vi.fn(async () => compositor);
    const onProgress = vi.fn();
    const inspectPage = () => {};
    executeScript.mockImplementation(async (options) => {
      calls.push(options);
      if (options.func === preparePageForCapture) {
        return [{ result: { documentWidth: 1200, documentHeight: 2500, viewportWidth: 1200, viewportHeight: 1000 } }];
      }
      if (options.func === inspectPage) return [{ result: { markdown: 'Smart content' } }];
      if (options.func === scrollPageForCapture) return [{ result: { x: 0, y: options.args[1] } }];
      if (options.func === restorePageAfterCapture) return [{ result: undefined }];
      throw new Error('unexpected injection');
    });

    const result = await captureFullPage(
      { id: 9, windowId: 4 },
      {
        executeScript,
        captureVisibleTab,
        queryTabs: async () => [{ id: 9 }],
        createCompositor,
        sleep,
        clock: () => now,
        onProgress,
        inspectPage,
        inspectArgs: [true],
      },
    );

    expect(captureVisibleTab).toHaveBeenCalledTimes(3);
    expect(captureVisibleTab).toHaveBeenNthCalledWith(1, 4, { format: 'jpeg', quality: 86 });
    expect(createCompositor).toHaveBeenCalledWith(
      expect.objectContaining({ documentHeight: 2500 }),
      'data:image/jpeg;base64,tile1',
      { x: 0, y: 0 },
    );
    expect(added.map((entry) => entry[1].y)).toEqual([1000, 1500]);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(CAPTURE_INTERVAL_MS);
    expect(onProgress).toHaveBeenLastCalledWith({ completed: 3, total: 3 });
    expect(calls.at(-1).func).toBe(restorePageAfterCapture);
    expect(result).toMatchObject({ dataUri: 'data:image/jpeg;base64,AQID', tiles: 3 });
    expect(result.inspection).toEqual({ markdown: 'Smart content' });
    expect(result.captureMeta).toEqual({ documentHeight: 2500, captureWidth: 1200 });
    expect(calls[1]).toMatchObject({ func: inspectPage, args: [true] });
  });

  it('restores the page when the user activates another tab during capture', async () => {
    const injected = [];
    const executeScript = async (options) => {
      injected.push(options.func);
      if (options.func === preparePageForCapture) {
        return [{ result: { documentWidth: 1000, documentHeight: 2000, viewportWidth: 1000, viewportHeight: 1000 } }];
      }
      if (options.func === scrollPageForCapture) return [{ result: { x: 0, y: options.args[1] } }];
      return [{ result: undefined }];
    };

    await expect(captureFullPage(
      { id: 9, windowId: 4 },
      { executeScript, captureVisibleTab: vi.fn(), queryTabs: async () => [{ id: 10 }] },
    )).rejects.toThrow('Keep this page active');
    expect(injected.at(-1)).toBe(restorePageAfterCapture);
  });
});
