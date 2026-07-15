import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildNotePdf, notePdfFilename, verifiedPdfBytes, verifiedPdfFile } from '../src/lib/note-pdf.js';

let originalGetContext;
let originalToDataUrl;

beforeEach(() => {
  originalGetContext = HTMLCanvasElement.prototype.getContext;
  originalToDataUrl = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
    fillStyle: '',
    fillRect: vi.fn(),
    drawImage: vi.fn(),
  }));
  HTMLCanvasElement.prototype.toDataURL = vi.fn(() => 'data:image/png;base64,AAAA');
});

afterEach(() => {
  HTMLCanvasElement.prototype.getContext = originalGetContext;
  HTMLCanvasElement.prototype.toDataURL = originalToDataUrl;
});

function fakePdf() {
  return class {
    constructor() {
      this.internal = { pageSize: { getWidth: () => 595, getHeight: () => 842 } };
      this.addImage = vi.fn();
      this.addPage = vi.fn();
    }
    output() { return new Blob(['pdf'], { type: 'application/pdf' }); }
  };
}

function capturedCanvas(visible = true, width = 100, height = 100) {
  return {
    width,
    height,
    getContext: () => ({
      getImageData: () => ({ data: new Uint8ClampedArray(400).fill(visible ? 0 : 255) }),
    }),
  };
}

describe('note PDF capture', () => {
  it('materializes and validates PDF bytes before system sharing', async () => {
    const source = { arrayBuffer: async () => Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 1, 2, 3]).buffer };
    const bytes = await verifiedPdfBytes(source);
    expect([...bytes.slice(0, 5)]).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d]);
    const file = await verifiedPdfFile(source, 'Checked.pdf');
    expect(file.name).toBe('Checked.pdf');
    expect(file.type).toBe('application/pdf');
    expect(file.size).toBe(8);
  });

  it('rejects an empty or non-PDF payload before opening the share panel', async () => {
    await expect(verifiedPdfBytes({ arrayBuffer: async () => new ArrayBuffer(0) }))
      .rejects.toThrow('valid PDF data');
  });

  it('renders offscreen but above the page background so the capture contains content', async () => {
    const progress = [];
    const rasterize = vi.fn(async (host) => {
      expect(Number(host.style.zIndex)).toBeGreaterThan(0);
      expect(Number.parseInt(host.style.left, 10)).toBeLessThan(0);
      expect(host.textContent).toContain('Visible title');
      return capturedCanvas(true);
    });
    const blob = await buildNotePdf(
      { title: 'Visible title', body: 'Visible body', attachments: [] },
      { rasterize, Pdf: fakePdf(), onProgress: (event) => progress.push(event.percent) },
    );
    expect(blob.type).toBe('application/pdf');
    expect(document.querySelector('.pdf-note')).toBeNull();
    expect(progress[0]).toBe(2);
    expect(progress.at(-1)).toBe(100);
    expect(HTMLCanvasElement.prototype.toDataURL).toHaveBeenCalledWith('image/jpeg', 0.9);
  });

  it('rejects an all-white capture instead of uploading an empty PDF', async () => {
    await expect(buildNotePdf(
      { title: 'Should render', body: 'Body', attachments: [] },
      { rasterize: async () => capturedCanvas(false), Pdf: fakePdf() },
    )).rejects.toThrow(/capture is blank/i);
    expect(document.querySelector('.pdf-note')).toBeNull();
  });

  it('captures long notes in bounded batches instead of one oversized canvas', async () => {
    const rasterize = vi.fn(async (host, capture) => capturedCanvas(true, 1588, capture.height * 2));
    await buildNotePdf(
      { title: 'Long note', body: 'Body', attachments: [] },
      {
        rasterize,
        Pdf: fakePdf(),
        measureHost: () => ({ width: 794, height: 60000 }),
      },
    );
    expect(rasterize.mock.calls.length).toBeGreaterThan(1);
    const heights = rasterize.mock.calls.map((call) => call[1].height);
    expect(Math.max(...heights)).toBeLessThan(5000);
    expect(heights.reduce((sum, height) => sum + height, 0)).toBe(60000);
  });

  it('sanitizes the downloaded PDF filename', () => {
    expect(notePdfFilename('Trip / July')).toBe('Trip - July.pdf');
  });
});
