import { describe, it, expect, vi } from 'vitest';
import {
  assembleSmartPage,
  captureSmartPage,
  cropSmartPageImages,
} from '../src/lib/smart-page-capture.js';

describe('smart page capture', () => {
  it('keeps text-only conversion fast without taking a full-page screenshot', async () => {
    const documentCapture = {
      title: 'Text chat',
      markdown: '## You\n\nQuestion\n\n## ChatGPT\n\nAnswer',
      images: [],
    };
    const executeScript = vi.fn(async () => [{ result: documentCapture }]);
    const takeFullPage = vi.fn();

    const result = await captureSmartPage(
      { id: 7, windowId: 2 },
      { executeScript, captureFullPage: takeFullPage },
    );

    expect(result).toMatchObject({ title: 'Text chat', markdown: documentCapture.markdown, attachments: [], totalImages: 0 });
    expect(executeScript).toHaveBeenCalledWith(expect.objectContaining({ target: { tabId: 7 }, args: [true] }));
    expect(takeFullPage).not.toHaveBeenCalled();
  });

  it('replaces page-image placeholders with copied owl-img attachments', async () => {
    const initial = {
      title: 'Image chat',
      markdown: 'Before\n\n![Diagram](owl-smart-img:0)\n\nAfter',
      images: [{ index: 0, src: 'https://images.example/diagram.png', alt: 'Diagram', x: 10, y: 20, width: 300, height: 200 }],
    };
    const executeScript = vi.fn(async () => [{ result: initial }]);
    const captureFullPage = vi.fn(async (_tab, options) => ({
      dataUri: 'data:image/jpeg;base64,full',
      captureMeta: { documentHeight: 1000, captureWidth: 800 },
      inspection: initial,
      inspectOptions: options,
    }));
    const copied = {
      index: 0, id: 'abc123', name: 'Diagram.jpg', mime: 'image/jpeg',
      dataUri: 'data:image/jpeg;base64,crop', width: 300, height: 200,
    };
    const cropImages = vi.fn(async () => [copied]);

    const result = await captureSmartPage(
      { id: 8, windowId: 3 },
      { executeScript, captureFullPage, cropImages, onProgress: vi.fn() },
    );

    expect(result.markdown).toContain('![Diagram](owl-img:abc123)');
    expect(result.attachments).toEqual([copied]);
    expect(result).toMatchObject({ totalImages: 1, copiedImages: 1, missedImages: 0 });
    expect(captureFullPage.mock.calls[0][1]).toMatchObject({ inspectArgs: [true] });
    expect(cropImages).toHaveBeenCalledWith(expect.objectContaining({ inspection: initial }), initial.images);
  });

  it('preserves safe source URLs and reports images that could not be copied', () => {
    const result = assembleSmartPage({
      markdown: '![Remote](owl-smart-img:0)\n\n![Blob](owl-smart-img:1)',
      images: [
        { index: 0, src: 'https://images.example/remote.png', alt: 'Remote' },
        { index: 1, src: 'blob:https://chat.example/private', alt: 'Blob' },
      ],
    });
    expect(result.markdown).toContain('[Image: Remote](<https://images.example/remote.png>)');
    expect(result.markdown).toContain('*Image could not be copied: Blob*');
    expect(result.markdown).toContain('could not copy 2 images');
  });
});

describe('smart page image cropping', () => {
  it('maps CSS page rectangles onto the scaled stitched bitmap', async () => {
    const draws = [];
    class FakeCanvas {
      constructor(width, height) { this.width = width; this.height = height; }
      getContext() {
        return {
          fillStyle: '',
          fillRect: vi.fn(),
          drawImage: (...args) => draws.push(args),
        };
      }
      async convertToBlob() {
        return { type: 'image/jpeg', arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer };
      }
    }
    const bitmap = { width: 500, height: 1000, close: vi.fn() };
    const result = await cropSmartPageImages(
      {
        dataUri: 'data:image/jpeg;base64,full',
        captureMeta: { captureWidth: 1000, documentHeight: 2000 },
      },
      [{ index: 0, alt: 'Latency chart', x: 100, y: 400, width: 600, height: 300 }],
      { decode: async () => bitmap, OffscreenCanvas: FakeCanvas },
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ index: 0, name: 'Latency chart.jpg', mime: 'image/jpeg', width: 300, height: 150 });
    expect(result[0].dataUri).toMatch(/^data:image\/jpeg;base64,/);
    expect(draws[0].slice(1)).toEqual([50, 200, 300, 150, 0, 0, 300, 150]);
    expect(bitmap.close).toHaveBeenCalledOnce();
  });
});
