import html2canvas from 'html2canvas';
import { jsPDF } from 'jspdf';
import { renderMarkdown } from './markdown.js';
import { inlineImagesAsync, linkifyFileRefs } from './note-images.js';
import { getBytes } from './attachment-store.js';

function safeFilename(value) {
  const cleaned = String(value || 'Untitled note')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/[\u0000-\u001f]/g, '')
    .trim()
    .replace(/[. ]+$/, '');
  return `${cleaned || 'Untitled note'}.pdf`;
}

async function waitForImages(root) {
  await Promise.all([...root.querySelectorAll('img')].map(async (img) => {
    if (img.complete) {
      try { await img.decode?.(); } catch { /* html2canvas will render the fallback */ }
      return;
    }
    await new Promise((resolve) => {
      img.addEventListener('load', resolve, { once: true });
      img.addEventListener('error', resolve, { once: true });
    });
  }));
}

function makePdfPage(canvas, startY, height) {
  const page = document.createElement('canvas');
  page.width = canvas.width;
  page.height = height;
  const context = page.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, page.width, page.height);
  context.drawImage(canvas, 0, startY, canvas.width, height, 0, 0, canvas.width, height);
  return page;
}

function canvasHasVisibleContent(canvas) {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context || canvas.width < 1 || canvas.height < 1) return false;
  // The title is always near the top, so inspecting the first 2,048 rows avoids a
  // second full-size allocation for very long notes while still detecting a failed,
  // all-white html2canvas capture reliably.
  const height = Math.min(canvas.height, 2048);
  const pixels = context.getImageData(0, 0, canvas.width, height).data;
  for (let i = 0; i < pixels.length; i += 16) {
    if (pixels[i] < 245 || pixels[i + 1] < 245 || pixels[i + 2] < 245) return true;
  }
  return false;
}

export function notePdfFilename(title) {
  return safeFilename(title);
}

export async function verifiedPdfBytes(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const hasPdfHeader = bytes.length >= 5
    && bytes[0] === 0x25 // %
    && bytes[1] === 0x50 // P
    && bytes[2] === 0x44 // D
    && bytes[3] === 0x46 // F
    && bytes[4] === 0x2d; // -
  if (!hasPdfHeader) throw new Error('Generated PDF has no valid PDF data');
  return bytes;
}

// Materialize the generated Blob into an owned byte buffer before invoking the
// operating-system share sheet. This validates the browser hand-off payload and
// rules out an OWL-Note-side zero-byte or non-PDF attachment.
export async function verifiedPdfFile(blob, filename, FileCtor = File) {
  const bytes = await verifiedPdfBytes(blob);
  const file = new FileCtor([bytes.slice()], filename, { type: 'application/pdf' });
  if (file.size !== bytes.byteLength) throw new Error('Generated PDF file is incomplete');
  return file;
}

// Rasterizing the rendered preview keeps photos, tables and Markdown styling together.
// Each tall canvas slice becomes one A4 page, avoiding the huge single-image PDF pattern.
export async function buildNotePdf(note, options = {}) {
  const rasterize = options.rasterize || html2canvas;
  const Pdf = options.Pdf || jsPDF;
  const resolveAttachment = options.resolveAttachment || getBytes;
  const report = options.onProgress || (() => {});
  report({ percent: 2, phase: 'preparing' });
  const body = await inlineImagesAsync(note.body || '', note.attachments || [], resolveAttachment);
  report({ percent: 6, phase: 'preparing' });

  const host = document.createElement('article');
  host.className = 'pdf-note';
  host.style.cssText = [
    'position:fixed', 'left:-10000px', 'top:0', 'width:794px', 'padding:64px', 'box-sizing:border-box',
    'background:#fff', 'color:#1d2125', 'font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
    // Keep it outside the visible viewport, but NOT behind the document background:
    // a negative z-index makes html2canvas capture a correctly-sized white rectangle.
    'overflow-wrap:anywhere', 'pointer-events:none', 'z-index:2147483647',
  ].join(';');
  const title = document.createElement('h1');
  title.textContent = note.title || 'Untitled note';
  title.style.cssText = 'font-size:28px;line-height:1.25;margin:0 0 24px';
  const content = document.createElement('div');
  content.innerHTML = renderMarkdown(linkifyFileRefs(body));
  for (const img of content.querySelectorAll('img')) img.style.cssText += ';max-width:100%;height:auto';
  for (const pre of content.querySelectorAll('pre')) pre.style.cssText += ';white-space:pre-wrap;overflow-wrap:anywhere';
  host.append(title, content);
  document.body.appendChild(host);

  try {
    await document.fonts?.ready;
    await waitForImages(host);
    const pdf = new Pdf({ orientation: 'portrait', unit: 'pt', format: 'a4', compress: true });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const measured = options.measureHost
      ? options.measureHost(host)
      : { width: host.getBoundingClientRect().width, height: Math.max(host.scrollHeight, host.getBoundingClientRect().height) };
    const hostWidth = Math.max(1, Math.ceil(measured.width || 794));
    const totalHeight = Math.max(1, Math.ceil(measured.height || 1));
    const cssPageHeight = Math.max(1, Math.floor(hostWidth * pageHeight / pageWidth));
    const totalPages = Math.max(1, Math.ceil(totalHeight / cssPageHeight));
    report({ percent: 10, phase: 'rendering', page: 0, totalPages });
    // Never ask Chromium for one canvas as tall as the whole note. Long notes can
    // exceed the browser's maximum canvas dimension and silently render as white.
    // Four A4 pages per capture stays comfortably below that limit at scale 2,
    // while avoiding one expensive DOM clone for every individual page.
    const captureHeight = cssPageHeight * 4;
    let pageIndex = 0;
    for (let captureY = 0; captureY < totalHeight; captureY += captureHeight) {
      const height = Math.min(captureHeight, totalHeight - captureY);
      const canvas = await rasterize(host, {
        scale: 2,
        useCORS: true,
        backgroundColor: '#ffffff',
        logging: false,
        y: captureY,
        height,
      });
      if (captureY === 0 && !canvasHasVisibleContent(canvas)) throw new Error('PDF capture is blank');
      const pagePixels = Math.max(1, Math.floor(canvas.width * pageHeight / pageWidth));
      for (let y = 0; y < canvas.height; y += pagePixels) {
        const sliceHeight = Math.min(pagePixels, canvas.height - y);
        if (pageIndex > 0) pdf.addPage();
        const slice = makePdfPage(canvas, y, sliceHeight);
        // A full-page PNG for every page makes long notes enormous and can leave
        // the Windows share sheet busy while the browser stages the file. At the
        // 2x capture resolution, high-quality JPEG remains crisp for text/photos
        // while dramatically reducing encoding time and hand-off size.
        pdf.addImage(slice.toDataURL('image/jpeg', 0.9), 'JPEG', 0, 0, pageWidth, pageWidth * sliceHeight / canvas.width, undefined, 'FAST');
        pageIndex += 1;
        report({
          percent: Math.min(98, 10 + Math.round((pageIndex / totalPages) * 88)),
          phase: 'rendering',
          page: Math.min(pageIndex, totalPages),
          totalPages,
        });
      }
    }
    const blob = pdf.output('blob');
    report({ percent: 100, phase: 'complete', page: totalPages, totalPages });
    return blob;
  } finally {
    host.remove();
  }
}
