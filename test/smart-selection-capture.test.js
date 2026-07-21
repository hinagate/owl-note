import { describe, it, expect, vi } from 'vitest';
import { captureSmartSelection } from '../src/lib/smart-selection-capture.js';

describe('smart selection capture', () => {
  it('keeps text-only selections fast without taking a page screenshot', async () => {
    const selected = { title: 'Selected text', markdown: 'A **formatted** selection.', images: [] };
    const executeScript = vi.fn(async () => [{ result: selected }]);
    const captureFullPage = vi.fn();

    const result = await captureSmartSelection(
      { frameId: 0 },
      { id: 12, windowId: 3 },
      { executeScript, captureFullPage },
    );

    expect(result).toMatchObject({ title: selected.title, markdown: selected.markdown, attachments: [], totalImages: 0 });
    expect(executeScript).toHaveBeenCalledWith(expect.objectContaining({
      target: { tabId: 12, frameIds: [0] },
      args: ['smart-selection'],
    }));
    expect(captureFullPage).not.toHaveBeenCalled();
  });

  it('copies selected rendered objects into owl-img attachments', async () => {
    const selected = {
      title: 'Selected chart',
      markdown: 'Before\n\n![Chart](owl-smart-img:0)\n\nAfter',
      images: [{ index: 0, src: 'https://images.example/chart.png', alt: 'Chart', x: 20, y: 300, width: 500, height: 260 }],
    };
    const executeScript = vi.fn(async () => [{ result: selected }]);
    const captureFullPage = vi.fn(async (_tab, options) => ({
      dataUri: 'data:image/jpeg;base64,full',
      captureMeta: { documentHeight: 1500, captureWidth: 900 },
      inspection: selected,
      options,
    }));
    const attachment = {
      index: 0, id: 'selected1', name: 'Chart.jpg', mime: 'image/jpeg',
      dataUri: 'data:image/jpeg;base64,crop', width: 500, height: 260,
    };
    const cropImages = vi.fn(async () => [attachment]);

    const result = await captureSmartSelection(
      {},
      { id: 13, windowId: 3 },
      { executeScript, captureFullPage, cropImages },
    );

    expect(result.markdown).toContain('![Chart](owl-img:selected1)');
    expect(result.attachments).toEqual([attachment]);
    expect(result).toMatchObject({ totalImages: 1, copiedImages: 1, missedImages: 0 });
    expect(captureFullPage.mock.calls[0][1]).toMatchObject({
      inspectArgs: ['smart-selection'],
      suppressSelectionHighlight: true,
    });
    expect(cropImages).toHaveBeenCalledWith(expect.objectContaining({ inspection: selected }), selected.images);
  });

  it('does not crop child-frame coordinates against the top-page screenshot', async () => {
    const selected = {
      title: 'Frame selection',
      markdown: '![Diagram](owl-smart-img:0)',
      images: [{ index: 0, src: 'https://frame.example/diagram.png', alt: 'Diagram', x: 5, y: 10, width: 300, height: 200 }],
    };
    const executeScript = vi.fn(async () => [{ result: selected }]);
    const captureFullPage = vi.fn();

    const result = await captureSmartSelection(
      { frameId: 7 },
      { id: 14, windowId: 3 },
      { executeScript, captureFullPage },
    );

    expect(result.markdown).toContain('[Image: Diagram](<https://frame.example/diagram.png>)');
    expect(result.markdown).toContain('could not copy 1 image');
    expect(captureFullPage).not.toHaveBeenCalled();
  });
});
