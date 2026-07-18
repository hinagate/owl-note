import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildNotePdf, notePdfFilename, verifiedPdfBytes, verifiedPdfFile } from '../src/lib/note-pdf.js';
import { createRasterPdf } from '../src/lib/raster-pdf.js';

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
  HTMLCanvasElement.prototype.toDataURL = vi.fn(() => 'data:image/jpeg;base64,/9j/2Q==');
});

afterEach(() => {
  HTMLCanvasElement.prototype.getContext = originalGetContext;
  HTMLCanvasElement.prototype.toDataURL = originalToDataUrl;
});

function capturedCanvas(visible = true, width = 100, height = 100) {
  return {
    width,
    height,
    getContext: () => ({
      getImageData: () => ({ data: new Uint8ClampedArray(400).fill(visible ? 0 : 255) }),
    }),
  };
}

function readBlob(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
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
      { rasterize, onProgress: (event) => progress.push(event.percent) },
    );
    expect(blob.type).toBe('application/pdf');
    const buffer = await readBlob(blob);
    await expect(verifiedPdfBytes({ arrayBuffer: async () => buffer })).resolves.toHaveLength(blob.size);
    expect(document.querySelector('.pdf-note')).toBeNull();
    expect(progress[0]).toBe(2);
    expect(progress.at(-1)).toBe(100);
    expect(HTMLCanvasElement.prototype.toDataURL).toHaveBeenCalledWith('image/jpeg', 0.9);
  });

  it('rejects an all-white capture instead of uploading an empty PDF', async () => {
    await expect(buildNotePdf(
      { title: 'Should render', body: 'Body', attachments: [] },
      { rasterize: async () => capturedCanvas(false) },
    )).rejects.toThrow(/capture is blank/i);
    expect(document.querySelector('.pdf-note')).toBeNull();
  });

  it('captures long notes in bounded batches instead of one oversized canvas', async () => {
    const rasterize = vi.fn(async (host, capture) => capturedCanvas(true, 1588, capture.height * 2));
    await buildNotePdf(
      { title: 'Long note', body: 'Body', attachments: [] },
      {
        rasterize,
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

  it('writes a self-contained multipage PDF with local JPEG objects', async () => {
    const jpeg = 'data:image/jpeg;base64,/9j/2Q==';
    const blob = createRasterPdf([
      { dataUrl: jpeg, pixelWidth: 100, pixelHeight: 200 },
      { dataUrl: jpeg, pixelWidth: 100, pixelHeight: 50 },
    ]);
    const text = new TextDecoder('latin1').decode(await readBlob(blob));
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text).toContain('/Count 2');
    expect(text.match(/\/Filter \/DCTDecode/g)).toHaveLength(2);
    expect(text).toContain('startxref');
    expect(text.endsWith('%%EOF\n')).toBe(true);
  });
});
